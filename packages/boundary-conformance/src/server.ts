/**
 * The harness's server: a real local HTTP server that serves a build's
 * files and answers the conformance routes (`ROUTES` in `protocol.ts`):
 * the fixtures' backend, the hydration gate the harness holds, and the
 * ingest a build uploads to: the recorder configuration, always
 * `{"enabled": true}`, and the batch endpoint, which keeps every body in
 * arrival order for the `envelope` check.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

import { BatchFormatError, parseBatch } from "@codetracer/boundary-format";

import { ITEMS, ROUTES } from "./protocol.js";

export interface HarnessServer {
  /** `http://127.0.0.1:<port>`. */
  origin: string;
  /** Every batch body received, in arrival order. */
  batches: Uint8Array[];
  /** Resolves once the page has asked for the hydration gate. */
  gateRequested: Promise<void>;
  /** Answer the hydration gate (and every later request for it). */
  releaseGate(): void;
  /** Resolves once a batch whose envelope says `final: true` has arrived. */
  finalBatch: Promise<void>;
  close(): Promise<void>;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
};

/**
 * A loopback listener held open across several harness servers, one after
 * another, so that they all serve one origin.
 *
 * The non-interference leg records two sessions of a fixture and compares
 * them record for record (§11.3.6), so both must run at the same origin:
 * the page's URL, and every URL it builds from it, are in the log. The
 * listener binds port 0 once and stays bound until `close`, and each
 * session's server takes it over in turn (`startHarnessServer` with
 * `listener`). Choosing a port by binding and releasing a probe socket and
 * binding it again for each session instead is a race: between the release
 * and each bind, any other process on the host (the parallel suite's other
 * servers, any process's port-0 listener) can be given that port, and the
 * session's server then fails with EADDRINUSE. Holding the socket leaves no
 * moment at which the port is free.
 */
export interface HarnessListener {
  /** `http://127.0.0.1:<port>`, the same for every server it carries. */
  origin: string;
  /** Close the listener. Any server it carries stops answering. */
  close(): Promise<void>;
}

/** The internals a server attaches to: not part of the exported shape. */
interface HeldListener extends HarnessListener {
  /** The current server's request handler, or none between servers. */
  attach(handler: http.RequestListener | undefined): void;
  /** Close every connection open on the listener (between servers). */
  dropConnections(): void;
}

const held = new WeakMap<HarnessListener, HeldListener>();

/** Bind a loopback listener on a port the kernel picks, and hold it. */
export async function openHarnessListener(): Promise<HarnessListener> {
  let current: http.RequestListener | undefined;
  const server = http.createServer((req, res) => {
    if (current === undefined) {
      // Between two sessions: nothing of this origin is being served.
      res.writeHead(503, { "cache-control": "no-store" });
      res.end();
      return;
    }
    current(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as { port: number }).port;
  const listener: HeldListener = {
    origin: `http://127.0.0.1:${port}`,
    attach(handler) {
      current = handler;
    },
    dropConnections() {
      server.closeAllConnections();
    },
    close: () =>
      new Promise<void>((resolve) => {
        current = undefined;
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  held.set(listener, listener);
  return listener;
}

/** Where the harness server listens. */
export interface HarnessServerOptions {
  /**
   * A listener from `openHarnessListener` to serve on, so this server
   * answers at the same origin as the others it carries; its `close` then
   * detaches from the listener without closing it. Default: a listener of
   * its own on a port the kernel picks, closed with the server.
   */
  listener?: HarnessListener;
}

/** Start a server for the build in `root` on a loopback port. */
export async function startHarnessServer(
  root: string,
  options: HarnessServerOptions = {},
): Promise<HarnessServer> {
  const base = path.resolve(root);
  const batches: Uint8Array[] = [];
  let gateOpen = false;
  const heldGates: http.ServerResponse[] = [];
  let onGate!: () => void;
  const gateRequested = new Promise<void>((r) => (onGate = r));
  let onFinal!: () => void;
  const finalBatch = new Promise<void>((r) => (onFinal = r));

  const answerGate = (res: http.ServerResponse) => {
    res.writeHead(200, {
      "content-type": "text/plain",
      "cache-control": "no-store",
    });
    res.end("ok");
  };

  const handler: http.RequestListener = (req, res) => {
    // No `Date` header: what the page reads of a response is the same in
    // every session, so two recordings differ only where the page made
    // them differ (the non-interference leg compares them, §11.3.6).
    res.sendDate = false;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const pathname = new URL(req.url ?? "/", "http://x").pathname;
      if (pathname === ROUTES.batches && req.method === "POST") {
        const bytes = new Uint8Array(body);
        batches.push(bytes);
        try {
          if (parseBatch(bytes).envelope.final) onFinal();
        } catch (e) {
          // A malformed batch is still kept: the envelope check reports it.
          if (!(e instanceof BatchFormatError)) throw e;
        }
        res.writeHead(202);
        res.end();
        return;
      }
      if (pathname === ROUTES.config && req.method === "GET") {
        res.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        res.end(JSON.stringify({ enabled: true }));
        return;
      }
      if (pathname === ROUTES.items && req.method === "GET") {
        res.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        res.end(JSON.stringify(ITEMS));
        return;
      }
      if (pathname === ROUTES.login && req.method === "POST") {
        let user: unknown;
        try {
          user = (JSON.parse(body.toString("utf-8")) as { user?: unknown })
            .user;
        } catch {
          user = undefined;
        }
        if (typeof user !== "string") {
          res.writeHead(400);
          res.end();
          return;
        }
        res.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        res.end(JSON.stringify({ ok: true, user }));
        return;
      }
      if (pathname === ROUTES.hydrateGate && req.method === "GET") {
        onGate();
        if (gateOpen) answerGate(res);
        else heldGates.push(res);
        return;
      }
      if (req.method !== "GET") {
        res.writeHead(405);
        res.end();
        return;
      }
      let rel: string;
      try {
        rel = decodeURIComponent(pathname);
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }
      const file = path.resolve(base, "." + path.posix.normalize(rel));
      if (
        !file.startsWith(base + path.sep) ||
        !fs.existsSync(file) ||
        !fs.statSync(file).isFile()
      ) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        "content-type":
          TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      res.end(fs.readFileSync(file));
    });
  };
  const own = options.listener === undefined;
  const listener = held.get(options.listener ?? (await openHarnessListener()));
  if (listener === undefined) {
    throw new Error("the listener was not opened by openHarnessListener");
  }
  listener.attach(handler);
  return {
    origin: listener.origin,
    batches,
    gateRequested,
    releaseGate() {
      gateOpen = true;
      for (const res of heldGates.splice(0)) answerGate(res);
    },
    finalBatch,
    close: async () => {
      if (own) {
        await listener.close();
        return;
      }
      // The listener stays bound for the next server; this one's
      // connections end with it, so none of them reaches the next.
      listener.attach(undefined);
      listener.dropConnections();
    },
  };
}

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

/** Where the harness server listens. */
export interface HarnessServerOptions {
  /**
   * The loopback port (default: a free one). The non-interference leg
   * records its two sessions at one origin, so their URLs are the same.
   */
  port?: number;
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

  const server = http.createServer((req, res) => {
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
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as { port: number }).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    batches,
    gateRequested,
    releaseGate() {
      gateOpen = true;
      for (const res of heldGates.splice(0)) answerGate(res);
    },
    finalBatch,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

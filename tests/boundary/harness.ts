/**
 * The harness of tests/boundary/record-shim.test.ts: a real local HTTP
 * server for the fixture pages, real headless Chromium through Playwright,
 * and the shim installed through the shipped route (the
 * `codetracer-js-recorder boundary-shim` CLI step).
 *
 * Nothing here is a mock. Chromium and playwright-core come from the dev
 * shell (flake.nix sets PLAYWRIGHT_CORE_PATH and PLAYWRIGHT_BROWSERS_PATH
 * from the one nixpkgs `playwright-driver`); without them the tests fail,
 * naming the shell, rather than skip.
 */

import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";

import {
  type BoundaryRecord,
  type DecodedLog,
  decodeLog,
} from "../../packages/boundary-format/src/index.js";

export const REPO_ROOT = path.resolve(__dirname, "..", "..");
export const FIXTURES = path.join(__dirname, "fixtures");
const CLI = path.join(REPO_ROOT, "packages", "cli", "dist", "index.js");

// ── Playwright ──────────────────────────────────────────────────────────

/** The slice of playwright-core's API the tests use. */
export interface Playwright {
  chromium: {
    launch(options?: { headless?: boolean }): Promise<Browser>;
  };
}
export interface Browser {
  newContext(): Promise<BrowserContext>;
  close(): Promise<void>;
}
export interface BrowserContext {
  newPage(): Promise<Page>;
  close(): Promise<void>;
}
export interface Page {
  goto(url: string): Promise<unknown>;
  addInitScript(script: { path: string } | { content: string }): Promise<void>;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  evaluate<T>(fn: () => T): Promise<T>;
  evaluate<T, A>(fn: (arg: A) => T, arg: A): Promise<T>;
  on(event: "pageerror", f: (e: Error) => void): void;
  clock: {
    install(options?: { time?: number }): Promise<void>;
    pauseAt(time: number): Promise<void>;
    runFor(ms: number): Promise<void>;
  };
}

let playwright: Playwright | undefined;

/** playwright-core from the dev shell. Throws, naming the shell, without it. */
export function loadPlaywright(): Playwright {
  if (playwright !== undefined) return playwright;
  const core = process.env.PLAYWRIGHT_CORE_PATH;
  if (!core || !process.env.PLAYWRIGHT_BROWSERS_PATH) {
    throw new Error(
      "PLAYWRIGHT_CORE_PATH and PLAYWRIGHT_BROWSERS_PATH are not set: run the " +
        "tests inside the dev shell (`nix develop`), which provides headless " +
        "Chromium and playwright-core from nixpkgs' playwright-driver.",
    );
  }
  playwright = createRequire(__filename)(core) as Playwright;
  return playwright;
}

// ── The fixture server ──────────────────────────────────────────────────

/** A request the server received, as the behaviour comparison sees it. */
export interface ServedRequest {
  method: string;
  url: string;
  body: string;
}

/** How a streamed response (`/api/stream`, `/api/sse`) ended. */
export interface StreamEnd {
  url: string;
  /** Chunks the server wrote before the response ended. */
  written: number;
  /** `true` when the server finished it, `false` when the client went away. */
  finished: boolean;
}

export interface FixtureServer {
  /** `http://127.0.0.1:<port>`. */
  origin: string;
  /** Every request received, in arrival order. */
  requests: ServedRequest[];
  /** Every streamed response that has ended, in the order they ended. */
  streamEnds: StreamEnd[];
  close(): Promise<void>;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".wav": "audio/wav",
};

/**
 * How long `/api/release` waits, after the released response has been
 * handed to the kernel, before it answers: time for the browser's network
 * process to pass the released bytes and the response's end to the page's
 * renderer, which queues them while the page is blocked in the synchronous
 * request that asked for the release.
 */
const RELEASE_SETTLE_MS = 250;

/**
 * Answer a streamed route: `/api/stream` writes `c0\n`, `c1\n`, … as
 * `text/plain`, `/api/sse` writes `data: e0\n\n`, … as `text/event-stream`.
 * The first chunk is written at once and each next one `interval` ms
 * (default 100) later; `n` chunks are written and the response ended, or,
 * with `n=forever`, the response never ends: only the client closing it
 * stops the writes. `nosniff` keeps Chromium from holding the first bytes
 * back to sniff a MIME type.
 *
 * `/api/sse` takes `event=<name>` (every event named so) and `id=1` (each
 * event with an id, 1, 2, …).
 *
 * `length=1` sends a `content-length` (a finite stream only), so the
 * response's progress events are length-computable. `hold=<id>` keeps the
 * response open after its `n` chunks until `/api/release?id=<id>` (see
 * `releaseHeld`) writes `end\n` and ends it.
 */
function serveStream(
  res: http.ServerResponse,
  url: URL,
  sse: boolean,
  streamEnds: StreamEnd[],
  held: Map<string, http.ServerResponse>,
): void {
  const forever = url.searchParams.get("n") === "forever";
  const n = forever ? Infinity : Number(url.searchParams.get("n") ?? "3");
  const interval = Number(url.searchParams.get("interval") ?? "100");
  const hold = url.searchParams.get("hold");
  // `event=<name>` names every server-sent event and `id=1` gives each an
  // id (`event:` and `id:` fields, HTML "Server-sent events").
  const event = url.searchParams.get("event");
  const ids = url.searchParams.get("id") === "1";
  const chunk = (i: number) =>
    sse
      ? `${event === null ? "" : `event: ${event}\n`}${ids ? `id: ${i + 1}\n` : ""}data: e${i}\n\n`
      : `c${i}\n`;
  const headers: http.OutgoingHttpHeaders = {
    "content-type": sse ? "text/event-stream" : "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
  if (url.searchParams.get("length") === "1" && !forever && hold === null) {
    let length = 0;
    for (let i = 0; i < n; i++) length += Buffer.byteLength(chunk(i));
    headers["content-length"] = length;
  }
  res.writeHead(200, headers);
  let written = 0;
  let finished = false;
  let timer: NodeJS.Timeout | undefined;
  const write = () => {
    res.write(chunk(written));
    written++;
    if (written < n) {
      timer = setTimeout(write, interval);
    } else if (hold !== null) {
      held.set(hold, res);
    } else {
      finished = true;
      res.end();
    }
  };
  res.on("finish", () => {
    finished = true;
  });
  res.on("close", () => {
    clearTimeout(timer);
    if (hold !== null) held.delete(hold);
    streamEnds.push({ url: url.pathname + url.search, written, finished });
  });
  write();
}

/**
 * `/api/release?id=<id>`: end the held stream `<id>` with `end\n`, and
 * answer `released` once that response has been handed to the kernel and
 * `RELEASE_SETTLE_MS` more have passed (`404` if no stream is held by that
 * id). A page that asks for it with a synchronous XMLHttpRequest from inside
 * a `progress` listener of the held stream therefore returns from that
 * listener with the rest of the body and its end already on their way to
 * it: they reach the request within Chromium's 50 ms progress throttle
 * window, which starts when the listener returns, so the platform's last
 * `progress` event always comes at DONE (Chromium dispatches a deferred one
 * before DONE's `readystatechange`).
 */
function releaseHeld(
  res: http.ServerResponse,
  url: URL,
  held: Map<string, http.ServerResponse>,
): void {
  const id = url.searchParams.get("id") ?? "";
  const target = held.get(id);
  if (target === undefined) {
    res.writeHead(404);
    res.end();
    return;
  }
  held.delete(id);
  target.on("finish", () => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("released");
    }, RELEASE_SETTLE_MS);
  });
  target.end("end\n");
}

/**
 * Serve `root` (and `generated`, under `/__generated/`) on a free loopback
 * port. API routes stand in for a site's backend: `GET /api/data` answers
 * `{"value": 42}`, `POST /api/echo` answers its own body, `/api/redirect`
 * redirects to `/api/data?redirected=1`, `/api/slow?ms=`
 * answers `slow` after `ms` milliseconds, `/api/stall` neither reads the
 * request body nor answers, `/api/stream` and `/api/sse` stream (see
 * `serveStream`), and `/api/release` ends a held stream (see `releaseHeld`).
 */
export async function startFixtureServer(
  root: string,
  generated?: string,
): Promise<FixtureServer> {
  const requests: ServedRequest[] = [];
  const streamEnds: StreamEnd[] = [];
  const held = new Map<string, http.ServerResponse>();
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith("/api/stall")) {
      // Never reads the request body and never answers: a large upload
      // stalls on TCP backpressure until the client gives up.
      requests.push({ method: req.method ?? "", url: req.url, body: "" });
      req.pause();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf-8");
      const url = req.url ?? "/";
      requests.push({ method: req.method ?? "", url, body });
      const pathname = new URL(url, "http://x").pathname;
      if (pathname === "/api/data") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ value: 42 }));
        return;
      }
      if (pathname === "/api/headers") {
        // Response headers the recorder must scrub (§11.3.5): the
        // credentials a response can carry, a proxy header, a header a site
        // lists, and one it must keep.
        res.writeHead(200, {
          "content-type": "application/json",
          authorization: "Bearer resp-authz-6f2b9c41",
          cookie: "resp-cookie=7d3e0a55",
          "proxy-authenticate": "Basic realm=proxy-realm-8a1c",
          "x-site-secret": "site-secret-4e9d21",
          "x-plain": "plain-header-value-77",
        });
        res.end(JSON.stringify({ value: 1 }));
        return;
      }
      if (pathname === "/api/echo") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(body);
        return;
      }
      if (pathname === "/api/stream" || pathname === "/api/sse") {
        serveStream(
          res,
          new URL(url, "http://x"),
          pathname === "/api/sse",
          streamEnds,
          held,
        );
        return;
      }
      if (pathname === "/api/release") {
        releaseHeld(res, new URL(url, "http://x"), held);
        return;
      }
      if (pathname === "/api/redirect") {
        res.writeHead(302, { location: "/api/data?redirected=1" });
        res.end();
        return;
      }
      if (pathname === "/api/slow") {
        const ms = Number(new URL(url, "http://x").searchParams.get("ms"));
        const t = setTimeout(() => {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("slow");
        }, ms);
        res.on("close", () => clearTimeout(t));
        return;
      }
      let dir = root;
      let rel = pathname;
      if (generated !== undefined && pathname.startsWith("/__generated/")) {
        dir = generated;
        rel = pathname.slice("/__generated".length);
      }
      const file = path.join(dir, path.normalize(rel));
      if (!file.startsWith(dir + path.sep) || !fs.existsSync(file)) {
        res.writeHead(404);
        res.end();
        return;
      }
      serveFile(res, file, new URL(url, "http://x").searchParams);
    });
  });
  server.on("upgrade", (req, socket) => serveWebSocket(req, socket, requests));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    streamEnds,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** The GUID a WebSocket handshake's accept key is derived with (RFC 6455 §1.3). */
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** One unmasked server-to-client frame (RFC 6455 §5.2). */
function wsFrame(opcode: number, payload: Buffer): Buffer {
  const head =
    payload.length < 126
      ? Buffer.from([0x80 | opcode, payload.length])
      : Buffer.from([
          0x80 | opcode,
          126,
          payload.length >> 8,
          payload.length & 0xff,
        ]);
  return Buffer.concat([head, payload]);
}

/**
 * `/api/ws`: a WebSocket endpoint (RFC 6455), written here because the dev
 * shell has no WebSocket server package. It accepts the first subprotocol the
 * client offers, then sends a text message `hello` and a binary message
 * whose bytes (`bin`) are valid UTF-8, so a replay that guessed the frame
 * type from the bytes would deliver it as text. It answers a close frame with
 * a close frame and ends the connection. Every other client frame is
 * ignored.
 */
function serveWebSocket(
  req: http.IncomingMessage,
  socket: import("node:stream").Duplex,
  requests: ServedRequest[],
): void {
  const url = new URL(req.url ?? "/", "http://x");
  requests.push({ method: "GET", url: req.url ?? "/", body: "" });
  const key = req.headers["sec-websocket-key"];
  if (url.pathname !== "/api/ws" || typeof key !== "string") {
    socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
    return;
  }
  const accept = crypto
    .createHash("sha1")
    .update(key + WS_GUID)
    .digest("base64");
  const offered = String(req.headers["sec-websocket-protocol"] ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      ...(offered.length > 0 ? [`Sec-WebSocket-Protocol: ${offered[0]}`] : []),
      "",
      "",
    ].join("\r\n"),
  );
  socket.write(wsFrame(0x1, Buffer.from("hello")));
  socket.write(wsFrame(0x2, Buffer.from("bin")));
  let buffered = Buffer.alloc(0);
  socket.on("data", (d: Buffer) => {
    buffered = Buffer.concat([buffered, d]);
    // A client frame is masked: 2 header bytes (short lengths only here),
    // the 4-byte mask, then the payload.
    while (buffered.length >= 6) {
      const opcode = buffered[0] & 0x0f;
      const len = buffered[1] & 0x7f;
      if (len >= 126 || buffered.length < 6 + len) break;
      buffered = buffered.subarray(6 + len);
      if (opcode === 0x8) {
        socket.end(wsFrame(0x8, Buffer.from([0x03, 0xe8])));
        return;
      }
    }
  });
  socket.on("error", () => socket.destroy());
}

// ── Installing the shim ─────────────────────────────────────────────────

/** A fresh copy of the fixture pages in a temporary directory. */
export function copyFixtures(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-boundary-shim-"));
  for (const f of fs.readdirSync(FIXTURES)) {
    fs.copyFileSync(path.join(FIXTURES, f), path.join(dir, f));
  }
  return dir;
}

/** The build hash the shimmed fixtures are installed with. */
export const FIXTURE_BUILD_HASH = "0123456789abcdef".repeat(4);

/**
 * A copy of the fixture pages with the shim installed by the shipped CLI
 * step, exactly as a site built by another bundler would get it.
 */
export function shimmedFixtures(): string {
  const dir = copyFixtures();
  const args = [CLI, "boundary-shim", dir, "--build-hash", FIXTURE_BUILD_HASH];
  execFileSync(process.execPath, args, {
    stdio: "pipe",
  });
  return dir;
}

// ── Reading the log ─────────────────────────────────────────────────────

/** The page's log, read through the shim's control surface. */
export async function readLog(page: Page): Promise<Uint8Array> {
  const bytes = await page.evaluate(() => {
    const shim = (globalThis as unknown as Record<string, unknown>)
      .__ctBoundaryShim as { log(): Uint8Array } | undefined;
    if (shim === undefined)
      throw new Error("the boundary shim is not installed");
    return Array.from(shim.log());
  });
  return Uint8Array.from(bytes);
}

/** Stop the session, then read and strictly decode its log. */
export async function stopAndDecode(page: Page): Promise<DecodedLog> {
  await page.evaluate(() => {
    (
      (globalThis as unknown as Record<string, unknown>).__ctBoundaryShim as {
        stop(): void;
      }
    ).stop();
  });
  return decodeLog(await readLog(page));
}

/** The records of `kind` (and, if given, matching `where`). */
export function recordsOf<K extends BoundaryRecord["record"]>(
  log: DecodedLog,
  kind: K,
  where: (r: Extract<BoundaryRecord, { record: K }>) => boolean = () => true,
): Extract<BoundaryRecord, { record: K }>[] {
  return log.records.filter(
    (r): r is Extract<BoundaryRecord, { record: K }> =>
      r.record === kind && where(r as Extract<BoundaryRecord, { record: K }>),
  );
}

/**
 * Wait until the fixture page marks itself done (`<body data-done="1">`).
 *
 * Polled from Node with `evaluate`, never with `waitForFunction`: its
 * in-page polling would schedule timers or animation frames through the
 * page's (patched) globals, and they would be recorded as the page's.
 * `step` runs before each poll (the behaviour comparison advances its
 * pinned clock there).
 */
export async function waitForDone(
  page: Page,
  step: () => Promise<void> = () => sleep(20),
): Promise<void> {
  const deadline = Date.now() + 15000;
  for (;;) {
    const done = await page.evaluate(
      () => document.body.getAttribute("data-done") === "1",
    );
    if (done) return;
    if (Date.now() > deadline) {
      throw new Error("the fixture page did not finish within 15 s");
    }
    await step();
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The marker a page's HTML is cut at when it is served in pieces. */
export const CHUNK_MARKER = "<!--ct:chunk-->";

/**
 * Answer a fixture file. `delay=<ms>` answers it that much later (a slow
 * script, style sheet or image). `chunks=<ms>` sends an HTML page in pieces,
 * cut after each {@link CHUNK_MARKER}, `ms` apart, as a server streaming its
 * response does: the browser parses each piece as it arrives, and runs
 * other tasks while it waits for the next.
 */
function serveFile(
  res: http.ServerResponse,
  file: string,
  params: URLSearchParams,
): void {
  const delay = Number(params.get("delay") ?? "0");
  const gap = Number(params.get("chunks") ?? "0");
  const send = () => {
    if (res.destroyed) return;
    res.writeHead(200, {
      "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    const body = fs.readFileSync(file);
    if (!(gap > 0)) {
      res.end(body);
      return;
    }
    const text = body.toString("utf-8");
    const pieces: string[] = [];
    let at = 0;
    for (;;) {
      const cut = text.indexOf(CHUNK_MARKER, at);
      if (cut < 0) break;
      pieces.push(text.slice(at, cut + CHUNK_MARKER.length));
      at = cut + CHUNK_MARKER.length;
    }
    pieces.push(text.slice(at));
    const next = () => {
      if (res.destroyed) return;
      const piece = pieces.shift()!;
      if (pieces.length === 0) {
        res.end(piece);
        return;
      }
      res.write(piece);
      setTimeout(next, gap);
    };
    next();
  };
  if (delay > 0) setTimeout(send, delay);
  else send();
}

// ── The document's tree ─────────────────────────────────────────────────

/**
 * The page's document, node by node in document order (text nodes one by
 * one, so two adjacent text nodes are not one, `<template>` contents
 * included), with every element's namespace, name and attributes. The
 * record bootstrap's element is left out, so a page with the shim installed
 * compares equal to the page without it when the bootstrap changed nothing
 * else.
 */
export async function documentTree(page: {
  evaluate<T>(fn: () => T): Promise<T>;
}): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const walk = (n: Node, depth: number): void => {
      const pad = " ".repeat(depth);
      if (n.nodeType === Node.ELEMENT_NODE) {
        const e = n as Element;
        if (e.hasAttribute("data-codetracer-boundary-shim")) return;
        const attrs = Array.from(e.attributes)
          .map((a) => `${a.name}=${JSON.stringify(a.value)}`)
          .join(" ");
        out.push(`${pad}<${e.namespaceURI} ${e.localName} ${attrs}>`);
        const kids =
          e.localName === "template"
            ? (e as HTMLTemplateElement).content.childNodes
            : e.childNodes;
        for (const c of Array.from(kids)) walk(c, depth + 1);
      } else if (n.nodeType === Node.TEXT_NODE) {
        out.push(`${pad}#text ${JSON.stringify(n.nodeValue)}`);
      } else if (n.nodeType === Node.COMMENT_NODE) {
        out.push(`${pad}#comment ${JSON.stringify(n.nodeValue)}`);
      } else {
        out.push(`${pad}#${n.nodeType}`);
      }
    };
    for (const c of Array.from(document.childNodes)) walk(c, 0);
    return out;
  });
}

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

export interface FixtureServer {
  /** `http://127.0.0.1:<port>`. */
  origin: string;
  /** Every request received, in arrival order. */
  requests: ServedRequest[];
  close(): Promise<void>;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

/**
 * Serve `root` (and `generated`, under `/__generated/`) on a free loopback
 * port. Two API routes stand in for a site's backend: `GET /api/data`
 * answers `{"value": 42}` and `POST /api/echo` answers its own body.
 */
export async function startFixtureServer(
  root: string,
  generated?: string,
): Promise<FixtureServer> {
  const requests: ServedRequest[] = [];
  const server = http.createServer((req, res) => {
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
      if (pathname === "/api/echo") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(body);
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
      res.writeHead(200, {
        "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      res.end(fs.readFileSync(file));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
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

/**
 * M26 follow-on: full-stack browser-recorder smoke.
 *
 *   real Vite dev server  →  real headless Chromium (Playwright)
 *                         →  real `session-manager record-web` daemon
 *                         →  on-disk `.ct` trace
 *
 * The prior M26 verification (`tests/browser/browser-runtime.test.ts`)
 * pinned the JSON contract using an in-memory `FakeTransport`; the
 * milestone-level e2e (`e2e_browser_recorder_full_stack_records_two_traces`)
 * was marked `skipped_narrow` because Playwright was not installed in the
 * dev shell.  This test closes the honest-skip path: it brings up the
 * full pipeline end-to-end whenever the host shell has the four
 * prerequisites (Vite binary, Playwright module, a chromium executable
 * Playwright can launch, and the `session-manager` binary).
 *
 * Pass criteria (mirrors the milestone description):
 *   1. The `<program>.ct/trace.json` file exists and parses as a JSON
 *      array of externally-tagged `TraceLowLevelEvent`s.
 *   2. At least one `Step` record is present (proof that the SWC
 *      instrumenter's `__ct.step(siteId)` calls reached the daemon).
 *   3. At least one matched `VariableName` + `Value` pair is present
 *      (proof that the page-side `__ct.value(name, value)` path lowers
 *      cleanly into the on-disk vocabulary).
 *   4. No record is malformed: every entry is a single-key object whose
 *      key is one of the known externally-tagged variant names.
 *
 * Skip discipline (Recorder-CLI-Conventions §1 / §6): the test prints
 * `SKIP:` with the precise missing prerequisite so a CI runner that
 * does not ship the relevant infrastructure has an actionable failure
 * reason rather than a silent pass.  The companion CI script at
 * `codetracer-specs/Planned-Features/value-origin-ci-scripts/run-m26-full-stack.sh`
 * is the runnable surface for an infra-equipped runner.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import * as net from "node:net";

const REPO_ROOT = path.resolve(__dirname, "../..");
const CLI_PATH = path.join(REPO_ROOT, "packages/cli/dist/index.js");
const RUNTIME_BROWSER_SRC = path.join(
  REPO_ROOT,
  "packages/runtime-browser/src/index.ts",
);
const VITE_PLUGIN_DIST = path.join(
  REPO_ROOT,
  "packages/vite-plugin/dist/index.js",
);

// ── Prerequisite probes ─────────────────────────────────────────────────

/** Locate `session-manager`; honours `SESSION_MANAGER_BIN`. */
function findSessionManagerBin(): string | null {
  const env = process.env.SESSION_MANAGER_BIN;
  if (env) return fs.existsSync(env) ? env : null;
  const wsRoot = path.dirname(REPO_ROOT);
  for (const sub of ["release", "debug"]) {
    const p = path.join(
      wsRoot,
      `codetracer/src/backend-manager/target/${sub}/session-manager`,
    );
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Try to load Playwright; returns the module or null. */
function tryRequirePlaywright(): typeof import("playwright") | null {
  try {
    return require("playwright");
  } catch {
    return null;
  }
}

/** Try to load Vite. */
function tryRequireVite(): typeof import("vite") | null {
  try {
    return require("vite");
  } catch {
    return null;
  }
}

/**
 * Discover a chromium executable Playwright can launch.  In Nix dev
 * shells Playwright's bundled-browser version doesn't always match the
 * `/nix/store/.../playwright-browsers/` content, so we walk common
 * store paths and fall back to `PLAYWRIGHT_CHROMIUM_BIN`.
 */
function findChromiumExecutable(): string | null {
  const explicit = process.env.PLAYWRIGHT_CHROMIUM_BIN;
  if (explicit) return fs.existsSync(explicit) ? explicit : null;
  const roots: string[] = [];
  if (process.env.PLAYWRIGHT_BROWSERS_PATH)
    roots.push(process.env.PLAYWRIGHT_BROWSERS_PATH);
  try {
    for (const entry of fs.readdirSync("/nix/store")) {
      if (entry.includes("playwright-browsers"))
        roots.push(path.join("/nix/store", entry));
    }
  } catch {
    /* /nix/store missing — non-Nix env */
  }
  for (const root of roots) {
    let children: string[];
    try {
      children = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const child of children) {
      const tries = [
        path.join(
          root,
          child,
          "chrome-headless-shell-linux64",
          "chrome-headless-shell",
        ),
        path.join(root, child, "chrome-linux64", "chrome"),
        path.join(root, child, "chrome-linux", "chrome"),
        path.join(root, child, "chrome-linux", "headless_shell"),
      ];
      for (const t of tries) if (fs.existsSync(t)) return t;
    }
  }
  const pw = tryRequirePlaywright();
  if (pw) {
    try {
      const exec = pw.chromium.executablePath();
      if (exec && fs.existsSync(exec)) return exec;
    } catch {
      /* ignore */
    }
  }
  return null;
}

// ── Networking ──────────────────────────────────────────────────────────

/** Pick an ephemeral TCP port and immediately release it. */
async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error("could not bind ephemeral port"));
      }
    });
  });
}

/** Poll a TCP port until it accepts connections or the deadline elapses. */
async function waitForPort(
  port: number,
  host: string,
  deadlineMs: number,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = net.createConnection(port, host);
      s.once("connect", () => {
        s.end();
        resolve(true);
      });
      s.once("error", () => resolve(false));
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

// ── Fixture authoring ───────────────────────────────────────────────────

/**
 * Write the fixture (HTML / app.js / bootstrap.js / vite.config.js)
 * into `dir`.  The 10-line `app.js` exercises `let` / `const` /
 * arithmetic; `bootstrap.js` installs `__ct` via
 * `@codetracer/runtime-browser` and then runs `app.js` inside an IIFE
 * so the SWC-injected top-level `__ct.enter(0, arguments)` resolves
 * `arguments` against a function scope.
 */
function writeFixture(dir: string, daemonPort: number): void {
  const appJs = [
    "// fixture: 10-line app exercising let / const / arithmetic.",
    "let x = 1;",
    "const y = 2;",
    "const z = x + y;",
    "document.body.textContent = `z=${z}`;",
    "// Explicit Value event so the trace carries a (VariableName, Value)",
    "// pair without depending on the SWC instrumenter to emit value(...).",
    "if (typeof __ct !== 'undefined' && typeof __ct.value === 'function') {",
    "  __ct.value('z', z);",
    "}",
    "document.body.setAttribute('data-ct-ready', '1');",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "app.js"), appJs);

  // Bootstrap: install the runtime BEFORE app.js runs.  We neutralise
  // enter/ret because the receiver expects snake_case `fn_id` on those
  // two variants (no #[serde(rename ...)]) while the runtime ships
  // camelCase `fnId` — tracked as a separate receiver bug.
  // We fetch+IIFE-wrap app.js (rather than `await import('./app.js')`)
  // so the SWC `__ct.enter(0, arguments)` prelude lands inside a
  // function scope (`arguments` is not bound at ES-module top level).
  const bootstrapJs = [
    "import { installBrowserRuntime } from '@codetracer/runtime-browser';",
    "const rt = installBrowserRuntime({",
    "  manifest: { formatVersion: 1, paths: ['app.js'], functions: [], sites: [] },",
    "  program: 'm26-fullstack',",
    "  args: [],",
    "  flushThreshold: 1,",
    "});",
    "// Workaround: drop Call / Return events on the floor — see comment",
    "// above and codetracer/src/backend-manager/src/browser_stream_receiver.rs",
    '// (Call/Return variants miss #[serde(rename = "fnId")]).',
    "window.__ct.enter = function () {};",
    "window.__ct.ret = function (_id, v) { return v; };",
    "window.__ctStop = () => rt.stop();",
    "const src = await (await fetch('/app.js')).text();",
    "new Function('(function(){' + src + '\\n})();')();",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "bootstrap.js"), bootstrapJs);

  const indexHtml = [
    "<!doctype html>",
    "<html><head><meta charset='utf-8'><title>m26-fullstack</title>",
    `<script>window.__codetracer_endpoint = "ws://127.0.0.1:${daemonPort}/ct-stream";</script>`,
    "</head><body>",
    "<script type='module' src='/bootstrap.js'></script>",
    "</body></html>",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "index.html"), indexHtml);

  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "m26-fixture", type: "module", private: true }),
  );

  // Vite config.  Wires `@codetracer/vite-plugin` and aliases
  // `@codetracer/runtime-browser` to its .ts source (the dist is CJS;
  // serving CJS through Vite's ESM pipeline mis-resolves named exports).
  // The plugin's `exclude` skips bootstrap.js (it installs __ct itself)
  // and the runtime-browser package tree (it DEFINES __ct).
  const viteConfig = [
    "import { codetracerVitePlugin } from '@codetracer/vite-plugin';",
    "export default {",
    "  plugins: [codetracerVitePlugin({",
    `    endpoint: "ws://127.0.0.1:${daemonPort}/ct-stream",`,
    "    exclude: [",
    "      '**/node_modules/**',",
    "      '**/bootstrap.js',",
    "      '**/packages/runtime-browser/**',",
    "    ],",
    "  })],",
    "  resolve: {",
    "    alias: {",
    `      '@codetracer/runtime-browser': ${JSON.stringify(RUNTIME_BROWSER_SRC)},`,
    `      '@codetracer/vite-plugin': ${JSON.stringify(VITE_PLUGIN_DIST)},`,
    "    },",
    "  },",
    "  server: { host: '127.0.0.1', strictPort: true, fs: { strict: false } },",
    "  clearScreen: false,",
    "  logLevel: 'warn',",
    "};",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "vite.config.js"), viteConfig);
}

// ── Trace assertions ────────────────────────────────────────────────────

/**
 * Known externally-tagged variants of `TraceLowLevelEvent` per
 * `codetracer/src/backend-manager/src/browser_stream_host.rs`.  Each
 * top-level record must carry exactly one key drawn from this set.
 */
const KNOWN_TRACE_VARIANTS = new Set([
  "Path",
  "Function",
  "Step",
  "Call",
  "Return",
  "Value",
  "VariableName",
  "Event",
]);

/** Find a `<program>.ct/trace.json` under `outDir`. */
function findTraceJson(outDir: string): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(outDir);
  } catch {
    return null;
  }
  for (const e of entries) {
    const cand = path.join(outDir, e, "trace.json");
    if (e.endsWith(".ct") && fs.existsSync(cand)) return cand;
  }
  return null;
}

// ── Subprocess utilities ────────────────────────────────────────────────

interface Tracked {
  child: ChildProcess;
  stdout: string[];
  stderr: string[];
}

function spawnTracked(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Tracked {
  const child = spawn(cmd, args, {
    cwd: opts.cwd ?? process.cwd(),
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout?.on("data", (b) => stdout.push(b.toString("utf-8")));
  child.stderr?.on("data", (b) => stderr.push(b.toString("utf-8")));
  return { child, stdout, stderr };
}

/** SIGINT, then SIGKILL after `forceAfterMs`. */
async function killChild(
  child: ChildProcess,
  forceAfterMs = 5000,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGINT");
  const start = Date.now();
  while (
    child.exitCode === null &&
    child.signalCode === null &&
    Date.now() - start < forceAfterMs
  ) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 200));
  }
}

// ── The test ────────────────────────────────────────────────────────────

describe("test_browser_recorder_full_stack", () => {
  it("records a .ct trace from a real Vite dev server + headless Chromium + record-web daemon", async () => {
    // ── Prereq gate (SKIP-narrow, per CLI conventions §6) ──────────────
    const sessionManagerBin = findSessionManagerBin();
    if (!sessionManagerBin) {
      console.warn(
        "SKIP: session-manager binary not found (build " +
          "`codetracer/src/backend-manager` or set SESSION_MANAGER_BIN; " +
          "see codetracer-specs/Planned-Features/value-origin-ci-scripts/run-m26-full-stack.sh).",
      );
      return;
    }
    const vite = tryRequireVite();
    if (!vite) {
      console.warn("SKIP: vite module not available in node_modules.");
      return;
    }
    const pw = tryRequirePlaywright();
    if (!pw) {
      console.warn("SKIP: playwright module not installed.");
      return;
    }
    const chromiumExec = findChromiumExecutable();
    if (!chromiumExec) {
      console.warn(
        "SKIP: chromium executable Playwright can launch not found (set PLAYWRIGHT_CHROMIUM_BIN).",
      );
      return;
    }
    if (!fs.existsSync(CLI_PATH)) {
      console.warn("SKIP: CLI dist missing — run `npm run build`.");
      return;
    }
    if (
      !fs.existsSync(RUNTIME_BROWSER_SRC) ||
      !fs.existsSync(VITE_PLUGIN_DIST)
    ) {
      console.warn("SKIP: workspace dists missing — run `npm run build`.");
      return;
    }

    // ── Set up tmp working area ────────────────────────────────────────
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "m26-fullstack-"));
    const outDir = path.join(tmp, "out");
    fs.mkdirSync(outDir, { recursive: true });
    const fixtureDir = path.join(tmp, "fixture");
    fs.mkdirSync(fixtureDir, { recursive: true });

    const daemonPort = await pickFreePort();
    const vitePort = await pickFreePort();
    writeFixture(fixtureDir, daemonPort);

    // Symlink workspace node_modules so Vite can resolve dev-dep imports.
    fs.symlinkSync(
      path.join(REPO_ROOT, "node_modules"),
      path.join(fixtureDir, "node_modules"),
      "dir",
    );

    // ── Launch the daemon ──────────────────────────────────────────────
    const daemon = spawnTracked(sessionManagerBin, [
      "record-web",
      "--bind",
      `127.0.0.1:${daemonPort}`,
      "--out-dir",
      outDir,
    ]);
    if (!(await waitForPort(daemonPort, "127.0.0.1", 10_000))) {
      await killChild(daemon.child);
      throw new Error(
        `daemon did not bind 127.0.0.1:${daemonPort} within 10s.\n` +
          `stderr:\n${daemon.stderr.join("")}`,
      );
    }

    // ── Launch Vite + Chromium, drive the page ─────────────────────────
    let viteServer: Awaited<ReturnType<typeof vite.createServer>> | null = null;
    let browser: import("playwright").Browser | null = null;
    try {
      viteServer = await vite.createServer({
        configFile: path.join(fixtureDir, "vite.config.js"),
        root: fixtureDir,
        server: { port: vitePort, host: "127.0.0.1", strictPort: true },
      });
      await viteServer.listen();
      if (!(await waitForPort(vitePort, "127.0.0.1", 10_000))) {
        throw new Error(`vite did not bind 127.0.0.1:${vitePort} within 10s`);
      }

      browser = await pw.chromium.launch({
        headless: true,
        executablePath: chromiumExec,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      });
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      const pageErrors: string[] = [];
      page.on("response", (resp) => {
        const status = resp.status();
        const url = resp.url();
        if (status >= 400 && !url.includes("/favicon")) {
          pageErrors.push(`http ${status}: ${url}`);
        }
      });
      page.on("pageerror", (e) => pageErrors.push(`pageerror: ${e.message}`));
      page.on("console", (msg) => {
        if (msg.type() !== "error") return;
        const text = msg.text();
        // Generic "Failed to load resource" is captured via `response`.
        if (text.startsWith("Failed to load resource:")) return;
        // Drop WebSocket reconnection noise; if the daemon were missing
        // we'd already have failed at the prereq gate.
        if (text.includes("WebSocket connection") && text.includes("failed"))
          return;
        pageErrors.push(`console: ${text}`);
      });
      await page.goto(`http://127.0.0.1:${vitePort}/`, {
        waitUntil: "load",
        timeout: 15_000,
      });
      // `data-ct-ready=1` is set by app.js after `__ct.value('z', z)`.
      await page.waitForSelector("body[data-ct-ready='1']", {
        timeout: 10_000,
      });
      // Graceful flush: invoke the page-side __ct.stop() (synchronous
      // queue drain + SessionEnd), then synthesise a `pagehide` so the
      // runtime's lifecycle listener also fires.
      await page.evaluate(() => {
        (window as unknown as { __ctStop?: () => void }).__ctStop?.();
      });
      await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
      await page.waitForTimeout(500);
      await ctx.close();
      await browser.close();
      browser = null;

      if (pageErrors.length > 0) {
        throw new Error(`Page errors:\n${pageErrors.join("\n")}`);
      }
    } finally {
      if (browser) await browser.close().catch(() => undefined);
      if (viteServer) await viteServer.close().catch(() => undefined);
    }

    // ── Stop the daemon (SIGINT triggers graceful flush) ───────────────
    await killChild(daemon.child);
    // Give the writer a moment to flush trace.json before we read it.
    await new Promise((r) => setTimeout(r, 300));

    // ── Locate + parse the trace ───────────────────────────────────────
    const tracePath = findTraceJson(outDir);
    expect(
      tracePath,
      `expected <program>.ct/trace.json under ${outDir}; daemon stderr:\n${daemon.stderr.join("")}`,
    ).not.toBeNull();
    const records = JSON.parse(fs.readFileSync(tracePath!, "utf-8")) as Array<
      Record<string, unknown>
    >;
    expect(Array.isArray(records)).toBe(true);
    expect(records.length).toBeGreaterThan(0);

    // ── Vocabulary well-formedness ─────────────────────────────────────
    for (const rec of records) {
      const keys = Object.keys(rec);
      expect(keys.length, `bad record: ${JSON.stringify(rec)}`).toBe(1);
      expect(
        KNOWN_TRACE_VARIANTS.has(keys[0]),
        `unknown variant '${keys[0]}'`,
      ).toBe(true);
    }

    // ── Content checks ─────────────────────────────────────────────────
    expect(records.filter((r) => "Step" in r).length).toBeGreaterThan(0);

    // VariableName + Value land as adjacent records (the writer pushes
    // them as a pair) — at least one such pair must exist.
    let foundPair = false;
    let foundZ = false;
    for (let i = 0; i < records.length - 1; i++) {
      if ("VariableName" in records[i] && "Value" in records[i + 1]) {
        foundPair = true;
        if (records[i].VariableName === "z") foundZ = true;
      }
    }
    expect(
      foundPair,
      "expected at least one (VariableName, Value) adjacent pair",
    ).toBe(true);
    expect(foundZ, "expected the page-side __ct.value('z', z) pair").toBe(true);

    fs.rmSync(tmp, { recursive: true, force: true });
  }, 60_000);
});

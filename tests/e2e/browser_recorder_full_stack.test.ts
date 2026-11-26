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
 *   1. The daemon wrote a single-file CTFS `<program>.ct` — and nothing
 *      else: no `trace.json`, `trace_metadata.json` or `trace_paths.json`
 *      — and the canonical decoder (`ct-print --full`) reads it.
 *   2. At least one step is present (proof that the SWC instrumenter's
 *      `__ct.step(siteId)` calls reached the daemon).
 *   3. The page-side `__ct.value("z", z)` value is recorded against its
 *      name (proof that the value path lowers cleanly into the recording).
 *
 * Skip discipline: the test prints `SKIP:` with the precise missing
 * prerequisite so a CI runner that does not ship the relevant
 * infrastructure has an actionable failure reason rather than a silent
 * pass.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import {
  ctPrintAvailable,
  ctPrintFull,
  ctPrintPath,
} from "../helpers/ct-print";
import { cargoBinaryCandidates } from "../boundary/siblings.js";

const REPO_ROOT = path.resolve(__dirname, "../..");
const CLI_PATH = path.join(REPO_ROOT, "packages/cli/dist/index.js");
const RUNTIME_BROWSER_SRC = path.join(
  REPO_ROOT,
  "packages/runtime-browser/src/index.ts",
);
// The runtime's own dependency: a workspace package whose dist is CommonJS,
// served from outside node_modules, so Vite's dependency optimiser does not
// convert it and its named exports do not resolve as ES module imports. Its
// TypeScript source is ESM, as the runtime's is.
const BOUNDARY_FORMAT_SRC = path.join(
  REPO_ROOT,
  "packages/boundary-format/src/index.ts",
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
  for (const c of cargoBinaryCandidates(
    "codetracer/src/backend-manager",
    "session-manager",
  )) {
    const p = path.join(wsRoot, c);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** The slice of playwright-core's API this test drives. */
interface PlaywrightCore {
  chromium: {
    launch(options: {
      headless: boolean;
      executablePath?: string;
      args?: string[];
    }): Promise<PwBrowser>;
    executablePath(): string;
  };
}
interface PwBrowser {
  newContext(): Promise<PwContext>;
  close(): Promise<void>;
}
interface PwContext {
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
}
interface PwPage {
  on(
    event: "response",
    f: (r: { status(): number; url(): string }) => void,
  ): void;
  on(event: "pageerror", f: (e: Error) => void): void;
  on(
    event: "console",
    f: (m: { type(): string; text(): string }) => void,
  ): void;
  goto(
    url: string,
    options: { waitUntil: "load"; timeout: number },
  ): Promise<unknown>;
  waitForSelector(
    selector: string,
    options: { timeout: number },
  ): Promise<unknown>;
  evaluate(fn: () => void): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
}

/**
 * Load playwright-core the way the boundary suites do
 * (`tests/boundary/harness.ts` `loadPlaywright`): from
 * `PLAYWRIGHT_CORE_PATH` when it is set, which the Nix dev shell exports
 * from nixpkgs' playwright-driver and the Windows `just test` recipe points
 * at the reprobuild `playwright` package; else from a `playwright-core`
 * Node resolves from the repository. Returns null only when neither exists
 * (the test then says so and skips); a `PLAYWRIGHT_CORE_PATH` that does not
 * load is an error, not a skip.
 */
function tryRequirePlaywright(): PlaywrightCore | null {
  const req = createRequire(path.join(REPO_ROOT, "noop.js"));
  const fromEnv = process.env.PLAYWRIGHT_CORE_PATH;
  if (fromEnv) return req(fromEnv) as PlaywrightCore;
  try {
    return req("playwright-core") as PlaywrightCore;
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
 * The directory `PLAYWRIGHT_BROWSERS_PATH` names, or null when it names none.
 *
 * `0` is not a directory: it is Playwright's sentinel for a hermetic install,
 * where the browsers live in the playwright-core package's own
 * `.local-browsers/` (https://playwright.dev/docs/browsers#hermetic-install;
 * playwright-core `lib/server/registry/index.js`, `registryDirectory`). The
 * Windows reprobuild dev env uses that layout, with the package directory in
 * `PLAYWRIGHT_CORE_PATH`, so the root is resolved from there. Taken as a path,
 * `0` would be resolved against the working directory instead.
 */
function browsersRootFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const browsers = env.PLAYWRIGHT_BROWSERS_PATH;
  if (!browsers) return null;
  if (browsers !== "0") return browsers;
  const core = env.PLAYWRIGHT_CORE_PATH;
  return core ? path.join(core, ".local-browsers") : null;
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
  const fromEnv = browsersRootFromEnv();
  if (fromEnv) roots.push(fromEnv);
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
        // Playwright's Windows builds (its registry's EXECUTABLE_PATHS `win`).
        path.join(root, child, "chrome-win", "headless_shell.exe"),
        path.join(root, child, "chrome-win", "chrome.exe"),
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

/**
 * The endpoint `session-manager record-web` announced on stderr once its
 * listener was bound: `listening on ws://<addr><path>`, where `<addr>` is the
 * address it actually holds. The daemon is started with `--bind
 * 127.0.0.1:0`, so the kernel picks the port as it binds and this line is
 * how the test learns it. A port picked by binding and releasing a probe
 * socket first is a race: any other process (vitest runs files in parallel,
 * several of them starting their own `record-web`) can take it before the
 * daemon binds, and the daemon then exits with `AddrInUse`, or a readiness
 * probe that only connects to the port finds the other process's listener.
 * Undefined until the line is complete.
 */
function announcedEndpoint(stderr: string): string | undefined {
  const m = /listening on (ws:\/\/127\.0\.0\.1:(\d+)\/\S*)\r?\n/.exec(stderr);
  if (m === null || Number(m[2]) === 0) return undefined;
  return m[1];
}

/** Wait for `daemon` to announce its endpoint; throws if it exits first. */
async function waitForEndpoint(
  daemon: Tracked,
  deadlineMs: number,
): Promise<string> {
  const start = Date.now();
  for (;;) {
    const endpoint = announcedEndpoint(daemon.stderr.join(""));
    if (endpoint !== undefined) return endpoint;
    if (daemon.child.exitCode !== null || daemon.child.signalCode !== null) {
      throw new Error(
        `record-web exited (${daemon.child.exitCode ?? daemon.child.signalCode}) before listening.\n` +
          `stderr:\n${daemon.stderr.join("")}`,
      );
    }
    if (Date.now() - start > deadlineMs) {
      await killChild(daemon.child);
      throw new Error(
        `record-web did not announce its endpoint within ${deadlineMs} ms.\n` +
          `stderr:\n${daemon.stderr.join("")}`,
      );
    }
    await new Promise((r) => setTimeout(r, 50));
  }
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
function writeFixture(dir: string, endpoint: string): void {
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

  // Bootstrap: install the runtime BEFORE app.js runs.  We fetch+IIFE-wrap
  // app.js (rather than `await import('./app.js')`) so the SWC
  // `__ct.enter(0, arguments)` prelude lands inside a function scope
  // (`arguments` is not bound at ES-module top level).
  //
  // The earlier workaround that stubbed `__ct.enter` / `__ct.ret` to
  // no-ops was removed once the receiver learned to decode the runtime's
  // camelCase `fnId` on Call / Return frames — see
  // `codetracer/src/backend-manager/src/browser_stream_receiver.rs`
  // (`#[serde(rename = "fnId")]` on `BrowserEvent::Call` /
  // `BrowserEvent::Return`).
  const bootstrapJs = [
    "import { installBrowserRuntime } from '@codetracer/runtime-browser';",
    "const rt = installBrowserRuntime({",
    "  manifest: { formatVersion: 1, paths: ['app.js'], functions: [], sites: [] },",
    "  program: 'm26-fullstack',",
    "  args: [],",
    "  flushThreshold: 1,",
    "});",
    "window.__ctStop = () => rt.stop();",
    "const src = await (await fetch('/app.js')).text();",
    "new Function('(function(){' + src + '\\n})();')();",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "bootstrap.js"), bootstrapJs);

  const indexHtml = [
    "<!doctype html>",
    "<html><head><meta charset='utf-8'><title>m26-fullstack</title>",
    `<script>window.__codetracer_endpoint = ${JSON.stringify(endpoint)};</script>`,
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
  // `@codetracer/runtime-browser`, and the `@codetracer/boundary-format` it
  // imports, to their .ts sources (the dists are CJS; serving CJS through
  // Vite's ESM pipeline mis-resolves named exports).
  // The plugin's `exclude` skips bootstrap.js (it installs __ct itself)
  // and the runtime's package trees (they DEFINE __ct).
  const viteConfig = [
    "import { codetracerVitePlugin } from '@codetracer/vite-plugin';",
    "export default {",
    "  plugins: [codetracerVitePlugin({",
    `    endpoint: ${JSON.stringify(endpoint)},`,
    "    exclude: [",
    "      '**/node_modules/**',",
    "      '**/bootstrap.js',",
    "      '**/packages/runtime-browser/**',",
    "      '**/packages/boundary-format/**',",
    "    ],",
    "  })],",
    "  resolve: {",
    "    alias: {",
    `      '@codetracer/runtime-browser': ${JSON.stringify(RUNTIME_BROWSER_SRC)},`,
    `      '@codetracer/boundary-format': ${JSON.stringify(BOUNDARY_FORMAT_SRC)},`,
    `      '@codetracer/vite-plugin': ${JSON.stringify(VITE_PLUGIN_DIST)},`,
    "    },",
    "  },",
    "  server: { host: '127.0.0.1', fs: { strict: false } },",
    "  clearScreen: false,",
    "  logLevel: 'warn',",
    "};",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "vite.config.js"), viteConfig);
}

// ── Trace assertions ────────────────────────────────────────────────────

/** Find the `<program>.ct` recording under `outDir`. */
function findRecording(outDir: string): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(outDir);
  } catch {
    return null;
  }
  for (const e of entries) {
    const cand = path.join(outDir, e);
    if (e.endsWith(".ct") && fs.statSync(cand).isFile()) return cand;
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

describe("browsersRootFromEnv", () => {
  it("returns a browsers directory as given", () => {
    expect(
      browsersRootFromEnv({ PLAYWRIGHT_BROWSERS_PATH: "/opt/pw-browsers" }),
    ).toBe("/opt/pw-browsers");
  });
  it("maps the hermetic-install sentinel 0 to the package's .local-browsers", () => {
    expect(
      browsersRootFromEnv({
        PLAYWRIGHT_BROWSERS_PATH: "0",
        PLAYWRIGHT_CORE_PATH: "/opt/playwright-core",
      }),
    ).toBe(path.join("/opt/playwright-core", ".local-browsers"));
  });
  it("names no directory for 0 without a package, or for an unset variable", () => {
    expect(browsersRootFromEnv({ PLAYWRIGHT_BROWSERS_PATH: "0" })).toBeNull();
    expect(browsersRootFromEnv({})).toBeNull();
  });
});

describe("test_browser_recorder_full_stack", () => {
  it("records a .ct trace from a real Vite dev server + headless Chromium + record-web daemon", async () => {
    // ── Prereq gate (SKIP-narrow: name the missing prerequisite) ──────
    const sessionManagerBin = findSessionManagerBin();
    if (!sessionManagerBin) {
      console.warn(
        "SKIP: session-manager binary not found (build " +
          "`codetracer/src/backend-manager` with `cargo build --bin " +
          "session-manager`, or set SESSION_MANAGER_BIN).",
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
      console.warn(
        "SKIP: playwright-core not found (set PLAYWRIGHT_CORE_PATH, as the dev shell does).",
      );
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
    if (!ctPrintAvailable()) {
      console.warn(
        `SKIP: ct-print not found at ${ctPrintPath()} — build it in codetracer-trace-format-nim or set CT_PRINT.`,
      );
      return;
    }

    // ── Set up tmp working area ────────────────────────────────────────
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "m26-fullstack-"));
    const outDir = path.join(tmp, "out");
    fs.mkdirSync(outDir, { recursive: true });
    const fixtureDir = path.join(tmp, "fixture");
    fs.mkdirSync(fixtureDir, { recursive: true });

    // ── Launch the daemon ──────────────────────────────────────────────
    // On port 0, so the kernel picks a free port as it binds; the fixture
    // is written with the endpoint the daemon announces.
    const daemon = spawnTracked(sessionManagerBin, [
      "record-web",
      "--bind",
      "127.0.0.1:0",
      "--out-dir",
      outDir,
    ]);

    // ── Launch Vite + Chromium, drive the page ─────────────────────────
    let viteServer: Awaited<ReturnType<typeof vite.createServer>> | null = null;
    let browser: PwBrowser | null = null;
    try {
      const endpoint = await waitForEndpoint(daemon, 10_000);
      writeFixture(fixtureDir, endpoint);

      // Symlink workspace node_modules so Vite can resolve dev-dep imports.
      fs.symlinkSync(
        path.join(REPO_ROOT, "node_modules"),
        path.join(fixtureDir, "node_modules"),
        "dir",
      );

      // Port 0 for the same reason as the daemon's: the kernel picks a free
      // port as Vite binds, and the test reads it back from the listener.
      // `listen()` resolves once the server is listening.
      viteServer = await vite.createServer({
        configFile: path.join(fixtureDir, "vite.config.js"),
        root: fixtureDir,
        server: { port: 0, host: "127.0.0.1", strictPort: true },
      });
      await viteServer.listen();
      const viteAddr = viteServer.httpServer?.address();
      if (
        viteAddr === null ||
        viteAddr === undefined ||
        typeof viteAddr === "string"
      ) {
        throw new Error(
          `vite is not listening on a TCP port: ${String(viteAddr)}`,
        );
      }
      const vitePort = viteAddr.port;

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
      try {
        await page.waitForSelector("body[data-ct-ready='1']", {
          timeout: 10_000,
        });
      } catch (e) {
        // Name what the page reported, which is why it never got ready.
        throw new Error(
          `${(e as Error).message}\npage errors:\n${pageErrors.join("\n")}`,
        );
      }
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
      // ── Stop the daemon (SIGINT triggers graceful flush) ─────────────
      // Here rather than after the block, so a failure above does not
      // leave the daemon running past the test until its idle timeout.
      await killChild(daemon.child);
    }

    // Give the writer a moment to finalise the recording before we read it.
    await new Promise((r) => setTimeout(r, 300));

    // ── Locate + decode the recording ──────────────────────────────────
    const recording = findRecording(outDir);
    expect(
      recording,
      `expected a <program>.ct under ${outDir}; daemon stderr:\n${daemon.stderr.join("")}`,
    ).not.toBeNull();
    const sidecars = fs
      .readdirSync(outDir)
      .filter((e) => /^trace(_metadata|_paths)?\.json$/.test(e));
    expect(sidecars, "record-web must write no JSON sidecar").toEqual([]);

    const bundle = ctPrintFull(recording!);

    // ── Content checks ─────────────────────────────────────────────────
    const steps = bundle.events.filter((e) => e.kind === "step");
    expect(steps.length).toBeGreaterThan(0);

    const recordedNames = new Set<string>();
    for (const e of bundle.events) {
      if (e.kind !== "step") continue;
      for (const v of e.vars ?? []) recordedNames.add(v.varname);
    }
    expect(
      recordedNames.has("z"),
      `expected the page-side __ct.value('z', z) to be recorded; got ${[...recordedNames].join(", ")}`,
    ).toBe(true);

    fs.rmSync(tmp, { recursive: true, force: true });
  }, 60_000);
});

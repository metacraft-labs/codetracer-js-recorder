/**
 * The replay runner (CodeTracer's JS-Boundary-Recording specification §6,
 * §7, §8, §9.7, §12): replay a recorded boundary log in headless Chromium
 * against the instrumented copy of the byte-identical bundle, and write the
 * materialised JavaScript trace.
 *
 * 1. The log is read and decoded strictly (`log.ts`).
 * 2. **Build identity** (§8). The bundle's build hash (its canonical
 *    `ct-bundle.json`, §8.1) must equal `Header.build_hash`; otherwise the
 *    replay is `BuildMismatch` before any page code runs.
 * 3. **Materialisation** (§12), when an output is asked for: the bundle is
 *    instrumented post-bundle (`instrument --relative-paths`, with the
 *    browser runtime stub), and a `record-web` host (codetracer's
 *    `session-manager record-web`) receives the `__ct` stream.
 * 4. **The replay context** (§7.4) is made from `Env` (viewport, device
 *    pixel ratio, locale, time zone, colour scheme, reduced motion). Every
 *    request is answered by the runner: the build's files at the recorded
 *    origin, and nothing else (the network is denied; only the `__ct`
 *    stream's own socket reaches the runner's `record-web` host).
 * 5. Init scripts, before any page code: the configuration, `__ctReplay`
 *    and its scheduler (`dist/replay-runtime.iife.js`), at level 0 the
 *    generic shim in replay mode, then the `__ct` stub.
 * 6. The runner waits for the in-page scheduler to reach `End` or diverge.
 *    On divergence **no trace is written**: the report carries the
 *    `DivergenceError` (§7.2). On success the trace is moved to the output.
 *
 * A Chromium major version other than `Env.ua_major` is reported in the
 * report and in the trace's metadata (its `args`), never refused (§7.4).
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import {
  buildBundleManifest,
  boundaryShimReplayBundle,
  type DivergenceReport,
  REPLAY_CONFIG_GLOBAL,
  REPLAY_GLOBAL,
  type ReplayConfig,
  bootstrapPosition,
  stripBoundaryShim,
} from "@codetracer/boundary-shim";
import { RECORDER_VERSION } from "@codetracer/instrumenter";
import { instrumentTree } from "@codetracer/cli/dist/instrument-cmd.js";

import type { ReplayStatus } from "./browser/runtime.js";
import {
  documentPlan,
  GATE_PATH,
  HeldResources,
  insertGates,
  OPEN_BINDING,
  parserScriptUrls,
} from "./gates.js";
import { type LoadedLog, loadBoundaryLog } from "./log.js";
import {
  type Browser,
  type BrowserContext,
  type ContextOptions,
  loadPlaywright,
  type Page,
} from "./playwright.js";

/** The in-page runtime bundle (`scripts/bundle.mjs` builds it). */
export const RUNTIME_BUNDLE_PATH = path.join(
  __dirname,
  "..",
  "dist",
  "replay-runtime.iife.js",
);

export interface ReplayOptions {
  /** The recording: a `.ct` container, or a bare `jsbound.log` stream. */
  log: string;
  /** The deployed bundle the session ran (its directory). */
  build: string;
  /**
   * Where to write the materialised trace. Without it the replay only
   * verifies (every checkpoint, every read), with the bundle as deployed.
   */
  out?: string;
  /** The `session-manager` binary whose `record-web` writes the trace. */
  sessionManager?: string;
  /** The limit on the whole replay, in ms (default 60000). */
  timeoutMs?: number;
  /** A browser to use instead of launching one. */
  browser?: Browser;
}

/** What a replay found. */
export interface ReplayReport {
  /** `replayed`: reached `End`; `diverged`; `error`: could not run. */
  status: "replayed" | "diverged" | "error";
  divergence?: DivergenceReport;
  error?: string;
  session: {
    sessionId: string;
    buildHash: string;
    protocolLevel: number;
    recorderId: string;
    framework: string;
    url: string;
  };
  build: { dir: string; buildHash?: string };
  /** The replay environment, and how it differs from the recording's. */
  metadata: {
    recorderVersion: string;
    chromium?: string;
    recordedUaMajor: number;
    replayUaMajor?: number;
    /** The replay's Chromium major differs from `Env.ua_major` (§7.4). */
    uaMajorMismatch: boolean;
  };
  checkpoints: number;
  injections: number;
  tasks: number;
  /** Level 1: DOM events dispatched while the framework's `inject` ran. */
  dispatchedDuringInject: string[];
  pageErrors: string[];
  /** The materialised trace, when one was written. */
  output?: string;
  /** The `meta.dat` args the trace carries (its replay provenance). */
  traceArgs?: string[];
  /**
   * The trace's `recording_id`, derived from the session
   * ({@link materialisedRecordingId}), when a trace was asked for.
   */
  traceRecordingId?: string;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** The file `pathname` names under `root`, if any (no traversal). */
function fileUnder(root: string, pathname: string): string | undefined {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.resolve(root, "." + rel);
  if (file !== root && !file.startsWith(root + path.sep)) return undefined;
  try {
    return fs.statSync(file).isFile() ? file : undefined;
  } catch {
    return undefined;
  }
}

/** The replay context's options from `Env` (§7.4). */
export function contextOptionsOf(env: LoadedLog["env"]): ContextOptions {
  const o: ContextOptions = { serviceWorkers: "block" };
  if (env.viewport_w > 0 && env.viewport_h > 0) {
    o.viewport = { width: env.viewport_w, height: env.viewport_h };
  }
  if (Number.isFinite(env.dpr) && env.dpr > 0) o.deviceScaleFactor = env.dpr;
  if (env.locale !== "") o.locale = env.locale;
  if (env.tz !== "") o.timezoneId = env.tz;
  o.colorScheme =
    env.color_scheme === 2
      ? "dark"
      : env.color_scheme === 1
        ? "light"
        : "no-preference";
  o.reducedMotion = env.reduced_motion === 1 ? "reduce" : "no-preference";
  return o;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A running `record-web` host (codetracer `session-manager record-web`). */
interface TraceHost {
  endpoint: string;
  outDir: string;
  child: ChildProcess;
  stderr: string[];
}

async function startTraceHost(
  bin: string,
  outDir: string,
  recordingId: string,
): Promise<TraceHost> {
  const port = await freePort();
  const stderr: string[] = [];
  const child = spawn(
    bin,
    [
      "record-web",
      "--bind",
      `127.0.0.1:${port}`,
      "--out-dir",
      outDir,
      "--idle-timeout",
      "300s",
      // The trace's identity is the runner's to choose (§12): derived from
      // the session, so materialising it again writes the same bytes.
      "--recording-id",
      recordingId,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  child.stderr?.on("data", (b: Buffer) => stderr.push(b.toString("utf-8")));
  const deadline = Date.now() + 20000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(
        `record-web exited (${child.exitCode}): ${stderr.join("")}`,
      );
    }
    if (stderr.join("").includes("listening on")) break;
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(
        `record-web did not start within 20 s: ${stderr.join("")}`,
      );
    }
    await sleep(25);
  }
  return {
    endpoint: `ws://127.0.0.1:${port}/ct-stream`,
    outDir,
    child,
    stderr,
  };
}

async function stopTraceHost(host: TraceHost): Promise<void> {
  if (host.child.exitCode !== null || host.child.signalCode !== null) return;
  const exited = new Promise<void>((r) => host.child.once("exit", () => r()));
  host.child.kill("SIGINT");
  await Promise.race([exited, sleep(10000)]);
  if (host.child.exitCode === null && host.child.signalCode === null) {
    host.child.kill("SIGKILL");
    await exited;
  }
}

/** The `.ct` the host wrote, once it is in place (never a partial one). */
function writtenTrace(outDir: string): string | undefined {
  for (const e of fs.readdirSync(outDir)) {
    const p = path.join(outDir, e);
    if (e.endsWith(".ct") && fs.statSync(p).isFile()) return p;
  }
  return undefined;
}

/** What a materialised trace is the materialisation of (§12). */
export interface MaterialisedIdentity {
  /** The boundary recording's own `recording_id`; absent for a bare log. */
  sourceRecordingId?: string;
  /** `Header.session_id`, which names a bare log's session. */
  sessionId: string;
  /** The deployed bundle's build hash (§8). */
  buildHash: string;
  /** The recorder version that instruments it (§8.1). */
  recorderVersion: string;
  /** The replay browser's full version (§7.4). */
  browserVersion: string;
}

/**
 * The `recording_id` of a materialised trace (JS-Boundary-Recording.md §12):
 * a canonical UUIDv7 that is a function of what the trace is a
 * materialisation of, so that materialising the same session again, after
 * the cached trace was evicted, writes a byte-identical trace,
 * and so that the trace never shares the boundary recording's own id
 * (Recording-Identifier-Migration.md: every recording has its own).
 *
 * The 48-bit timestamp is the boundary recording's (the first 48 bits of
 * its `recording_id`), so the trace sorts with the session it was made
 * from; it is 0 for a bare `jsbound.log`, which has no recording id. The
 * version nibble is 7 and the variant `10` (RFC 9562 §5.7); the other 74
 * bits are the first bits of the SHA-256 of
 * `codetracer-js-boundary-materialised/1`, the source (its recording id,
 * or `session:<session_id>` for a bare log), the build hash, the recorder
 * version and the replay browser's version, each ended by a newline.
 */
export function materialisedRecordingId(id: MaterialisedIdentity): string {
  const source =
    id.sourceRecordingId !== undefined
      ? id.sourceRecordingId
      : `session:${id.sessionId}`;
  const digest = createHash("sha256")
    .update(
      [
        "codetracer-js-boundary-materialised/1",
        source,
        id.buildHash,
        id.recorderVersion,
        id.browserVersion,
        "",
      ].join("\n"),
      "utf-8",
    )
    .digest();
  const b = Buffer.alloc(16);
  if (id.sourceRecordingId !== undefined) {
    Buffer.from(
      id.sourceRecordingId.replace(/-/g, "").slice(0, 12),
      "hex",
    ).copy(b, 0);
  }
  digest.copy(b, 6, 0, 10);
  b[6] = 0x70 | (b[6] & 0x0f);
  b[8] = 0x80 | (b[8] & 0x3f);
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function majorOf(version: string): number | undefined {
  const m = /^(\d+)/.exec(version);
  return m === null ? undefined : Number(m[1]);
}

/**
 * The trace's `program` (§12): `Env.url` without its query and fragment,
 * as the boundary recording's `meta.dat` has it (§5.1). `Env.url` itself
 * keeps both, since the page reads them and is loaded at that URL (§7.4).
 */
export function programOf(url: string): string {
  const cut = url.search(/[?#]/);
  return cut < 0 ? url : url.slice(0, cut);
}

/** Replay `options.log` and report (see the module comment). */
export async function replaySession(
  options: ReplayOptions,
): Promise<ReplayReport> {
  const loaded = loadBoundaryLog(options.log);
  const { header, env } = loaded;
  const build = path.resolve(options.build);
  const report: ReplayReport = {
    status: "error",
    session: {
      sessionId: header.session_id,
      buildHash: header.build_hash,
      protocolLevel: header.protocol_level,
      recorderId: header.recorder_id,
      framework: header.framework,
      url: env.url,
    },
    build: { dir: build },
    metadata: {
      recorderVersion: RECORDER_VERSION,
      recordedUaMajor: env.ua_major,
      uaMajorMismatch: false,
    },
    checkpoints: 0,
    injections: 0,
    tasks: 0,
    dispatchedDuringInject: [],
    pageErrors: [],
  };

  // §8: the build must be the one the session ran, before any page code.
  const { buildHash } = buildBundleManifest(build);
  report.build.buildHash = buildHash;
  if (buildHash !== header.build_hash) {
    report.status = "diverged";
    report.divergence = {
      kind: "BuildMismatch",
      seq: "0",
      recorded: header.build_hash,
      actual: buildHash,
      detail: `the build at ${build} hashes to ${buildHash}, not the session's Header.build_hash`,
      cause: "mismatch",
    };
    return report;
  }

  let origin: string;
  try {
    origin = new URL(env.url).origin;
  } catch {
    report.error = `Env.url ${JSON.stringify(env.url)} is not a URL`;
    return report;
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "ct-boundary-replay-"));
  let host: TraceHost | undefined;
  let instrumented: string | undefined;
  let stub = "";
  const timeoutMs = options.timeoutMs ?? 60000;
  const browser =
    options.browser ??
    (await loadPlaywright().chromium.launch({ headless: true }));
  let context: BrowserContext | undefined;
  try {
    report.metadata.chromium = browser.version();
    report.metadata.replayUaMajor = majorOf(browser.version());
    report.metadata.uaMajorMismatch =
      report.metadata.replayUaMajor !== env.ua_major;

    const args = [
      `boundary-session=${header.session_id}`,
      `build-hash=${buildHash}`,
      `recorder-version=${RECORDER_VERSION}`,
      `recorded-ua-major=${env.ua_major}`,
      `replay-ua-major=${report.metadata.replayUaMajor ?? "unknown"}`,
    ];
    if (report.metadata.uaMajorMismatch) {
      args.push(
        `ua-major-mismatch=${env.ua_major}->${report.metadata.replayUaMajor ?? "unknown"}`,
      );
    }

    if (options.out !== undefined) {
      const bin =
        options.sessionManager ??
        process.env.CODETRACER_SESSION_MANAGER ??
        process.env.SESSION_MANAGER_BIN;
      if (bin === undefined || bin === "" || !fs.existsSync(bin)) {
        throw new Error(
          "writing a trace needs codetracer's session-manager (its record-web host): " +
            "pass --session-manager or set CODETRACER_SESSION_MANAGER",
        );
      }
      report.traceRecordingId = materialisedRecordingId({
        sourceRecordingId: loaded.recordingId,
        sessionId: header.session_id,
        buildHash,
        recorderVersion: RECORDER_VERSION,
        browserVersion: browser.version(),
      });
      host = await startTraceHost(
        bin,
        path.join(work, "trace"),
        report.traceRecordingId,
      );
      instrumented = path.join(work, "instrumented");
      const result = instrumentTree({
        src: build,
        outDir: instrumented,
        relativePaths: true,
        sourceMaps: true,
        browser: true,
        endpoint: host.endpoint,
      });
      if (result.failures.length > 0) {
        throw new Error(
          `instrumenting the build failed for ${result.failures.map((f) => f.file).join(", ")}: ${result.failures[0].error}`,
        );
      }
      stub = fs.readFileSync(result.stubPath!, "utf-8");
      report.traceArgs = args;
    }

    context = await browser.newContext(contextOptionsOf(env));
    // §6, "The document's own tasks": what the replay holds of the
    // document's loading until the log says it ran (`gates.ts`).
    const plan = documentPlan(loaded.records);
    const held = new HeldResources();
    if (plan.holds) {
      await context.exposeBinding(OPEN_BINDING, (_source, key) => {
        held.open(String(key));
      });
    }
    /** At level 0, the external scripts the replayed document's parser inserts. */
    let parserScripts = new Set<string>();
    let documents = 0;
    await context.route("**/*", async (route, request) => {
      let url: URL;
      try {
        url = new URL(request.url());
      } catch {
        await route.abort("blockedbyclient");
        return;
      }
      // §7.4: no network. The build's files at the recorded origin, the
      // first document only (a later navigation ends the session).
      if (url.origin !== origin || request.method() !== "GET") {
        await route.abort("blockedbyclient");
        return;
      }
      let firstDocument = false;
      if (
        request.isNavigationRequest() &&
        request.resourceType() === "document"
      ) {
        if (documents++ > 0) {
          await route.abort("blockedbyclient");
          return;
        }
        firstDocument = true;
      }
      if (url.pathname.startsWith(GATE_PATH)) {
        // A gate: answered when the scheduler lets the document go on;
        // it removes itself when it runs.
        await held.hold(url.pathname.slice(GATE_PATH.length));
        await route.fulfill({
          status: 200,
          headers: {
            "content-type": CONTENT_TYPES[".js"],
            "cache-control": "no-store",
          },
          body: `${REPLAY_GLOBAL}.gate();`,
        });
        return;
      }
      if (request.resourceType() === "script") {
        // A script whose execution the log has runs when its DocTask comes
        // due (the preload scanner's request is the one held). At level 0
        // the shim ran before every script of the page and logged each
        // execution, so a script of the document's that the log does not have
        // did not run before the session ended, and does not run on replay
        // either. Anything else (a module's dependency, which is not a script
        // element) is answered as it comes.
        const key = url.href.split("#")[0];
        if (
          plan.takeScript(key) ||
          (header.protocol_level === 0 && plan.holds && parserScripts.has(key))
        ) {
          await held.hold(`script:${key}`);
        }
      }
      const file =
        (instrumented === undefined
          ? undefined
          : fileUnder(instrumented, url.pathname)) ??
        fileUnder(build, url.pathname);
      if (file === undefined) {
        await route.fulfill({ status: 404, body: "" });
        return;
      }
      const ext = path.extname(file).toLowerCase();
      let body: Buffer = fs.readFileSync(file);
      // The bundle as archived carries no bootstrap; one left in a page is
      // the record shim's, which replay installs itself (§8.1, §10).
      if (ext === ".html" || ext === ".htm") {
        body = stripBoundaryShim(body);
        if (firstDocument) {
          const html = body.toString("utf-8");
          parserScripts = new Set(parserScriptUrls(html, url.href));
          // At level 0 the recorded document had the record bootstrap at
          // the start of its head, which implied the head there when the
          // page has no `<head>` tag; a gate stands in for it, so the
          // replayed document is built the same (`gates.ts`).
          const bootstrapAt =
            header.protocol_level === 0 ? bootstrapPosition(html) : undefined;
          if (plan.holds || bootstrapAt !== undefined) {
            body = Buffer.from(
              insertGates(html, { ...plan.gates, bootstrapAt }).html,
              "utf-8",
            );
          }
        }
      }
      await route.fulfill({
        status: 200,
        headers: {
          "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream",
          "cache-control": "no-store",
        },
        body,
      });
    });

    const config: ReplayConfig = {
      log: Buffer.from(loaded.stream).toString("base64"),
      ...(plan.holds ? { binding: OPEN_BINDING } : {}),
    };
    let preamble = `globalThis.${REPLAY_CONFIG_GLOBAL}=${JSON.stringify(config)};`;
    if (host !== undefined) {
      preamble +=
        `globalThis.__codetracer_endpoint=${JSON.stringify(host.endpoint)};` +
        `globalThis.__codetracer_program=${JSON.stringify(programOf(env.url))};` +
        `globalThis.__codetracer_args=${JSON.stringify(report.traceArgs)};`;
    }
    // Init scripts run in every document of the context, the page's first
    // about:blank included; only the recorded origin's document is replayed.
    const scripts = [preamble, fs.readFileSync(RUNTIME_BUNDLE_PATH, "utf-8")];
    if (header.protocol_level === 0) scripts.push(boundaryShimReplayBundle());
    if (stub !== "") scripts.push(stub);
    for (const content of scripts) {
      await context.addInitScript({
        content: `if (globalThis.location && location.origin === ${JSON.stringify(origin)}) {\n${content}\n}`,
      });
    }

    const page = await context.newPage();
    await page.goto(env.url, { waitUntil: "commit", timeout: timeoutMs });
    const status = await waitForReplay(page, timeoutMs);
    report.checkpoints = status.checkpoints;
    report.injections = status.injections;
    report.tasks = status.tasks;
    report.dispatchedDuringInject = status.dispatchedDuringInject;
    report.pageErrors = status.pageErrors;
    if (status.state === "diverged") {
      report.status = "diverged";
      report.divergence = status.divergence;
      return report;
    }
    if (status.state !== "done") {
      report.error = `the replay did not finish within ${timeoutMs} ms (the scheduler is at seq ${status.cursor}, state ${status.state}; ${status.waiting ?? ""})`;
      return report;
    }

    if (host !== undefined && options.out !== undefined) {
      await page.evaluate(() => {
        (globalThis as unknown as { __ct?: { stop(): void } }).__ct?.stop();
      });
      let trace: string | undefined;
      const deadline = Date.now() + 30000;
      while (
        (trace = writtenTrace(host.outDir)) === undefined &&
        Date.now() < deadline
      ) {
        await sleep(50);
      }
      if (trace === undefined) {
        // The host finishes a recording when its connection closes too.
        await context.close();
        context = undefined;
        while (
          (trace = writtenTrace(host.outDir)) === undefined &&
          Date.now() < deadline + 10000
        ) {
          await sleep(50);
        }
      }
      if (trace === undefined) {
        throw new Error(`record-web wrote no trace: ${host.stderr.join("")}`);
      }
      const out = path.resolve(options.out);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.copyFileSync(trace, out + ".partial");
      fs.renameSync(out + ".partial", out);
      report.output = out;
    }
    report.status = "replayed";
    return report;
  } catch (e) {
    report.status = "error";
    report.error = (e as Error).message;
    return report;
  } finally {
    await context?.close().catch(() => undefined);
    if (options.browser === undefined)
      await browser.close().catch(() => undefined);
    if (host !== undefined) await stopTraceHost(host);
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** Poll the in-page scheduler until it is done, diverged, or out of time. */
async function waitForReplay(
  page: Page,
  timeoutMs: number,
): Promise<ReplayStatus> {
  const deadline = Date.now() + timeoutMs;
  let last: ReplayStatus | undefined;
  for (;;) {
    try {
      last = await page.evaluate(() =>
        (
          globalThis as unknown as { __ctReplay: { status(): ReplayStatus } }
        ).__ctReplay.status(),
      );
    } catch {
      // The document is still being created.
    }
    if (
      last !== undefined &&
      (last.state === "done" || last.state === "diverged")
    ) {
      return last;
    }
    if (Date.now() > deadline) {
      return (
        last ?? {
          state: "loading",
          checkpoints: 0,
          injections: 0,
          dispatchedDuringInject: [],
          tasks: 0,
          cursor: "",
          pageErrors: [],
        }
      );
    }
    await sleep(25);
  }
}

/**
 * The browser error reporter (`packages/runtime-browser/src/error-report.ts`)
 * and the trace context it attaches (`trace-context.ts`), end to end.
 *
 * In real headless Chromium against a real server-rendered page: the backend
 * (`fixtures/error-report/server.py`) traces each page request with the real
 * OpenTelemetry Python SDK, puts the span's `traceparent` in the page with the
 * SDK's own propagator, and writes the span with the SDK's console exporter
 * to a file. An error injected into the page (a click whose handler throws,
 * after a password was typed) must produce exactly one upload whose trace id
 * is the trace id of that span, read from the backend's own span output.
 *
 * Controls, in the same run as the positive case that shows uploads arrive:
 * capture disabled, consent absent, consent refused, Do Not Track and Global
 * Privacy Control each produce no upload. Falsifiers, each a mutation of the
 * shipped module applied as the page's bundle is built: with the scrubber
 * removed the typed password and the `Authorization` token reach the upload;
 * with the trace context ignored the upload's trace id no longer joins the
 * span. Both must keep showing the defect, or the test above proves nothing.
 *
 * The boundary shim writes the same trace context into its log's `Env`
 * record (`traceparent`), read by the same reader: a page the shim was
 * installed into by the shipped injector, served by the same traced
 * backend, must carry the span's `traceparent` there, by the `<meta>` and
 * by the `Server-Timing` route, and nothing for a malformed one; the
 * reporter on such a page reads the navigation entry through the captured
 * original, so its read is not logged as the page's. Their falsifiers: a
 * shim bundle whose reader is removed, and a reporter that reads the
 * patched timeline.
 *
 * Mocks: none of the browser, the SDK or the span. One stand-in: the
 * fixture server's `POST /reports` receives the uploads, because no ingest
 * route accepts these reports yet; it records the request as received and
 * answers 204, which is all the reporter reads of an answer.
 *
 * Needs the dev shell: Chromium and playwright-core (`PLAYWRIGHT_CORE_PATH`,
 * `PLAYWRIGHT_BROWSERS_PATH`) and a Python with the OpenTelemetry SDK
 * (`CT_OTEL_PYTHON`), all from the flake's nixpkgs. Without them the test
 * fails, naming the shell, rather than skip.
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as esbuild from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  BOOTSTRAP_MARKER,
  injectBoundaryShim,
} from "../../packages/boundary-shim/src/index.js";
import {
  type BrowserErrorReport,
  type RawErrorReport,
  scrubErrorReport,
  utf8Bytes,
} from "../../packages/runtime-browser/src/error-report.js";
import {
  type BoundaryRecord,
  HOLE_TOKEN,
  type RecordOf,
} from "../../packages/boundary-format/src/index.js";
import {
  parseTraceparent,
  readPageTraceContext,
} from "../../packages/runtime-browser/src/trace-context.js";
import {
  type Browser,
  type Page,
  REPO_ROOT,
  loadPlaywright,
  stopAndDecode,
} from "../boundary/harness.js";

const FIXTURE = path.join(__dirname, "fixtures", "error-report");
const ERROR_REPORT_SRC = path.join(
  REPO_ROOT,
  "packages",
  "runtime-browser",
  "src",
  "error-report.ts",
);

/** What the visitor types into the password field. */
const PASSWORD = "Tr0ub4dor&3-horse";
/** A bearer token the page's error message quotes. */
const TOKEN =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ2aXNpdG9yIn0.c2lnbmF0dXJlLXNpZ24";
/** A card number the rejection's message quotes. */
const CARD = "4111111111111111";
/** A query value of credential shape in the page's URL. */
const URL_TOKEN = "Zk3q9XbT2mWv7LpR4sYd8NcH";

// ── The pieces the e2e cases share ──────────────────────────────────────

/** The Python interpreter with the OpenTelemetry SDK. Throws, naming the shell. */
function otelPython(): string {
  const py = process.env.CT_OTEL_PYTHON;
  if (!py || !fs.existsSync(py)) {
    throw new Error(
      "CT_OTEL_PYTHON is not set: run the tests inside the dev shell " +
        "(`nix develop`), which provides a Python with the OpenTelemetry SDK.",
    );
  }
  return py;
}

/** A mutation of the shipped module: one exact replacement, or the build fails. */
interface Mutation {
  find: string;
  replace: string;
}

/**
 * The page's reporter bundle: `fixtures/error-report/entry.ts` bundled with
 * the shipped `error-report.ts`, or with `mutation` applied to its source
 * (the falsifiers). A mutation whose text is not found exactly once fails the
 * build, so a falsifier can never pass by mutating nothing.
 */
async function buildReporter(
  outfile: string,
  mutation?: Mutation,
): Promise<void> {
  const plugins: esbuild.Plugin[] =
    mutation === undefined
      ? []
      : [
          {
            name: "mutate-error-report",
            setup(build) {
              build.onLoad({ filter: /error-report\.ts$/ }, (args) => {
                if (path.resolve(args.path) !== ERROR_REPORT_SRC)
                  return undefined;
                const src = fs.readFileSync(args.path, "utf8");
                const count = src.split(mutation.find).length - 1;
                if (count !== 1) {
                  throw new Error(
                    `mutation text found ${count} times in error-report.ts, expected once`,
                  );
                }
                return {
                  contents: src.replace(mutation.find, mutation.replace),
                  loader: "ts",
                };
              });
            },
          },
        ];
  await esbuild.build({
    entryPoints: [path.join(FIXTURE, "entry.ts")],
    outfile,
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2020",
    logLevel: "warning",
    plugins,
  });
}

/** One running backend: the fixture server, its span output and its uploads. */
interface Backend {
  origin: string;
  spanFile: string;
  reportFile: string;
  stop(): Promise<void>;
}

async function startBackend(
  dir: string,
  reporterJs: string,
  shimTemplate?: string,
): Promise<Backend> {
  const spanFile = path.join(dir, "spans.jsonl");
  const reportFile = path.join(dir, "reports.jsonl");
  const child: ChildProcess = spawn(
    otelPython(),
    [
      path.join(FIXTURE, "server.py"),
      "--span-file",
      spanFile,
      "--report-file",
      reportFile,
      "--reporter-js",
      reporterJs,
      ...(shimTemplate === undefined ? [] : ["--shim-template", shimTemplate]),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr!.on("data", (d: Buffer) => (stderr += d.toString()));
  const port = await new Promise<number>((resolve, reject) => {
    let out = "";
    const timer = setTimeout(
      () => reject(new Error(`fixture server did not start: ${stderr}`)),
      30_000,
    );
    child.stdout!.on("data", (d: Buffer) => {
      out += d.toString();
      const m = /listening (\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`fixture server exited ${code}: ${stderr}`));
    });
  });
  return {
    origin: `http://127.0.0.1:${port}`,
    spanFile,
    reportFile,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
      }),
  };
}

/** One upload the backend received. */
interface Upload {
  content_type: string | null;
  cookie: string | null;
  authorization: string | null;
  referer: string | null;
  body: string;
}

function readJsonLines<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as T);
}

/** A span as the SDK's `ReadableSpan.to_json` writes it (the fields read here). */
interface ExportedSpan {
  name: string;
  kind: string;
  context: { trace_id: string; span_id: string };
  attributes: Record<string, unknown>;
}

/** The trace and span id of the backend's span for `caseId`, from its own output. */
function backendSpan(
  b: Backend,
  caseId: string,
): { traceId: string; spanId: string } {
  const spans = readJsonLines<ExportedSpan>(b.spanFile).filter(
    (s) => s.attributes["fixture.case"] === caseId,
  );
  expect(spans, `one backend span for case ${caseId}`).toHaveLength(1);
  const hex = (s: string) => s.replace(/^0x/, "").toLowerCase();
  expect(spans[0].kind).toBe("SpanKind.SERVER");
  return {
    traceId: hex(spans[0].context.trace_id),
    spanId: hex(spans[0].context.span_id),
  };
}

/** The uploads whose page URL names `caseId`. */
function uploadsFor(
  b: Backend,
  caseId: string,
): { upload: Upload; report: BrowserErrorReport }[] {
  return readJsonLines<Upload>(b.reportFile)
    .map((upload) => ({
      upload,
      report: JSON.parse(upload.body) as BrowserErrorReport,
    }))
    .filter(
      ({ report }) =>
        new URL(report.page_url).searchParams.get("case") === caseId,
    );
}

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

/** The reporter's status, as the page reads it. */
interface Status {
  state: string;
  reason: string | undefined;
  captured: number;
  sent: number;
  accepted: number;
  declined: number;
  failed: number;
}

/** How a case's page is configured (the fixture server's query). */
interface PageConfig {
  capture?: "on" | "off";
  consent?: "yes" | "promise" | "no" | "none";
  meta?: "on" | "off";
  timing?: "on" | "off";
}

/** How long a case waits for an upload that must not come. */
const NO_UPLOAD_GRACE_MS = 1500;

/**
 * Open the fixture page for `caseId` in a fresh context, with `initScript`
 * run before the page's own scripts, type the password, raise the error by
 * clicking `button`, and return the reporter's status once it settled.
 */
async function runCase(
  browser: Browser,
  b: Backend,
  caseId: string,
  config: PageConfig,
  options: { initScript?: string; button?: "boom" | "reject" } = {},
): Promise<{
  status: Status;
  shown: unknown[];
  page: Page;
  close: () => Promise<void>;
}> {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("pageerror", () => undefined);
  if (options.initScript !== undefined) {
    await page.addInitScript({ content: options.initScript });
  }
  const q = new URLSearchParams({
    case: caseId,
    order: "12345",
    access_token: URL_TOKEN,
    ...(config as Record<string, string>),
  });
  await page.goto(`${b.origin}/page?${q.toString()}`);
  await page.evaluate(
    ([token, card]) => {
      (window as unknown as { __token: string }).__token = token;
      (window as unknown as { __card: string }).__card = card;
    },
    [TOKEN, CARD],
  );
  await page.type("#pw", PASSWORD);
  await page.click(`#${options.button ?? "boom"}`);
  // Let the reporter capture, ask and (if it may) send.
  const settled = async (): Promise<Status> =>
    page.evaluate(() =>
      (
        window as unknown as { __reporter: { status(): Status } }
      ).__reporter.status(),
    );
  const end = Date.now() + 10_000;
  let status = await settled();
  // An unhandled rejection is reported after the click's task, once the
  // microtasks have run (HTML, "notify about rejected promises").
  while (Date.now() < end && status.state === "on" && status.captured === 0) {
    await new Promise((r) => setTimeout(r, 50));
    status = await settled();
  }
  while (
    Date.now() < end &&
    status.state === "on" &&
    status.sent + status.declined + status.failed < status.captured
  ) {
    await new Promise((r) => setTimeout(r, 50));
    status = await settled();
  }
  if (status.sent > 0) {
    const sent = status.sent;
    await waitFor(() => uploadsFor(b, caseId).length >= sent, 10_000);
    // The server writes an upload down before it answers, so the page may
    // not have read the answer yet.
    status = await settled();
    while (Date.now() < end && status.accepted + status.failed < status.sent) {
      await new Promise((r) => setTimeout(r, 50));
      status = await settled();
    }
  }
  const shown = await page.evaluate(
    () => (window as unknown as { __shown: unknown[] }).__shown,
  );
  return { status, shown, page, close: () => context.close() };
}

/** The trace id an upload carries, from its `traceparent`. */
function uploadedTraceId(report: BrowserErrorReport): string | null {
  return parseTraceparent(report.traceparent)?.traceId ?? null;
}

// ── The e2e cases ───────────────────────────────────────────────────────

describe("browser error report (real Chromium, real OpenTelemetry backend)", () => {
  let browser: Browser;
  let dir: string;
  let backend: Backend;
  /** The backends of the falsifiers, each serving a mutated reporter. */
  let scrubberOff: Backend;
  let traceIgnored: Backend;

  beforeAll(async () => {
    browser = await loadPlaywright().chromium.launch({ headless: true });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-error-report-"));
    const sub = (name: string) => {
      const d = path.join(dir, name);
      fs.mkdirSync(d);
      return d;
    };
    const shipped = sub("shipped");
    await buildReporter(path.join(shipped, "reporter.js"));
    backend = await startBackend(shipped, path.join(shipped, "reporter.js"));

    const noScrub = sub("scrubber-off");
    await buildReporter(path.join(noScrub, "reporter.js"), {
      find: "const report = scrubErrorReport(",
      replace:
        "const report = ((r: RawErrorReport, _l: unknown, _h: unknown): BrowserErrorReport => ({" +
        " schema: ERROR_REPORT_SCHEMA, kind: r.kind, error_class: r.errorClass," +
        " message: r.message, frames: r.frames, page_url: r.pageUrl," +
        " traceparent: r.traceparent, occurred_at_unix_ms: r.occurredAtUnixMs }))(",
    });
    scrubberOff = await startBackend(
      noScrub,
      path.join(noScrub, "reporter.js"),
    );

    const noTrace = sub("trace-ignored");
    await buildReporter(path.join(noTrace, "reporter.js"), {
      find: "traceparent: trace?.value ?? null,",
      replace: "traceparent: null,",
    });
    traceIgnored = await startBackend(
      noTrace,
      path.join(noTrace, "reporter.js"),
    );
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await Promise.all(
      [backend, scrubberOff, traceIgnored].map((b) => b?.stop()),
    );
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("e2e_browser_error_report_joins_backend_trace", async () => {
    const run = await runCase(browser, backend, "joins", { consent: "yes" });
    try {
      expect(run.status).toMatchObject({
        state: "on",
        captured: 1,
        sent: 1,
        accepted: 1,
        declined: 0,
        failed: 0,
      });
      const uploads = uploadsFor(backend, "joins");
      expect(uploads).toHaveLength(1);
      const { upload, report } = uploads[0];
      const span = backendSpan(backend, "joins");
      // The join: the upload's trace id is the backend span's, and its
      // parent id is that span, the one that rendered the page.
      expect(uploadedTraceId(report)).toBe(span.traceId);
      expect(parseTraceparent(report.traceparent)?.parentId).toBe(span.spanId);

      expect(report.schema).toBe("codetracer.browser-error-report/1");
      expect(report.kind).toBe("error");
      expect(report.error_class).toBe("Error");
      expect(report.frames.length).toBeGreaterThan(0);
      expect(report.frames[0].url).toBe(
        `${backend.origin}/page?case=joins&order=<scrubbed>&access_token=<scrubbed>&consent=yes`,
      );
      // Scrubbed: the typed password is holed, the bearer token templated,
      // the listed and credential-shaped query values scrubbed.
      expect(report.message).toBe(
        `Uncaught Error: login failed for ${HOLE_TOKEN} with Authorization: <secret>`,
      );
      expect(report.page_url).toBe(report.frames[0].url);
      expect(upload.body).not.toContain(PASSWORD);
      expect(upload.body).not.toContain(TOKEN);
      expect(upload.body).not.toContain(URL_TOKEN);
      expect(upload.body).not.toContain("12345");
      // No credential and no referrer went with the upload.
      expect(upload.cookie).toBeNull();
      expect(upload.authorization).toBeNull();
      expect(upload.referer).toBeNull();
      expect(upload.content_type).toBe("application/json");
      // The page was shown exactly what was sent.
      expect(run.shown).toEqual([report]);
    } finally {
      await run.close();
    }
  });

  it("joins through the Server-Timing header when the page has no meta element", async () => {
    const run = await runCase(browser, backend, "timing", {
      consent: "promise",
      meta: "off",
      timing: "on",
    });
    try {
      expect(run.status).toMatchObject({ sent: 1, accepted: 1 });
      const uploads = uploadsFor(backend, "timing");
      expect(uploads).toHaveLength(1);
      expect(uploadedTraceId(uploads[0].report)).toBe(
        backendSpan(backend, "timing").traceId,
      );
    } finally {
      await run.close();
    }
  });

  it("reports an unhandled rejection, its card number scrubbed", async () => {
    const run = await runCase(
      browser,
      backend,
      "rejection",
      { consent: "yes" },
      { button: "reject" },
    );
    try {
      const uploads = uploadsFor(backend, "rejection");
      expect(uploads).toHaveLength(1);
      const { report, upload } = uploads[0];
      expect(report.kind).toBe("unhandledrejection");
      expect(report.error_class).toBe("TypeError");
      expect(report.message).toBe("payment declined, card <num>");
      expect(upload.body).not.toContain(CARD);
      expect(uploadedTraceId(report)).toBe(
        backendSpan(backend, "rejection").traceId,
      );
    } finally {
      await run.close();
    }
  });

  it("is reported once when the page has no trace context", async () => {
    const run = await runCase(browser, backend, "no-context", {
      consent: "yes",
      meta: "off",
    });
    try {
      const uploads = uploadsFor(backend, "no-context");
      expect(uploads).toHaveLength(1);
      expect(uploads[0].report.traceparent).toBeNull();
    } finally {
      await run.close();
    }
  });

  // ── Negative controls: each the same error, and no upload ─────────────

  const noUpload = async (
    caseId: string,
    config: PageConfig,
    expected: Partial<Status>,
    initScript?: string,
  ): Promise<void> => {
    const run = await runCase(browser, backend, caseId, config, { initScript });
    try {
      expect(run.status).toMatchObject({ sent: 0, ...expected });
      await new Promise((r) => setTimeout(r, NO_UPLOAD_GRACE_MS));
      expect(uploadsFor(backend, caseId)).toHaveLength(0);
      // The page was served and traced: the error happened on a real page.
      backendSpan(backend, caseId);
    } finally {
      await run.close();
    }
  };

  it("control: capture disabled produces no upload", async () => {
    await noUpload(
      "disabled",
      { capture: "off", consent: "yes" },
      { state: "off", reason: "disabled", captured: 0 },
    );
  });

  it("control: consent absent produces no upload", async () => {
    await noUpload(
      "no-consent",
      { consent: "none" },
      { state: "on", captured: 1, declined: 1 },
    );
  });

  it("control: consent refused produces no upload", async () => {
    await noUpload(
      "consent-no",
      { consent: "no" },
      { state: "on", captured: 1, declined: 1 },
    );
  });

  // Chromium has no switch for Do Not Track or Global Privacy Control, so
  // the signal is defined before the page's scripts run, as the browser
  // would present it.
  it("control: Do Not Track produces no upload", async () => {
    await noUpload(
      "dnt",
      { consent: "yes" },
      { state: "off", reason: "dnt", captured: 0 },
      "Object.defineProperty(Navigator.prototype, 'doNotTrack', { get: () => '1', configurable: true });",
    );
  });

  it("control: Global Privacy Control produces no upload", async () => {
    await noUpload(
      "gpc",
      { consent: "yes" },
      { state: "off", reason: "gpc", captured: 0 },
      "Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: () => true, configurable: true });",
    );
  });

  // ── Falsifiers: the mutated reporter must show the defect ─────────────

  it("falsifier: without the scrubber the typed password and the token reach the upload", async () => {
    const run = await runCase(browser, scrubberOff, "leak", { consent: "yes" });
    try {
      const uploads = uploadsFor(scrubberOff, "leak");
      expect(uploads).toHaveLength(1);
      expect(uploads[0].upload.body).toContain(PASSWORD);
      expect(uploads[0].upload.body).toContain(TOKEN);
    } finally {
      await run.close();
    }
  });

  it("falsifier: with the trace context ignored the upload no longer joins the span", async () => {
    const run = await runCase(browser, traceIgnored, "unjoined", {
      consent: "yes",
    });
    try {
      const uploads = uploadsFor(traceIgnored, "unjoined");
      expect(uploads).toHaveLength(1);
      const span = backendSpan(traceIgnored, "unjoined");
      expect(uploadedTraceId(uploads[0].report)).not.toBe(span.traceId);
    } finally {
      await run.close();
    }
  });
});

// ── Units ───────────────────────────────────────────────────────────────

describe("parseTraceparent (W3C Trace Context §3.2)", () => {
  const ok = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

  it("accepts a version-00 header and splits it", () => {
    expect(parseTraceparent(ok)).toEqual({
      value: ok,
      version: "00",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      parentId: "00f067aa0ba902b7",
      flags: "01",
    });
    expect(parseTraceparent(`  ${ok}\t`)?.value).toBe(ok);
  });

  it("refuses what is not a well-formed header", () => {
    for (const bad of [
      undefined,
      null,
      42,
      "",
      ok.toUpperCase(),
      ok.slice(0, 54),
      `${ok}-00`, // version 00 is exactly 55 characters
      "ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
      "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
      "00_4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      "00-4bf92f3577b34da6a3ce929d0e0e473g-00f067aa0ba902b7-01",
      "x".repeat(600),
    ]) {
      expect(parseTraceparent(bad), String(bad)).toBeNull();
    }
  });

  it("reads a later version's first 55 characters when a dash follows them", () => {
    const v1 = "01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    expect(parseTraceparent(v1)?.version).toBe("01");
    expect(parseTraceparent(`${v1}-what-comes-later`)?.value).toBe(v1);
    expect(parseTraceparent(`${v1}x`)).toBeNull();
  });
});

describe("readPageTraceContext", () => {
  const meta = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
  const timing = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
  const doc = (content: string | null) => ({
    querySelector: () =>
      content === null ? null : { getAttribute: () => content },
  });
  const perf = (desc: string | null) => ({
    getEntriesByType: () => [
      {
        serverTiming:
          desc === null
            ? [{ name: "db", description: "" }]
            : [
                { name: "db", description: "" },
                { name: "traceparent", description: desc },
              ],
      },
    ],
  });

  it("prefers the meta element, then the Server-Timing entry", () => {
    expect(readPageTraceContext(doc(meta), perf(timing))).toMatchObject({
      source: "meta",
      value: meta,
    });
    expect(readPageTraceContext(doc(null), perf(timing))).toMatchObject({
      source: "server-timing",
      value: timing,
    });
    expect(readPageTraceContext(doc("garbage"), perf(timing))?.source).toBe(
      "server-timing",
    );
    expect(readPageTraceContext(doc(null), perf(null))).toBeNull();
    expect(readPageTraceContext(undefined, undefined)).toBeNull();
  });

  it("never throws on a document or performance object that does", () => {
    const throwing = {
      querySelector: () => {
        throw new Error("no");
      },
      getEntriesByType: () => {
        throw new Error("no");
      },
    };
    expect(readPageTraceContext(throwing, throwing)).toBeNull();
  });
});

describe("scrubErrorReport", () => {
  const raw: RawErrorReport = {
    kind: "error",
    errorClass: "Error",
    message: `bad input hunter22 api_key=${URL_TOKEN} for a@b.example`,
    frames: [
      {
        url: `https://x.example/app.js?session=${URL_TOKEN}`,
        line: 3,
        col: 7,
        fn: "go hunter22",
      },
    ],
    pageUrl: "https://x.example/p?order=7&q=hunter22#access_token=" + URL_TOKEN,
    traceparent: null,
    occurredAtUnixMs: 1,
  };

  it("holes sensitive values, templates the message and scrubs every URL", () => {
    const r = scrubErrorReport(raw, { headers: [], queryKeys: ["order"] }, [
      "hunter22",
    ]);
    expect(r.message).toBe(
      `bad input ${HOLE_TOKEN} api_key=<secret> for <email>`,
    );
    expect(r.frames[0]).toEqual({
      url: "https://x.example/app.js?session=<scrubbed>",
      line: 3,
      col: 7,
      fn: `go ${HOLE_TOKEN}`,
    });
    expect(r.page_url).toBe(
      `https://x.example/p?order=<scrubbed>&q=${HOLE_TOKEN}#access_token=<scrubbed>`,
    );
    expect(JSON.stringify(r)).not.toContain("hunter22");
  });

  it("keeps an identifier class and replaces anything else by Error", () => {
    const s = (errorClass: string) =>
      scrubErrorReport({ ...raw, errorClass }, { headers: [], queryKeys: [] }, [
        "hunter22",
      ]).error_class;
    expect(s("TypeError")).toBe("TypeError");
    expect(s("App.ValidationError")).toBe("App.ValidationError");
    expect(s("hunter22")).toBe("Error");
    expect(s("not a class")).toBe("Error");
    expect(s("X".repeat(200))).toBe("Error");
  });
});

describe("utf8Bytes (the keepalive budget is counted in bytes)", () => {
  it("counts what TextEncoder encodes", () => {
    for (const text of [
      "",
      "ascii",
      "é",
      "€".repeat(30_000),
      "😀",
      "lone \ud800 surrogate",
      "\udc00 trailing",
    ]) {
      expect(utf8Bytes(text), JSON.stringify(text)).toBe(
        new TextEncoder().encode(text).byteLength,
      );
    }
  });
});

// ── The boundary shim's Env.traceparent ─────────────────────────────────

/**
 * The page the boundary shim is installed into (by the shipped injector,
 * as a site's deploy step installs it). Its trace-context element comes
 * before its encoding declaration, so the bootstrap, which follows a
 * declaration that only inert elements precede, comes after it: the
 * element is in the document when the shim reads `Env`. The fixture server
 * fills (or, with `meta=off`, removes) it per request. The page also runs
 * the error reporter, always consenting, and throws on a click.
 */
const SHIM_TEMPLATE = `<!doctype html>
<html>
<head>
<meta name="traceparent" content="__CT_TRACEPARENT__">
<meta charset="utf-8">
<title>boundary Env fixture</title>
<script src="/reporter.js"></script>
<script>
  window.__reporter = CtErrorReporter.installErrorReporter({
    enabled: true,
    endpoint: "/reports",
    consent: function () { return true; },
  });
</script>
</head>
<body>
<button id="boom">boom</button>
<script>
  document.getElementById("boom").addEventListener("click", function () {
    throw new Error("boom");
  });
</script>
</body>
</html>
`;

/**
 * The shim's bundle, built as `scripts/bundle.mjs` builds it from the
 * compiled package, with the `Env` record's trace-context read replaced by
 * one that finds nothing. The mutation's text must be found exactly once, so
 * the falsifier can never pass by mutating nothing.
 */
async function shimWithoutTraceContext(): Promise<string> {
  const find = "traceparent: (0, trace_context_js_1.readPageTraceContext)(";
  const install = path.join(
    REPO_ROOT,
    "packages/boundary-shim/dist/browser/install.js",
  );
  const r = await esbuild.build({
    entryPoints: [
      path.join(REPO_ROOT, "packages/boundary-shim/dist/browser/entry.js"),
    ],
    write: false,
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2020",
    keepNames: true,
    legalComments: "none",
    charset: "utf8",
    logLevel: "warning",
    plugins: [
      {
        name: "blind-env-traceparent",
        setup(build) {
          build.onLoad({ filter: /install\.js$/ }, (args) => {
            if (path.resolve(args.path) !== install) return undefined;
            const src = fs.readFileSync(args.path, "utf8");
            const count = src.split(find).length - 1;
            if (count !== 1) {
              throw new Error(
                `mutation text found ${count} times in install.js, expected once`,
              );
            }
            return {
              contents: src.replace(
                find,
                "traceparent: ((..._ignored) => null)(",
              ),
              loader: "js",
            };
          });
        },
      },
    ],
  });
  return r.outputFiles[0].text;
}

/** Write the shimmed template (with `bundleSource`, a mutated shim) to `dir`. */
function writeShimTemplate(dir: string, bundleSource?: string): string {
  const file = path.join(dir, "shim-page.html");
  const html = injectBoundaryShim(
    SHIM_TEMPLATE,
    {},
    bundleSource === undefined ? {} : { bundleSource },
  );
  // Vacuity guard: the trace-context element precedes the bootstrap.
  const meta = html.indexOf('<meta name="traceparent"');
  const bootstrap = html.indexOf(`<script ${BOOTSTRAP_MARKER}`);
  if (meta < 0 || bootstrap < 0 || meta > bootstrap) {
    throw new Error("the shim's bootstrap does not follow the trace context");
  }
  fs.writeFileSync(file, html);
  return file;
}

describe("the boundary shim's Env.traceparent (real Chromium, real OpenTelemetry backend)", () => {
  let browser: Browser;
  let dir: string;
  let backend: Backend;
  /** Serves a shim whose trace-context reader is removed. */
  let shimBlind: Backend;
  /** Serves a reporter that reads the page's (patched) timeline. */
  let reporterPatched: Backend;

  beforeAll(async () => {
    browser = await loadPlaywright().chromium.launch({ headless: true });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-env-traceparent-"));
    const sub = (name: string) => {
      const d = path.join(dir, name);
      fs.mkdirSync(d);
      return d;
    };
    const shipped = sub("shipped");
    await buildReporter(path.join(shipped, "reporter.js"));
    backend = await startBackend(
      shipped,
      path.join(shipped, "reporter.js"),
      writeShimTemplate(shipped),
    );

    const blind = sub("shim-blind");
    await buildReporter(path.join(blind, "reporter.js"));
    shimBlind = await startBackend(
      blind,
      path.join(blind, "reporter.js"),
      writeShimTemplate(blind, await shimWithoutTraceContext()),
    );

    const patched = sub("reporter-patched");
    await buildReporter(path.join(patched, "reporter.js"), {
      find: "timelineThrough(w.performance, orig.getEntriesByType)",
      replace:
        "w.performance as unknown as Parameters<typeof readPageTraceContext>[1]",
    });
    reporterPatched = await startBackend(
      patched,
      path.join(patched, "reporter.js"),
      writeShimTemplate(patched),
    );
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await Promise.all(
      [backend, shimBlind, reporterPatched].map((b) => b?.stop()),
    );
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Record the shim page for `caseId` (clicking `#boom` when `boom`),
   * stop the session and return its records.
   */
  async function recordShimPage(
    b: Backend,
    caseId: string,
    query: Record<string, string>,
    boom = false,
  ): Promise<BoundaryRecord[]> {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      page.on("pageerror", () => undefined);
      const q = new URLSearchParams({ case: caseId, ...query });
      await page.goto(`${b.origin}/shim-page?${q.toString()}`);
      if (boom) {
        await page.click("#boom");
        expect(
          await waitFor(() => uploadsFor(b, caseId).length === 1, 10_000),
          "the reporter's upload",
        ).toBe(true);
      }
      return (await stopAndDecode(page)).records;
    } finally {
      await context.close();
    }
  }

  function envOf(records: BoundaryRecord[]): RecordOf<"Env"> {
    const env = records.find((r): r is RecordOf<"Env"> => r.record === "Env");
    expect(env, "the log's Env record").toBeDefined();
    return env!;
  }

  /** The `PlatformValue` records of reads of the navigation entry. */
  function navigationReads(records: BoundaryRecord[]): BoundaryRecord[] {
    return records.filter(
      (r) =>
        r.record === "PlatformValue" &&
        (r as RecordOf<"PlatformValue">).query.startsWith("getEntriesByType"),
    );
  }

  it("shim_env_traceparent_joins_backend_trace_by_meta", async () => {
    const records = await recordShimPage(backend, "env-meta", {});
    const env = envOf(records);
    const span = backendSpan(backend, "env-meta");
    const parsed = parseTraceparent(env.traceparent);
    expect(parsed?.traceId).toBe(span.traceId);
    expect(parsed?.parentId).toBe(span.spanId);
  });

  it("shim_env_traceparent_joins_backend_trace_by_server_timing", async () => {
    const records = await recordShimPage(
      backend,
      "env-timing",
      { meta: "off", timing: "on" },
      true,
    );
    const span = backendSpan(backend, "env-timing");
    expect(parseTraceparent(envOf(records).traceparent)?.traceId).toBe(
      span.traceId,
    );
    // The reporter on the same page joins too, and its read of the
    // navigation entry is not logged as the page's.
    const uploads = uploadsFor(backend, "env-timing");
    expect(uploadedTraceId(uploads[0].report)).toBe(span.traceId);
    expect(records.some((r) => r.record === "Error")).toBe(true);
    expect(navigationReads(records)).toEqual([]);
  });

  it("shim_env_traceparent_is_empty_for_a_malformed_or_absent_one", async () => {
    const bad = await recordShimPage(backend, "env-bad", {
      timing: "on",
      bad: "on",
    });
    expect(envOf(bad).traceparent).toBe("");
    backendSpan(backend, "env-bad");
    const none = await recordShimPage(backend, "env-none", { meta: "off" });
    expect(envOf(none).traceparent).toBe("");
  });

  it("falsifier: a shim without the reader writes no trace context", async () => {
    const records = await recordShimPage(shimBlind, "env-blind", {
      timing: "on",
    });
    backendSpan(shimBlind, "env-blind");
    expect(envOf(records).traceparent).toBe("");
  });

  it("falsifier: a reporter reading the patched timeline is logged as the page", async () => {
    const records = await recordShimPage(
      reporterPatched,
      "env-patched",
      { meta: "off", timing: "on" },
      true,
    );
    expect(navigationReads(records).length).toBeGreaterThan(0);
  });
});

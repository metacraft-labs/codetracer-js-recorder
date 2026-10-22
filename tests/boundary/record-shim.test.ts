/**
 * The generic boundary shim (`@codetracer/boundary-shim`) in record mode,
 * in real headless Chromium, on fixture pages served by a
 * real local HTTP server (CodeTracer's JS-Boundary-Recording specification,
 * §6, §7.3, §7.5, §10).
 *
 * The shim is installed by the shipped route, the `codetracer-js-recorder
 * boundary-shim` CLI step run over a copy of `tests/boundary/fixtures/`, and
 * every log is decoded by the strict `@codetracer/boundary-format` decoder.
 *
 * No mocks. Three things are installed into the page by the test with
 * `addInitScript`, each a page-side instrument rather than a stand-in for
 * the system under test, and each justified where it is used:
 *   - `counting-layer.js`, the page's own count of its reads, kept beneath
 *     the shim (the counts the log is compared with);
 *   - `seeded-random.js` and Playwright's clock, which pin the page's random
 *     values and time identically in both arms of the behaviour comparison;
 *   - the `dom-v1` serialiser (the shim's own, bundled alone) in the arm
 *     that has no shim, so both arms hash the DOM with one function.
 */

import * as esbuild from "esbuild";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type DecodedLog,
  decodeLog,
} from "../../packages/boundary-format/src/index.js";
import {
  BUNDLE_PATH,
  injectBoundaryShimIntoFiles,
  htmlFilesUnder,
} from "../../packages/boundary-shim/src/index.js";
import {
  type Browser,
  type FixtureServer,
  type Page,
  FIXTURES,
  FIXTURE_BUILD_HASH,
  REPO_ROOT,
  copyFixtures,
  loadPlaywright,
  readLog,
  recordsOf,
  shimmedFixtures,
  sleep,
  startFixtureServer,
  stopAndDecode,
  waitForDone,
} from "./harness.js";

const TIMEOUT = 60_000;

let browser: Browser;
/** The fixture pages with the shim installed by the CLI step. */
let shimDir: string;
/** Scripts the test builds and serves under `/__generated/`. */
let generatedDir: string;
/** The `dom-v1` serialiser bundled alone: defines `CtDomV1.domV1Hash`. */
let domV1Source: string;
const servers: FixtureServer[] = [];
const tmpDirs: string[] = [];

beforeAll(async () => {
  browser = await loadPlaywright().chromium.launch({ headless: true });
  shimDir = shimmedFixtures();
  generatedDir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-boundary-gen-"));
  tmpDirs.push(shimDir, generatedDir);
  // The browser `__ct` runtime as an instrumented page loads it.
  await esbuild.build({
    entryPoints: [
      path.join(REPO_ROOT, "packages/runtime-browser/dist/index.js"),
    ],
    outfile: path.join(generatedDir, "runtime-browser.js"),
    bundle: true,
    format: "iife",
    globalName: "CtRuntimeBrowser",
    platform: "browser",
    target: "es2020",
    logLevel: "warning",
  });
  const domV1 = await esbuild.build({
    entryPoints: [
      path.join(REPO_ROOT, "packages/boundary-shim/src/browser/dom-v1.ts"),
    ],
    write: false,
    bundle: true,
    format: "iife",
    globalName: "CtDomV1",
    platform: "browser",
    target: "es2020",
    logLevel: "warning",
  });
  domV1Source = domV1.outputFiles[0].text;
  // The third `__ct` implementation: the bootstrap stub the CLI writes for
  // `instrument --browser`, served as /__generated/stub/codetracer-runtime.js.
  const stubSrc = path.join(generatedDir, "stub-src");
  fs.mkdirSync(stubSrc);
  fs.writeFileSync(path.join(stubSrc, "app.js"), "var x = 1;\n");
  execFileSync(
    process.execPath,
    [
      path.join(REPO_ROOT, "packages/cli/dist/index.js"),
      "instrument",
      stubSrc,
      "--out",
      path.join(generatedDir, "stub"),
      "--browser",
    ],
    { stdio: "pipe" },
  );
}, TIMEOUT);

afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
  await browser?.close();
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

async function serve(root: string): Promise<FixtureServer> {
  const s = await startFixtureServer(root, generatedDir);
  servers.push(s);
  return s;
}

/** A fresh page (own context, so own storage) with `initScripts` installed. */
async function newPage(
  initScripts: string[],
): Promise<{ page: Page; pageErrors: Error[] }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors: Error[] = [];
  page.on("pageerror", (e) => pageErrors.push(e));
  for (const s of initScripts) {
    await page.addInitScript({ path: path.join(FIXTURES, s) });
  }
  return { page, pageErrors };
}

type Counts = Record<string, number> & { enabled: boolean };

async function pageCounts(page: Page): Promise<Counts> {
  return page.evaluate(() => ({
    ...(globalThis as unknown as { __pageCounts: Counts }).__pageCounts,
  }));
}

async function pageErrorCounters(
  page: Page,
): Promise<{ error: number; rejection: number }> {
  return page.evaluate(
    () =>
      (
        globalThis as unknown as {
          __errors: { error: number; rejection: number };
        }
      ).__errors,
  );
}

async function slots(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const out: Record<string, string> = {};
    for (const li of Array.from(document.querySelectorAll("#out li"))) {
      out[li.id] = li.textContent ?? "";
    }
    return out;
  });
}

/** Every `seq`-bearing record's seq, in order. */
function seqs(log: DecodedLog): bigint[] {
  return log.records.flatMap((r) => ("seq" in r ? [r.seq] : []));
}

/** The type the shim's typing and checkbox produce in every test. */
async function typeAndCheck(page: Page): Promise<void> {
  await page.click("#form input[name=q]");
  await page.type("#form input[name=q]", "ab");
  await page.click("#form input[name=agree]");
}

describe("record-side generic boundary shim", () => {
  it(
    "jsbound_shim_logs_every_boundary_read_once",
    async () => {
      const server = await serve(shimDir);
      const { page, pageErrors } = await newPage(["counting-layer.js"]);
      await page.goto(`${server.origin}/reads.html`);
      await page.click("#go");
      await waitForDone(page);
      await typeAndCheck(page);
      const counts = await pageCounts(page);
      const log = await stopAndDecode(page);

      expect(pageErrors).toEqual([]);
      expect(log.termination).toBe("Complete");
      expect(log.records[0]).toMatchObject({
        record: "Header",
        protocol_level: 0,
        recorder_id: "codetracer-boundary-shim/0.1.0",
        build_hash: FIXTURE_BUILD_HASH,
      });

      // Each of the ten kinds (and the event clock), as the page counted it
      // and as the log has it.
      // fetch and XHR are the network kind, counted per API.
      const table: [string, number, number][] = [
        [
          "Date.now (Clock src 1)",
          counts.dateNow,
          recordsOf(log, "Clock", (r) => r.src === 1).length,
        ],
        [
          "performance.now (Clock src 2)",
          counts.performanceNow,
          recordsOf(log, "Clock", (r) => r.src === 2).length,
        ],
        [
          "Math.random (Random src 1)",
          counts.mathRandom,
          recordsOf(log, "Random", (r) => r.src === 1).length,
        ],
        [
          "crypto.getRandomValues (Random src 2)",
          counts.getRandomValues,
          recordsOf(log, "Random", (r) => r.src === 2).length,
        ],
        [
          "fetch (NetRequest api 1)",
          counts.fetch,
          recordsOf(log, "NetRequest", (r) => r.api === 1).length,
        ],
        [
          "XMLHttpRequest (NetRequest api 2)",
          counts.xhr,
          recordsOf(log, "NetRequest", (r) => r.api === 2).length,
        ],
        [
          "setTimeout (TaskReg kind 1)",
          counts.setTimeout,
          recordsOf(log, "TaskReg", (r) => r.kind === 1).length,
        ],
        [
          "setInterval (TaskReg kind 2)",
          counts.setInterval,
          recordsOf(log, "TaskReg", (r) => r.kind === 2).length,
        ],
        [
          "requestAnimationFrame (TaskReg kind 3)",
          counts.requestAnimationFrame,
          recordsOf(log, "TaskReg", (r) => r.kind === 3).length,
        ],
        [
          "localStorage.getItem (StorageRead area 1)",
          counts.localStorage,
          recordsOf(log, "StorageRead", (r) => r.area === 1).length,
        ],
        [
          "event.timeStamp (Clock src 5)",
          counts.timeStamp,
          recordsOf(log, "Clock", (r) => r.src === 5).length,
        ],
        [
          "getBoundingClientRect (LayoutRead)",
          counts.getBoundingClientRect,
          recordsOf(
            log,
            "LayoutRead",
            (r) => r.prop === "getBoundingClientRect",
          ).length,
        ],
      ];
      // Vacuity guard: the page's counters ran, and every kind was read.
      expect(counts.enabled).toBe(true);
      const unread = table.filter(([, page]) => page < 1).map(([k]) => k);
      expect(unread, "kinds the page never read").toEqual([]);
      const mismatched = table
        .filter(([, page, logged]) => page !== logged)
        .map(([k, page, logged]) => `${k}: page ${page}, log ${logged}`);
      expect(
        mismatched,
        "reads whose log count differs from the page's",
      ).toEqual([]);

      // Every request completed, and its completion is a Task then the response.
      const requests = recordsOf(log, "NetRequest");
      const responses = recordsOf(log, "NetResponse");
      expect(responses.map((r) => r.req_id).sort()).toEqual(
        requests.map((r) => r.req_id).sort(),
      );
      for (const resp of responses) {
        const i = log.records.indexOf(resp);
        expect(log.records[i - 1]).toMatchObject({ record: "Task", kind: 4 });
      }
      // The interval fired twice, each run preceded by its Task.
      const interval = recordsOf(log, "TaskReg", (r) => r.kind === 2)[0];
      expect(
        recordsOf(log, "Task", (r) => r.task_id === interval.task_id).length,
      ).toBe(2);

      // seq runs 1..N with no gap, and End closes it at N.
      const s = seqs(log);
      expect(s.length).toBeGreaterThan(0);
      expect(s).toEqual(s.map((_, i) => BigInt(i + 1)));
      expect(recordsOf(log, "Gap")).toEqual([]);
      const end = log.records[log.records.length - 1];
      expect(end).toMatchObject({
        record: "End",
        last_seq: BigInt(s.length),
        reason: 2,
      });

      // Input with structural targets (§10.2) and the default actions'
      // DomEffects before it (§9.5).
      const inputs = recordsOf(log, "Input");
      expect(
        inputs.some((r) => r.type === "click" && r.target === "path:#go"),
      ).toBe(true);
      // Typing "ab" is two `input` events; clicking the checkbox then blurs
      // the text field, which fires its `change`.
      const typed = recordsOf(log, "DomEffect", (r) => r.effect === 1).map(
        (r) => {
          const i = log.records.indexOf(r);
          const input = log.records.slice(i).find((x) => x.record === "Input");
          return [r.target, r.value, input?.record === "Input" && input.type];
        },
      );
      expect(typed).toEqual([
        ["path:#form>input:0", '"a"', "input"],
        ["path:#form>input:0", '"ab"', "input"],
        ["path:#form>input:0", '"ab"', "change"],
      ]);
      expect(
        recordsOf(log, "DomEffect", (r) => r.effect === 2).map((r) => [
          r.target,
          r.value,
        ]),
      ).toContainEqual(["path:#form>input:1", "true"]);
      for (const e of recordsOf(log, "DomEffect")) {
        const i = log.records.indexOf(e);
        const next = log.records
          .slice(i + 1)
          .find((r) => r.record !== "DomEffect");
        expect(next).toMatchObject({ record: "Task", kind: 5 });
      }

      // dom-v1 checkpoints; the last describes the final document.
      const checkpoints = recordsOf(log, "Checkpoint");
      expect(checkpoints.length).toBeGreaterThan(0);
      expect(checkpoints.map((c) => c.ordinal)).toEqual(
        checkpoints.map((_, i) => i),
      );
      expect(new Set(checkpoints.map((c) => c.scheme))).toEqual(
        new Set(["dom-v1"]),
      );
      const finalHash = await page.evaluate(() =>
        (
          globalThis as unknown as { __ctBoundaryShim: { domV1Hash(): string } }
        ).__ctBoundaryShim.domV1Hash(),
      );
      expect(checkpoints[checkpoints.length - 1].state_hash).toBe(finalHash);
    },
    TIMEOUT,
  );

  it(
    "jsbound_shim_does_not_change_page_behaviour",
    async () => {
      const PINNED = Date.UTC(2026, 0, 2, 3, 4, 5);

      /** One arm: the interaction with time and randomness pinned. */
      async function arm(root: string) {
        const server = await serve(root);
        const { page, pageErrors } = await newPage(["seeded-random.js"]);
        await page.clock.install({ time: PINNED });
        await page.goto(`${server.origin}/reads.html`);
        await page.clock.pauseAt(PINNED + 5000);
        await page.click("#go");
        await waitForDone(page, () => page.clock.runFor(50));
        await typeAndCheck(page);
        await page.clock.runFor(1000);
        const hash = await page.evaluate(
          (src: string) =>
            (
              (0, eval)(`${src}; CtDomV1`) as {
                domV1Hash(d: Document): string;
              }
            ).domV1Hash(document),
          domV1Source,
        );
        const shimmed = await page.evaluate(
          () => "__ctBoundaryShim" in globalThis,
        );
        const recorded = shimmed
          ? decodeLog(await readLog(page)).records.length
          : 0;
        const requests = server.requests
          // Chromium may or may not ask for a favicon before the arm ends;
          // it is not the page's request.
          .filter((r) => r.url !== "/favicon.ico")
          .map((r) => `${r.method} ${r.url} ${JSON.stringify(r.body)}`)
          .sort();
        return {
          hash,
          requests,
          shimmed,
          recorded,
          pageErrors,
          slots: await slots(page),
        };
      }

      const plain = await arm(copyFixtureDir());
      const shimmed = await arm(shimDir);

      // Negative control: a deliberately broken shim build, whose
      // Math.random returns a constant once it has installed, installed by
      // the same injection, makes the DOM differ: the comparison can fail.
      const brokenDir = copyFixtureDir();
      const broken =
        fs.readFileSync(BUNDLE_PATH, "utf-8") +
        "\n;Math.random = function random() { return 0.5; };\n";
      injectBoundaryShimIntoFiles(
        htmlFilesUnder(brokenDir),
        {},
        { bundleSource: broken },
      );
      const control = await arm(brokenDir);

      // The arms are what they claim to be.
      expect(plain.shimmed).toBe(false);
      expect(shimmed.shimmed).toBe(true);
      expect(control.shimmed).toBe(true);
      expect(shimmed.recorded).toBeGreaterThan(10);
      for (const a of [plain, shimmed, control]) {
        expect(a.pageErrors).toEqual([]);
        expect(a.requests).toContain('GET /api/data?x=1 ""');
        expect(a.requests).toContain('POST /api/echo "hello"');
      }
      expect(plain.slots["r-now"]).toBe(`now=${PINNED + 5000}`);
      expect(plain.slots["r-xhrctor"]).toBe("xhrctor=sub,TypeError");

      expect(shimmed.slots).toEqual(plain.slots);
      expect(shimmed.hash).toBe(plain.hash);
      expect(shimmed.requests).toEqual(plain.requests);

      expect(control.hash, "the broken build changes the dom-v1 hash").not.toBe(
        plain.hash,
      );
      expect(control.slots["r-rand"]).toBe("rand=0.5");
    },
    TIMEOUT,
  );

  it(
    "jsbound_shim_never_throws_into_page",
    async () => {
      const server = await serve(shimDir);
      const { page, pageErrors } = await newPage(["counting-layer.js"]);
      await page.goto(`${server.origin}/reads.html`);
      await typeAndCheck(page);
      await page.evaluate(() =>
        (
          globalThis as unknown as {
            __ctBoundaryShim: { injectEncoderFault(): void };
          }
        ).__ctBoundaryShim.injectEncoderFault(),
      );
      // Everything written up to the fault; the next record fails to encode.
      const beforeFault = decodeLog(await readLog(page));
      expect(beforeFault.records.length).toBeGreaterThan(2);
      const countsBefore = await pageCounts(page);
      // The interaction goes on: every read kind, timers, network, input.
      await page.click("#go");
      await waitForDone(page);
      await page.type("#form input[name=q]", "cd");
      const countsAfter = await pageCounts(page);

      // The page saw nothing: no error, no rejection, every result in place.
      expect(pageErrors).toEqual([]);
      expect(await pageErrorCounters(page)).toEqual({ error: 0, rejection: 0 });
      const s = await slots(page);
      expect(s["r-fetch"]).toBe("fetch=42");
      expect(s["r-xhr"]).toBe("xhr=hello");
      expect(s["r-tick"]).toBe("tick=2");
      expect(s["r-raf"]).toBe("raf=number");
      // Vacuity: the page really made reads after the fault.
      expect(countsAfter.dateNow).toBeGreaterThan(countsBefore.dateNow);
      expect(countsAfter.fetch).toBeGreaterThan(countsBefore.fetch);

      // The log: what was written before, then the refusal, then nothing,
      // even after stop().
      const log = decodeLog(await readLog(page));
      expect(log.records.slice(0, beforeFault.records.length)).toEqual(
        beforeFault.records,
      );
      const last = log.records[log.records.length - 1];
      expect(last).toMatchObject({
        record: "Refusal",
        feature: "recorder-fault",
      });
      expect(last.record === "Refusal" && last.detail).toContain(
        "injected encoder fault",
      );
      expect(log.records.length).toBe(beforeFault.records.length + 1);
      expect(log.termination).toBe("TruncatedUnterminated");
      const atFault = await readLog(page);
      await page.evaluate(() =>
        (
          globalThis as unknown as { __ctBoundaryShim: { stop(): void } }
        ).__ctBoundaryShim.stop(),
      );
      expect(Array.from(await readLog(page))).toEqual(Array.from(atFault));
    },
    TIMEOUT,
  );

  it(
    "jsbound_shim_refuses_out_of_scope_features",
    async () => {
      const server = await serve(shimDir);
      const { page, pageErrors } = await newPage([]);
      await page.goto(`${server.origin}/refused.html`);
      await page.click("#go");
      await waitForDone(page);
      const s = await slots(page);
      const log = await stopAndDecode(page);

      // The page kept working: each feature, used twice, did its job.
      expect(pageErrors).toEqual([]);
      expect(await pageErrorCounters(page)).toEqual({ error: 0, rejection: 0 });
      expect(s).toEqual({
        "r-worker": "worker=84",
        "r-wasm": "wasm=14",
        "r-broadcast": "broadcast=hello",
        "r-idb": "idb=2",
        "r-weakref": "weakref=14",
        "r-finalization": "finalization=registered",
      });

      // One Refusal per feature, named.
      expect(log.termination).toBe("Complete");
      const refused = recordsOf(log, "Refusal")
        .map((r) => r.feature)
        .sort();
      expect(refused).toEqual(
        [
          "broadcast-channel",
          "finalization-registry",
          "indexeddb",
          "weakref",
          "webassembly",
          "worker",
        ].sort(),
      );
    },
    TIMEOUT,
  );

  it(
    "jsbound_ct_runtime_uses_captured_originals",
    async () => {
      const server = await serve(shimDir);
      const { page, pageErrors } = await newPage(["counting-layer.js"]);
      await page.goto(`${server.origin}/ct-runtime.html`);
      // Long enough for the runtime's 20 ms flush deadline to fire and for
      // its socket to the (non-upgrading) fixture server to fail.
      await sleep(500);
      const counts = await pageCounts(page);
      const status = await page.evaluate(
        () => document.getElementById("status")?.textContent,
      );
      const log = await stopAndDecode(page);

      expect(pageErrors).toEqual([]);
      // Vacuity: the runtime ran, armed its flush timer and opened its
      // socket, all through the platform functions the counting layer
      // wraps.
      expect(status).toBe("running");
      expect(counts.enabled).toBe(true);
      expect(counts.setTimeout).toBeGreaterThan(0);
      expect(counts.webSocket).toBeGreaterThan(0);
      expect(log.termination).toBe("Complete");

      // None of it reached the recorded page: no timer was registered, no
      // request made, and the only tasks are the browser's input events
      // (headless Chromium dispatches a pointerover at load).
      for (const kind of [
        "TaskReg",
        "NetRequest",
        "NetResponse",
        "WsMessage",
        "Refusal",
      ] as const) {
        expect(
          recordsOf(log, kind).map((r) => r.record),
          kind,
        ).toEqual([]);
      }
      expect(
        recordsOf(log, "Task", (t) => t.kind !== 5).map((t) => t.kind),
        "non-input tasks",
      ).toEqual([]);
    },
    TIMEOUT,
  );

  // Not a named verification entry of the plan: the same property for the
  // CLI's inlined browser stub (`instrument --browser`), the other browser
  // `__ct` implementation, which opens its daemon socket while it loads.
  it(
    "the instrument --browser stub opens its socket through the captured originals",
    async () => {
      const server = await serve(shimDir);
      const { page, pageErrors } = await newPage(["counting-layer.js"]);
      await page.goto(`${server.origin}/ct-stub.html`);
      // Long enough for the socket to the (non-upgrading) fixture server to
      // fail, so a socket the shim had wrapped would have logged its error.
      await sleep(500);
      const counts = await pageCounts(page);
      const status = await page.evaluate(
        () => document.getElementById("status")?.textContent,
      );
      const log = await stopAndDecode(page);

      expect(pageErrors).toEqual([]);
      // Vacuity: the stub ran and constructed its socket through the
      // WebSocket the counting layer wraps.
      expect(status).toBe("running");
      expect(counts.enabled).toBe(true);
      expect(counts.webSocket).toBeGreaterThan(0);
      expect(log.termination).toBe("Complete");

      for (const kind of [
        "TaskReg",
        "NetRequest",
        "NetResponse",
        "WsMessage",
        "Refusal",
      ] as const) {
        expect(
          recordsOf(log, kind).map((r) => r.record),
          kind,
        ).toEqual([]);
      }
      expect(
        recordsOf(log, "Task", (t) => t.kind !== 5).map((t) => t.kind),
        "non-input tasks",
      ).toEqual([]);
    },
    TIMEOUT,
  );

  // Not a named verification entry of the plan: it checks the "dom-v1
  // checkpoints" deliverable against §7.3's cadence, with an oracle written
  // from the spec's sentence rather than from the recorder's code.
  it(
    "the shim checkpoints at quiescent points at the cadence of §7.3",
    async () => {
      const START = Date.UTC(2026, 0, 2, 3, 4, 5);
      const server = await serve(shimDir);
      const { page, pageErrors } = await newPage([]);
      await page.clock.install({ time: START });
      await page.goto(`${server.origin}/cadence.html`);
      await page.clock.pauseAt(START + 1000);
      await page.click("#go");
      await waitForDone(page, () => page.clock.runFor(100));
      const log = await stopAndDecode(page);
      expect(pageErrors).toEqual([]);
      expect(log.termination).toBe("Complete");

      // §7.3: at a quiescent point (the start of a macrotask: its Task
      // record, or the DomEffects an input's Task follows), at most once
      // there, and whenever 256 records or 2 s of recorded time have passed
      // since the last checkpoint.
      const isTaskStart = (i: number): boolean => {
        const r = log.records[i];
        if (r.record === "Task")
          return log.records[i - 1]?.record !== "DomEffect";
        return (
          r.record === "DomEffect" && log.records[i - 1]?.record !== "DomEffect"
        );
      };
      let since = 0;
      let wallAt: number | undefined;
      let wallNow: number | undefined;
      let monoAt: number | undefined;
      let monoNow: number | undefined;
      const byCount: number[] = [];
      const byTime: number[] = [];
      const violations: string[] = [];
      log.records.forEach((r, i) => {
        if (!("seq" in r)) return;
        if (r.record === "Checkpoint") {
          const due =
            since >= 256 ||
            (wallAt !== undefined && wallNow! - wallAt >= 2000) ||
            (monoAt !== undefined && monoNow! - monoAt >= 2000);
          const atStart = i + 1 < log.records.length && isTaskStart(i + 1);
          const atEnd = log.records[i + 1]?.record === "End";
          if (!atStart && !atEnd)
            violations.push(
              `checkpoint at seq ${r.seq} is not at a task boundary`,
            );
          if (!due && !atEnd)
            violations.push(`checkpoint at seq ${r.seq} was not due`);
          if (since >= 256) byCount.push(Number(r.seq));
          else if (due) byTime.push(Number(r.seq));
          since = 0;
          wallAt = wallNow;
          monoAt = monoNow;
          return;
        }
        if (isTaskStart(i)) {
          const due =
            since >= 256 ||
            (wallAt !== undefined && wallNow! - wallAt >= 2000) ||
            (monoAt !== undefined && monoNow! - monoAt >= 2000);
          if (due)
            violations.push(`no checkpoint before the task at seq ${r.seq}`);
        }
        since += 1;
        if (r.record === "Clock") {
          const v = new DataView(new ArrayBuffer(8));
          v.setBigUint64(0, r.bits, true);
          const value = v.getFloat64(0, true);
          // §7.3: wall clock from src 1 and 3, monotonic from 2 and 4.
          if (r.src === 1 || r.src === 3) {
            wallNow = value;
            wallAt ??= value;
          } else if (r.src === 2 || r.src === 4) {
            monoNow = value;
            monoAt ??= value;
          }
        }
      });
      expect(violations).toEqual([]);
      // Both triggers fired, so the check above was not vacuous.
      expect(byCount.length, "checkpoints due by record count").toBeGreaterThan(
        0,
      );
      expect(byTime.length, "checkpoints due by recorded time").toBeGreaterThan(
        0,
      );
      const hashes = recordsOf(log, "Checkpoint").map((c) => c.state_hash);
      expect(new Set(hashes).size).toBe(hashes.length);
    },
    TIMEOUT,
  );
});

/** A fresh, unshimmed copy of the fixtures (removed after the run). */
function copyFixtureDir(): string {
  const d = copyFixtures();
  tmpDirs.push(d);
  return d;
}

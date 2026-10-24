/**
 * The replay runner (`@codetracer/boundary-replay`, CodeTracer's
 * JS-Boundary-Recording specification §6, §7, §9.7, §12) and the replay leg
 * of the cooperation protocol's conformance suite (§9.9).
 *
 * A session is recorded once, for real: `fixtures/replay.html` served by
 * the fixture server, the generic shim installed by the shipped deploy route
 * (`codetracer-js-recorder bundle-manifest`, then `boundary-shim
 * --build-hash`), driven in headless Chromium, its log read through the
 * shim's control surface and assembled into a `.ct` by codetracer's real
 * `ct-jsbound assemble`. The runner replays that `.ct` against the same
 * build in headless Chromium, instruments the build itself and writes the
 * materialised trace through codetracer's real `record-web` host
 * (`session-manager record-web`); the trace is read back with `ct-print`,
 * the JS recorder's existing reader. Seeded edits of the recorded records
 * are assembled the same way (a `Gap` by leaving a batch out, since only
 * the assembler writes one).
 *
 * No mocks. The binaries come from the sibling checkouts: `session-manager`
 * (`cargo build --bin session-manager` in codetracer/src/backend-manager)
 * and `ct-jsbound` (`cargo build --bin ct-jsbound` in
 * codetracer/libs/jsbound), or from `CODETRACER_SESSION_MANAGER` and
 * `CT_JSBOUND`; `ct-print` as the other trace tests find it. Without one
 * the tests fail, naming the build command, rather than skip.
 */

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type BoundaryRecord,
  decodeLog,
  encodeBatch,
  encodeFrame,
  seqOf,
} from "../../packages/boundary-format/src/index.js";
import {
  type Browser,
  type ReplayReport,
  loadPlaywright,
  replaySession,
  renumber,
  seqAt,
  withoutRecord,
  withRecordBefore,
  withRecordReplaced,
  withRecordsSwapped,
} from "../../packages/boundary-replay/src/index.js";
import type { ReplayLegReport } from "../../packages/boundary-conformance/src/index.js";
import {
  buildGenericFixtures,
  buildReferenceFixtures,
  type ReferenceDefects,
  ROUTES,
  runReplayLeg,
} from "../../packages/boundary-conformance/src/index.js";
import { type FixtureServer, FIXTURES, startFixtureServer } from "./harness.js";
import { ctPrintFull, requireCtPrint } from "../helpers/ct-print.js";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const WORKSPACE = path.dirname(REPO_ROOT);
const RECORDER_CLI = path.join(REPO_ROOT, "packages/cli/dist/index.js");
const CONFORMANCE_CLI = path.join(
  REPO_ROOT,
  "packages/boundary-conformance/dist/cli.js",
);
const TIMEOUT = 300_000;
/** Clicks on #go: each puts a checkpoint at the start of the next task. */
const CLICKS = 12;
/** A canonical UUIDv7, the recording id the assembler requires. */
const RECORDING_ID = "01890a5d-ac96-774b-bcce-b302099a8057";

/** A sibling binary: `env` when set, else the first candidate that exists. */
function locate(env: string, candidates: string[], build: string): string {
  const fromEnv = process.env[env];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  for (const c of candidates) {
    const p = path.join(WORKSPACE, c);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`${candidates[0]} is not built: ${build} (or set ${env})`);
}

let SESSION_MANAGER: string;
let CT_JSBOUND: string;
let browser: Browser;
const tmpDirs: string[] = [];

function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

/** The recorded session every runner test replays. */
interface Recorded {
  build: string;
  server: FixtureServer;
  records: BoundaryRecord[];
  /** The session assembled by `ct-jsbound`, unedited. */
  ct: string;
}
let recorded: Recorded;

/**
 * Install the shim into `dir` by the shipped deploy route; with `ingest`,
 * uploading there (the conformance builds upload to the harness's ingest).
 */
function deployShim(dir: string, ingest?: string): void {
  const hash = execFileSync(
    process.execPath,
    [RECORDER_CLI, "bundle-manifest", dir],
    { encoding: "utf-8" },
  ).trim();
  execFileSync(
    process.execPath,
    [
      RECORDER_CLI,
      "boundary-shim",
      dir,
      "--build-hash",
      hash,
      ...(ingest === undefined ? [] : ["--ingest", ingest]),
    ],
    { stdio: "pipe" },
  );
}

async function waitFor<T>(
  probe: () => Promise<T>,
  done: (v: T) => boolean,
  what: string,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (done(await probe())) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Record the scripted session on `fixtures/replay.html`. */
async function recordSession(): Promise<Recorded> {
  const build = path.join(tmp("ct-replay-build-"), "site");
  fs.mkdirSync(build);
  for (const f of fs.readdirSync(FIXTURES)) {
    fs.copyFileSync(path.join(FIXTURES, f), path.join(build, f));
  }
  deployShim(build);
  const server = await startFixtureServer(build);
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${server.origin}/replay.html`);
    for (let n = 1; n <= CLICKS; n++) {
      await page.click("#go");
      // Polled from Node: an in-page poll would be recorded as the page's.
      await waitFor(
        () => page.evaluate(() => document.body.getAttribute("data-finished")),
        (v) => v === String(n),
        `click ${n} to finish`,
      );
    }
    await page.type("#name", "hi");
    const bytes = await page.evaluate(() => {
      const shim = (globalThis as unknown as Record<string, unknown>)
        .__ctBoundaryShim as { stop(): void; log(): Uint8Array };
      shim.stop();
      return Array.from(shim.log());
    });
    const records = decodeLog(Uint8Array.from(bytes), {
      inlineBodies: "batch",
    }).records;
    return { build, server, records, ct: assemble(records) };
  } finally {
    await context.close();
  }
}

/**
 * Assemble `records` into a `.ct` with the real `ct-jsbound assemble`, as
 * the ingest would: uploaded as batches of 64 frames, or, with `omit`, as
 * three batches whose middle one (the records at `omit[0]..omit[1]`) never
 * arrives, which the assembler turns into a `Gap`.
 */
function assemble(records: BoundaryRecord[], omit?: [number, number]): string {
  const dir = tmp("ct-replay-batches-");
  const header = records[0] as Extract<BoundaryRecord, { record: "Header" }>;
  const ranges: [number, number][] = [];
  if (omit === undefined) {
    for (let i = 0; i < records.length; i += 64) {
      ranges.push([i, Math.min(i + 64, records.length) - 1]);
    }
  } else {
    ranges.push([0, omit[0] - 1], omit, [omit[1] + 1, records.length - 1]);
  }
  let lastSeq = 0;
  ranges.forEach(([a, b], batchSeq) => {
    const slice = records.slice(a, b + 1);
    const seqs = slice
      .map((r) => seqOf(r))
      .filter((s): s is bigint => s !== undefined)
      .map(Number);
    const first = seqs.length > 0 ? seqs[0] : lastSeq + 1;
    const last = seqs.length > 0 ? seqs[seqs.length - 1] : lastSeq;
    lastSeq = last;
    if (omit !== undefined && batchSeq === 1) return; // never arrives
    const frames = slice.map(encodeFrame);
    let size = 0;
    for (const f of frames) size += f.length;
    const run = new Uint8Array(size);
    let at = 0;
    for (const f of frames) {
      run.set(f, at);
      at += f.length;
    }
    const body = encodeBatch(
      {
        session_id: header.session_id,
        batch_seq: batchSeq,
        first_seq: first,
        last_seq: last,
        dropped: [],
        build_hash: header.build_hash,
        final: batchSeq === ranges.length - 1,
      },
      run,
    );
    fs.writeFileSync(path.join(dir, String(batchSeq)), body);
  });
  const out = path.join(tmp("ct-replay-ct-"), "session.ct");
  const r = spawnSync(
    CT_JSBOUND,
    ["assemble", "--recording-id", RECORDING_ID, "--out", out, dir],
    { encoding: "utf-8" },
  );
  if (r.status !== 0) {
    throw new Error(`ct-jsbound assemble failed (${r.status}): ${r.stderr}`);
  }
  return out;
}

/** Replay `ct` against the recorded build, writing a trace to a new path. */
async function replay(
  ct: string,
  build = recorded.build,
): Promise<{ report: ReplayReport; out: string }> {
  const out = path.join(tmp("ct-replay-out-"), "trace.ct");
  const report = await replaySession({
    log: ct,
    build,
    out,
    sessionManager: SESSION_MANAGER,
    browser,
    timeoutMs: 60_000,
  });
  return { report, out };
}

const indexOf = (
  records: BoundaryRecord[],
  pred: (r: BoundaryRecord, i: number) => boolean,
  nth = 0,
): number => {
  let seen = 0;
  for (let i = 0; i < records.length; i++) {
    if (pred(records[i], i) && seen++ === nth) return i;
  }
  throw new Error("no such record in the recorded session");
};

beforeAll(async () => {
  SESSION_MANAGER = locate(
    "CODETRACER_SESSION_MANAGER",
    [
      "codetracer/src/backend-manager/target/release/session-manager",
      "codetracer/src/backend-manager/target/debug/session-manager",
    ],
    "cargo build --bin session-manager in codetracer/src/backend-manager",
  );
  CT_JSBOUND = locate(
    "CT_JSBOUND",
    [
      "codetracer/libs/jsbound/target/release/ct-jsbound",
      "codetracer/libs/jsbound/target/debug/ct-jsbound",
    ],
    "cargo build --bin ct-jsbound in codetracer/libs/jsbound",
  );
  requireCtPrint();
  browser = await loadPlaywright().chromium.launch({ headless: true });
  recorded = await recordSession();
}, TIMEOUT);

afterAll(async () => {
  await recorded?.server.close();
  await browser?.close();
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * The recording id record-web wrote into a trace container: the canonical
 * UUIDv7 that follows the metadata block's `CTMD` magic.
 */
function recordingIdAt(ct: Buffer): { offset: number; id: string } {
  const text = ct.toString("latin1");
  const meta = text.indexOf("CTMD");
  if (meta < 0) throw new Error("the trace has no CTMD metadata block");
  const m =
    /[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(
      text.slice(meta),
    );
  if (m === null) throw new Error("the trace metadata holds no UUIDv7");
  return { offset: meta + m.index, id: m[0] };
}

/** The lines of `function onGo` in the fixture, from its source. */
function onGoLines(): { first: number; last: number } {
  const lines = fs
    .readFileSync(path.join(FIXTURES, "replay.js"), "utf-8")
    .split("\n");
  const first = lines.findIndex((l) => l.includes("function onGo(")) + 1;
  const last = lines.findIndex((l) => l.includes("// end of onGo")) + 1;
  if (first < 1 || last <= first)
    throw new Error("onGo not found in replay.js");
  return { first, last };
}

describe("boundary replay runner", () => {
  it(
    "e2e_replay_generic_shim_fixture_matches_every_checkpoint",
    async () => {
      const checkpoints = recorded.records.filter(
        (r) => r.record === "Checkpoint",
      ).length;
      // Vacuity guard: enough checkpoints to compare.
      expect(checkpoints).toBeGreaterThanOrEqual(10);

      const { report, out } = await replay(recorded.ct);
      expect(report.error).toBeUndefined();
      expect(report.divergence).toBeUndefined();
      expect(report.status).toBe("replayed");
      expect(fs.existsSync(out)).toBe(true);

      const trace = ctPrintFull(out);
      const { first, last } = onGoLines();
      const handlerSteps = trace.events.filter(
        (e) =>
          e.kind === "step" &&
          e.path.endsWith("replay.js") &&
          e.line >= first &&
          e.line <= last,
      );
      // Vacuity guard: the trace holds steps inside the click handler.
      expect(handlerSteps.length).toBeGreaterThanOrEqual(1);
      // One call of the handler per recorded click.
      const calls = trace.events.filter(
        (e) => e.kind === "call_entry" && e.function === "onGo",
      );
      expect(calls.length).toBe(CLICKS);

      // Every checkpoint of the log was compared and matched.
      expect(report.checkpoints).toBe(checkpoints);
      expect(report.injections).toBeGreaterThan(CLICKS);
    },
    TIMEOUT,
  );

  it(
    "replay_reports_each_divergence_kind_at_its_seq",
    async () => {
      const rs = recorded.records;
      const isTask = (kind: number) => (r: BoundaryRecord) =>
        r.record === "Task" && r.kind === kind;
      const firstTimer = indexOf(rs, isTask(1));
      const secondTimer = indexOf(rs, isTask(1), 1);
      const lastRandom = indexOf(
        rs,
        (r, i) => r.record === "Random" && rs[i + 1]?.record !== "Random",
      );
      const midRandom = lastRandom - 100;
      const fetchReq = indexOf(
        rs,
        (r) => r.record === "NetRequest" && r.api === 1,
      );
      const checkpoint = indexOf(rs, (r) => r.record === "Checkpoint");
      const firstTask = indexOf(rs, (r) => r.record === "Task");
      const click = indexOf(
        rs,
        (r) => r.record === "Input" && r.type === "click",
      );
      const input = rs[click] as Extract<BoundaryRecord, { record: "Input" }>;
      // A value the page is handed and shows, checked by nothing until the
      // next checkpoint: the first Random, and the first Checkpoint after it.
      const firstRandom = indexOf(rs, (r) => r.record === "Random");
      const random = rs[firstRandom] as Extract<
        BoundaryRecord,
        { record: "Random" }
      >;
      const halfBytes = new Uint8Array(8);
      new DataView(halfBytes.buffer).setFloat64(0, 0.5, true);
      const checkpointAfter = indexOf(
        rs,
        (r, i) => r.record === "Checkpoint" && i > firstRandom,
      );
      const header = rs[0] as Extract<BoundaryRecord, { record: "Header" }>;
      const fetch = rs[fetchReq] as Extract<
        BoundaryRecord,
        { record: "NetRequest" }
      >;
      const cp = rs[checkpoint] as Extract<
        BoundaryRecord,
        { record: "Checkpoint" }
      >;
      const otherHash = "f".repeat(64) === header.build_hash ? "e" : "f";

      const cases: {
        name: string;
        ct: string;
        kind: string;
        seq: string;
      }[] = [
        {
          name: "one Random removed",
          ct: assemble(withoutRecord(rs, lastRandom)),
          kind: "ExtraRead",
          seq: seqAt(rs, lastRandom),
        },
        {
          name: "one Clock added",
          ct: assemble(
            withRecordBefore(rs, firstTimer, {
              record: "Clock",
              seq: 0n,
              src: 1,
              bits: 0x4278000000000000n,
            }),
          ),
          kind: "MissingRead",
          seq: seqAt(rs, firstTimer),
        },
        {
          name: "the fetch URL changed",
          ct: assemble(
            withRecordReplaced(rs, fetchReq, {
              ...fetch,
              url: fetch.url.replace("click=1", "click=999"),
            }),
          ),
          kind: "ArgumentMismatch",
          seq: seqAt(rs, fetchReq),
        },
        {
          name: "two Task records swapped",
          ct: assemble(withRecordsSwapped(rs, firstTimer, secondTimer)),
          kind: "TaskOrderMismatch",
          seq: seqAt(rs, firstTimer),
        },
        {
          name: "one checkpoint hash altered",
          ct: assemble(
            withRecordReplaced(rs, checkpoint, {
              ...cp,
              state_hash:
                (cp.state_hash[0] === "0" ? "1" : "0") + cp.state_hash.slice(1),
            }),
          ),
          kind: "CheckpointMismatch",
          seq: seqAt(rs, checkpoint),
        },
        {
          name: "Header.build_hash altered",
          ct: assemble(
            renumber([
              { ...header, build_hash: otherHash.repeat(64) },
              ...rs.slice(1),
            ]),
          ),
          kind: "BuildMismatch",
          seq: "0",
        },
        {
          name: "a Gap inserted",
          ct: assemble(rs, [midRandom, midRandom]),
          kind: "Gap",
          seq: seqAt(rs, midRandom),
        },
        {
          name: "a Refusal inserted",
          ct: assemble(
            withRecordBefore(rs, firstTask, {
              record: "Refusal",
              seq: 0n,
              feature: "worker",
              detail: "inserted by the test",
            }),
          ),
          kind: "NonReplayable",
          seq: seqAt(rs, firstTask),
        },
        // Checkpoints catch what no read check sees (§7.3): a returned
        // value changed, so the document differs at the next checkpoint.
        // This is what fails if dom-v1 stops discriminating documents.
        {
          name: "a returned Random value changed",
          ct: assemble(
            withRecordReplaced(rs, firstRandom, {
              ...random,
              bytes: halfBytes,
            }),
          ),
          kind: "CheckpointMismatch",
          seq: seqAt(rs, checkpointAfter),
        },
        // The two kinds the plan's list leaves out, so every kind of §7.2
        // is shown to be raised.
        {
          name: "an Input's target that names no element",
          ct: assemble(
            withRecordReplaced(rs, click, {
              ...input,
              target: "path:#no-such-element",
            }),
          ),
          kind: "InjectionFailed",
          seq: seqAt(rs, click),
        },
        {
          name: "an Error record added",
          ct: assemble(
            withRecordBefore(rs, firstTimer, {
              record: "Error",
              seq: 0n,
              kind: 1,
              message: "Uncaught Error: recorded but never raised",
              frames: "[]",
            }),
          ),
          kind: "ErrorMismatch",
          seq: seqAt(rs, firstTimer),
        },
      ];
      expect(fetch.url).toContain("click=1");

      // Negative control: the unedited session replays clean in this run,
      // and only its replay writes a trace.
      const clean = await replay(recorded.ct);
      expect(clean.report.status).toBe("replayed");
      expect(fs.existsSync(clean.out)).toBe(true);

      const outcomes: string[] = [];
      const expected: string[] = [];
      for (const c of cases) {
        const { report, out } = await replay(c.ct);
        expected.push(`${c.name}: ${c.kind} at ${c.seq}, no trace`);
        outcomes.push(
          `${c.name}: ${report.divergence?.kind ?? report.status} at ${report.divergence?.seq ?? "-"}, ${fs.existsSync(out) ? "a trace" : "no trace"}`,
        );
        expect(report.status, `${c.name}: ${report.error ?? ""}`).toBe(
          "diverged",
        );
      }
      expect(outcomes).toEqual(expected);
    },
    TIMEOUT,
  );

  it(
    "replay_never_reaches_the_network",
    async () => {
      const before = recorded.server.requests.length;
      // Recording reached the server: the page, its script, every fetch
      // and XHR.
      expect(before).toBeGreaterThan(CLICKS * 2);
      const { report } = await replay(recorded.ct);
      expect(report.status).toBe("replayed");
      // The replay made the same requests, answered from the log.
      expect(
        recorded.records.filter((r) => r.record === "NetRequest").length,
      ).toBe(CLICKS * 2);
      expect(recorded.server.requests.length).toBe(before);
    },
    TIMEOUT,
  );

  it(
    "replay_of_one_session_twice_writes_identical_traces",
    async () => {
      // A materialised trace is a cache that can be rederived (§12):
      // the same log against the same build must give a byte-identical
      // trace, whatever the run's ports, temporary directories or wall
      // clock. Its recording id included: the runner derives it from the
      // session and has record-web write it (`--recording-id`) rather than
      // mint one.
      const a = await replay(recorded.ct);
      const b = await replay(recorded.ct);
      expect(a.report.status).toBe("replayed");
      expect(b.report.status).toBe("replayed");
      const first = fs.readFileSync(a.out);
      const second = fs.readFileSync(b.out);
      const decodedA = ctPrintFull(a.out);
      // Vacuity guard: the traces hold the handler's calls, so equal
      // traces are not two empty recordings.
      expect(
        decodedA.events.filter(
          (e) => e.kind === "call_entry" && e.function === "onGo",
        ).length,
      ).toBe(CLICKS);
      expect(JSON.stringify(ctPrintFull(b.out))).toBe(JSON.stringify(decodedA));
      expect(first.length).toBeGreaterThan(0);
      expect(first.equals(second)).toBe(true);
      // The id is the derived one, not the boundary recording's own (every
      // recording has its own id), and it carries the session's timestamp.
      const id = recordingIdAt(first).id;
      expect(id).toBe(a.report.traceRecordingId);
      expect(id).not.toBe(RECORDING_ID);
      expect(id.slice(0, 13)).toBe(RECORDING_ID.slice(0, 13));
    },
    TIMEOUT,
  );

  it(
    "replay_reports_chromium_major_mismatch",
    async () => {
      const rs = recorded.records;
      const env = rs[1] as Extract<BoundaryRecord, { record: "Env" }>;
      const other = env.ua_major + 7;
      const ct = assemble([rs[0], { ...env, ua_major: other }, ...rs.slice(2)]);
      const { report, out } = await replay(ct);
      expect(report.status).toBe("replayed");
      expect(report.metadata.recordedUaMajor).toBe(other);
      expect(report.metadata.uaMajorMismatch).toBe(true);
      const args = ctPrintFull(out).metadata.args;
      expect(args).toContain(
        `ua-major-mismatch=${other}->${report.metadata.replayUaMajor}`,
      );

      // Negative control: the unedited session, same browser, no mismatch.
      const clean = await replay(recorded.ct);
      expect(clean.report.metadata.uaMajorMismatch).toBe(false);
      expect(
        ctPrintFull(clean.out).metadata.args.some((a) =>
          a.startsWith("ua-major-mismatch="),
        ),
      ).toBe(false);
    },
    TIMEOUT,
  );
});

/** Run the shipped `ct-boundary-conformance replay`; its status and report. */
function runReplayCli(
  build: string,
  level: 0 | 1,
): { status: number | null; report: ReplayLegReport; stderr: string } {
  const out = path.join(tmp("ct-conformance-replay-report-"), "report.json");
  const r = spawnSync(
    process.execPath,
    [
      CONFORMANCE_CLI,
      "replay",
      "--build",
      build,
      "--level",
      String(level),
      "--out",
      out,
    ],
    { encoding: "utf-8", timeout: TIMEOUT },
  );
  if (!fs.existsSync(out)) {
    throw new Error(
      `the CLI wrote no report (status ${r.status}): ${r.stderr}`,
    );
  }
  return {
    status: r.status,
    report: JSON.parse(fs.readFileSync(out, "utf-8")) as ReplayLegReport,
    stderr: r.stderr,
  };
}

function verdicts(report: ReplayLegReport): string[] {
  return report.fixtures.flatMap((f) =>
    f.checks.map((c) => `${f.name} ${c.name} ${c.status}`),
  );
}

/** The pointer, which the slice of Playwright the runner types leaves out. */
interface Mouse {
  move(x: number, y: number, options?: { steps?: number }): Promise<void>;
}

/**
 * Record `slow-load.html` while the pointer moves over it the whole time it
 * loads: real, trusted input, which the browser dispatches between the
 * page's own tasks wherever the network leaves it room. The document comes
 * in pieces (`chunks`) and every resource late (`delay`, harness.ts).
 */
async function recordSlowLoad(): Promise<BoundaryRecord[]> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const mouse = (page as unknown as { mouse: Mouse }).mouse;
    await mouse.move(3, 3);
    await page.goto(`${recorded.server.origin}/slow-load.html?chunks=250`, {
      waitUntil: "commit",
    });
    const deadline = Date.now() + 20_000;
    for (let n = 0; ; n++) {
      // Polled from Node: an in-page poll would be recorded as the page's.
      const loaded = await page.evaluate(
        () => document.body?.getAttribute("data-loaded") ?? null,
      );
      if (loaded === "1") break;
      if (Date.now() > deadline) throw new Error("slow-load.html never loaded");
      await mouse.move(10 + ((n * 53) % 700), 10 + ((n * 31) % 500), {
        steps: 2,
      });
    }
    await mouse.move(400, 300, { steps: 4 });
    const bytes = await page.evaluate(() => {
      const shim = (globalThis as unknown as Record<string, unknown>)
        .__ctBoundaryShim as { stop(): void; log(): Uint8Array };
      shim.stop();
      return Array.from(shim.log());
    });
    return decodeLog(Uint8Array.from(bytes), { inlineBodies: "batch" }).records;
  } finally {
    await context.close();
  }
}

/** The `Loading` phase each recorded input ran at (0: after `load`). */
function inputPhases(records: BoundaryRecord[]): number[] {
  const phases: number[] = [];
  let phase = 0;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.record === "Loading") phase = r.phase;
    if (r.record === "DocTask" && r.kind === 3) phase = 0;
    if (r.record === "Task" && r.kind === 5) {
      phases.push(records[i - 1]?.record === "Loading" ? phase : 0);
    }
  }
  return phases;
}

describe("tasks recorded while the document loaded", () => {
  it(
    "replay_reproduces_tasks_that_ran_while_the_document_loaded",
    async () => {
      // JS-Boundary-Recording.md §6, "The document's own tasks": a task the
      // browser ran while the document loaded replays where it ran, with
      // the document as it was then. Recorded with real pointer movement
      // over a page whose document and resources come late, so the browser
      // dispatches input while the parser waits for a script, between two
      // pieces of the document, after parsing and before load.
      const records = await recordSlowLoad();
      const phases = inputPhases(records);
      // Vacuity: input ran at every stage of the loading, the document's
      // own tasks are in the log, and the page's notes (written into the
      // document at load, where the last checkpoint covers them) saw the
      // document at several extents.
      expect(
        phases.filter((p) => p === 1).length,
        "inputs while parsing",
      ).toBeGreaterThan(0);
      expect(
        phases.filter((p) => p === 2 || p === 3).length,
        "inputs between parsing and load",
      ).toBeGreaterThan(0);
      const docTasks = new Set(
        records.flatMap((r) => (r.record === "DocTask" ? [r.kind] : [])),
      );
      expect([...docTasks].sort()).toEqual([1, 2, 3]);
      const last = records[records.length - 2];
      expect(last.record, "the session ends with a checkpoint").toBe(
        "Checkpoint",
      );

      const report = await replaySession({
        log: assemble(records),
        build: recorded.build,
        browser,
        timeoutMs: 60_000,
      });
      expect(
        report.status,
        JSON.stringify(report.divergence ?? report.error),
      ).toBe("replayed");
      expect(report.checkpoints).toBe(
        records.filter((r) => r.record === "Checkpoint").length,
      );
      expect(report.injections).toBe(phases.length);
    },
    TIMEOUT,
  );
});

describe("materialising a level-1 session", () => {
  it(
    "replay_of_a_level_1_session_writes_a_trace_of_the_framework_bundle",
    async () => {
      // JS-Boundary-Recording.md §8, §12: the trace of a session is made by
      // replaying the instrumented copy of the bundle it ran, so that copy
      // must behave as the bundle. The reference framework is an esbuild
      // bundle of TypeScript compiled to CommonJS (`__commonJS`,
      // `__exportStar`), the shape the instrumenter once broke (it passed
      // a returned comma expression to `__ct.ret` unparenthesised).
      const site = path.join(tmp("ct-level1-trace-"), "site");
      await buildReferenceFixtures(site);
      const { replays } = await runReplayLeg({
        build: site,
        level: 1,
        fixtures: ["counter"],
        browser,
      });
      const records = replays[0]?.records;
      expect(records, replays[0]?.unusable).toBeDefined();
      const clicks = records!.filter(
        (r) => r.record === "Input" && r.type === "click",
      ).length;
      // Vacuity: the scripted interaction clicked.
      expect(clicks).toBeGreaterThanOrEqual(2);

      const out = path.join(tmp("ct-level1-out-"), "trace.ct");
      const report = await replaySession({
        log: assemble(records!),
        build: site,
        out,
        sessionManager: SESSION_MANAGER,
        browser,
        timeoutMs: 60_000,
      });
      expect(
        report.status,
        JSON.stringify(report.divergence ?? report.error),
      ).toBe("replayed");
      expect(report.pageErrors).toEqual([]);

      // The trace is read by the existing reader; its steps are in the two
      // files the page ran, at the lines that ran.
      const trace = ctPrintFull(out);
      const steps = trace.events.filter((e) => e.kind === "step");
      const files = new Set(steps.map((e) => e.path));
      expect([...files].sort()).toEqual(["counter/app.js", "microfw.js"]);
      const appLines = fs
        .readFileSync(path.join(site, "counter", "app.js"), "utf-8")
        .split("\n");
      const handlerLine =
        appLines.findIndex((l) => l.includes("count.set(count.get() + 1)")) + 1;
      expect(handlerLine).toBeGreaterThan(0);
      // One run of the click handler's first statement per recorded click.
      expect(
        steps.filter(
          (e) => e.path === "counter/app.js" && e.line === handlerLine,
        ).length,
      ).toBe(clicks);
      // And the framework's own code, from the bundle's module wrappers on.
      expect(
        steps.filter((e) => e.path === "microfw.js").length,
      ).toBeGreaterThan(100);
    },
    TIMEOUT,
  );
});

describe("conformance replay leg", () => {
  it(
    "conformance_replay_leg_passes_reference_and_shim",
    async () => {
      const generic = path.join(tmp("ct-conformance-generic-"), "site");
      await buildGenericFixtures(generic);
      deployShim(generic, ROUTES.ingest);
      const reference = path.join(tmp("ct-conformance-reference-"), "site");
      await buildReferenceFixtures(reference);
      const names = [
        "counter",
        "text-input",
        "password-form",
        "fetch-list",
        "timers",
        "prehydration",
        "client-nodes",
        "navigation",
      ];

      const level1 = runReplayCli(reference, 1);
      expect(level1.report.fixtures.map((f) => f.name)).toEqual(names);
      // The command's stderr names every failed check with its detail.
      expect(verdicts(level1.report), level1.stderr).toEqual(
        names.flatMap((n) => [
          `${n} replay pass`,
          `${n} inject pass`,
          `${n} divergence pass`,
        ]),
      );
      expect(level1.status, level1.stderr).toBe(0);

      const level0 = runReplayCli(generic, 0);
      expect(verdicts(level0.report), level0.stderr).toEqual(
        names.flatMap((n) => [
          `${n} replay pass`,
          `${n} inject not-applicable-at-level-0`,
          `${n} divergence pass`,
        ]),
      );
      expect(level0.status, level0.stderr).toBe(0);

      // Negative control: a reference framework whose inject dispatches a
      // synthetic DOM event fails `inject`, and only `inject`, everywhere.
      const defects: ReferenceDefects = { injectByDispatch: true };
      const broken = path.join(tmp("ct-conformance-broken-"), "site");
      await buildReferenceFixtures(broken, defects);
      const bad = runReplayCli(broken, 1);
      expect(bad.status).toBe(1);
      expect(
        bad.report.fixtures.flatMap((f) =>
          f.checks
            .filter((c) => c.status === "fail")
            .map((c) => `${f.name} ${c.name}`),
        ),
      ).toEqual(names.map((n) => `${n} inject`));
    },
    TIMEOUT,
  );
});

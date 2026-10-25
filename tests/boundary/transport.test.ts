/**
 * The batched upload transport of boundary recording (`HttpBatchTransport`,
 * `packages/runtime-browser/src/batch-transport.ts`; CodeTracer's
 * JS-Boundary-Recording specification §11.1 and §11.2, the batch envelope of
 * the Boundary-Ingest specification §4), as the generic shim uses it.
 *
 * Every session is recorded for real: `fixtures/transport.html`, served by
 * the fixture server, with the shim installed by the shipped deploy route
 * (`codetracer-js-recorder boundary-shim --build-hash … --ingest …`), driven
 * in headless Chromium (from the dev shell). What the browser uploads is
 * assembled with codetracer's real `ct-jsbound assemble` and read back
 * through the canonical CTFS reader.
 *
 * Mocks, each justified:
 * - **The ingest is a local stub** (`stub-ingest.ts`): the real one is
 *   a CodeTracer service built on this transport, which cannot serve these
 *   tests yet. It runs on its own loopback port, so
 *   uploads cross origins as they do in production.
 * - **Do Not Track and Global Privacy Control are set by an init script**
 *   that defines `navigator.doNotTrack` / `navigator.globalPrivacyControl`
 *   before the page runs. Headless Chromium has no switch for its DNT
 *   setting (a `Preferences` file with `enable_do_not_track` leaves
 *   `navigator.doNotTrack` `null`, measured 2026-10-23), and Chromium has no
 *   GPC setting at all: browsers and extensions that send GPC define the
 *   property exactly so. The shim reads only the property.
 * - **The flush-deadline tests wrap `fetch` in an init script** that runs
 *   before the shim, so the shim captures the wrapper as the original and
 *   the transport's requests pass through it: it notes the browser time of
 *   each batch request (and the deadline the transport reports then) and
 *   calls the real `fetch`. Nothing else observes when a batch leaves the
 *   page in browser time. The timer-spin test wraps `setTimeout` the same
 *   way, only to count the transport's timers.
 * - **The cookie test sets the ingest's cookie with Playwright's
 *   `addCookies`**, as a visitor's earlier visit to the ingest's host would
 *   have: a `SameSite=None; Secure` cookie on `localhost`, the stub's host,
 *   while the page is served from `127.0.0.1`, another site. The stub
 *   records the `Cookie` header of every request.
 *
 * Not mocks, but departures from the default browser: the back/forward
 * cache test launches Chromium without Playwright's
 * `--disable-back-forward-cache`, so the page's own not-restored reasons
 * are reported.
 *
 * The assembler comes from the codetracer sibling (`cargo build --bin
 * ct-jsbound` in codetracer/libs/jsbound) or `CT_JSBOUND`; without it the
 * tests fail, naming the build command, rather than skip.
 */

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type BoundaryRecord,
  type ParsedBatch,
  parseBatch,
  seqOf,
} from "../../packages/boundary-format/src/index.js";
import {
  loadBoundaryLog,
  replaySession,
} from "../../packages/boundary-replay/src/index.js";
import { FLUSH_TIMER_LEAD_MS } from "../../packages/runtime-browser/src/batch-transport.js";
import {
  copyFixtures,
  FIXTURE_BUILD_HASH,
  type FixtureServer,
  loadPlaywright,
  sleep,
  startFixtureServer,
} from "./harness.js";
import { type StubIngest, startStubIngest } from "./stub-ingest.js";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const WORKSPACE = path.dirname(REPO_ROOT);
const CLI = path.join(REPO_ROOT, "packages", "cli", "dist", "index.js");
const TIMEOUT = 240_000;
/** The transport's initial flush deadline, its fast batches and its cap (§11.1). */
const DEADLINE_MS = 50;
const FAST_BATCHES = 8;
const DEADLINE_MAX_MS = 2000;
/** The keepalive budget a batch is cut to, less the envelope allowance. */
const FULL_BATCH_BYTES = 64 * 1024 - 1024;
/** A canonical UUIDv7, the recording id the assembler requires. */
const RECORDING_ID = "01890a5d-ac96-774b-bcce-b302099a8057";

// ── Playwright, as these tests use it ──────────────────────────────────

interface TPage {
  goto(url: string): Promise<unknown>;
  goBack(): Promise<unknown>;
  addInitScript(script: { content: string }): Promise<void>;
  click(selector: string): Promise<void>;
  evaluate<T>(fn: () => T): Promise<T>;
  evaluate<T, A>(fn: (arg: A) => T, arg: A): Promise<T>;
  on(event: "pageerror", f: (e: Error) => void): void;
}
interface TCdpSession {
  send(method: string, params?: object): Promise<unknown>;
  on(event: string, f: (e: unknown) => void): void;
}
interface TContext {
  newPage(): Promise<TPage>;
  addCookies(
    cookies: {
      name: string;
      value: string;
      domain: string;
      path: string;
      secure: boolean;
      sameSite: "None" | "Lax" | "Strict";
    }[],
  ): Promise<void>;
  newCDPSession(page: TPage): Promise<TCdpSession>;
  close(): Promise<void>;
}
interface TBrowser {
  newContext(): Promise<TContext>;
  close(): Promise<void>;
}
interface TBrowserServer {
  wsEndpoint(): string;
  kill(): Promise<void>;
  close(): Promise<void>;
}
interface TChromium {
  launch(options: {
    headless: boolean;
    ignoreDefaultArgs?: string[];
  }): Promise<TBrowser>;
  launchServer(options: { headless: boolean }): Promise<TBrowserServer>;
  connect(wsEndpoint: string): Promise<TBrowser>;
}
const chromium = () =>
  (loadPlaywright() as unknown as { chromium: TChromium }).chromium;

// ── Fixtures ────────────────────────────────────────────────────────────

let CT_JSBOUND: string;
let browser: TBrowser;
const tmpDirs: string[] = [];
const servers: { close(): Promise<void> }[] = [];

function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

/** The ingest's status as the shim reports it. */
interface UploadStatus {
  state: string;
  reason?: string;
  batchesAccepted: number;
  lastAcceptedSeq: number;
  bufferedFrames: number;
  droppedRecords: number;
  ringBytes: number;
}

/**
 * The fixture pages with the shim installed by the shipped deploy route,
 * uploading to `stub`, and served by a fresh fixture server. With
 * `manifest`, the build hash is the one `bundle-manifest` computes for the
 * pages (which a replay of the session checks), not a placeholder.
 */
async function site(
  stub: StubIngest,
  extra: string[] = [],
  manifest = false,
): Promise<FixtureServer & { dir: string }> {
  const dir = copyFixtures();
  tmpDirs.push(dir);
  const hash = manifest
    ? execFileSync(process.execPath, [CLI, "bundle-manifest", dir], {
        encoding: "utf-8",
      }).trim()
    : FIXTURE_BUILD_HASH;
  execFileSync(
    process.execPath,
    [
      CLI,
      "boundary-shim",
      path.join(dir, "transport.html"),
      path.join(dir, "transport-consent.html"),
      "--build-hash",
      hash,
      "--ingest",
      stub.base,
      ...extra,
    ],
    { stdio: "pipe" },
  );
  const server = await startFixtureServer(dir);
  servers.push(server);
  return Object.assign(server, { dir });
}

async function stub(
  config: unknown = { enabled: true },
  options: { noStore?: boolean; host?: "127.0.0.1" | "localhost" } = {},
): Promise<StubIngest> {
  const s = await startStubIngest(config, options);
  servers.push(s);
  return s;
}

async function status(page: TPage): Promise<UploadStatus | undefined> {
  return page.evaluate(
    () =>
      (
        globalThis as unknown as {
          __ctBoundaryShim?: { uploadStatus(): unknown };
        }
      ).__ctBoundaryShim?.uploadStatus() as UploadStatus | undefined,
  );
}

/** Poll `probe` from Node (never in the page, whose timers are recorded). */
async function until<T>(
  probe: () => Promise<T>,
  done: (v: T) => boolean,
  what: string,
  ms = 15_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (done(v)) return v;
    if (Date.now() > deadline) {
      throw new Error(`${what} within ${ms} ms (last: ${JSON.stringify(v)})`);
    }
    await sleep(20);
  }
}

/** Every batch is accepted and none is waiting: the transport is idle. */
const idle = (s: UploadStatus | undefined) =>
  s !== undefined && s.state === "open" && s.bufferedFrames === 0;

async function textOf(page: TPage, id: string): Promise<string | null> {
  return page.evaluate(
    (i: string) => document.getElementById(i)?.textContent ?? null,
    id,
  );
}

/** The seq-bearing records' seqs of a batch, in order. */
const seqsOf = (b: ParsedBatch): number[] =>
  b.records
    .map((r) => seqOf(r))
    .filter((s): s is bigint => s !== undefined)
    .map(Number);

/**
 * Assemble `bodies` with the real `ct-jsbound assemble` and read the
 * assembled log back through the canonical CTFS reader (which decodes it
 * strictly).
 */
function assemble(
  bodies: Uint8Array[],
  flags: string[] = [],
): BoundaryRecord[] {
  const dir = tmp("ct-transport-batches-");
  bodies.forEach((b, i) => fs.writeFileSync(path.join(dir, String(i)), b));
  const out = path.join(tmp("ct-transport-ct-"), "session.ct");
  const r = spawnSync(
    CT_JSBOUND,
    ["assemble", "--recording-id", RECORDING_ID, "--out", out, ...flags, dir],
    { encoding: "utf-8" },
  );
  if (r.status !== 0) {
    throw new Error(`ct-jsbound assemble failed (${r.status}): ${r.stderr}`);
  }
  return loadBoundaryLog(out).records;
}

/** A double from a `Random{src: 1}` record's 8 bytes (little-endian). */
const randomValue = (bytes: Uint8Array): number =>
  Buffer.from(bytes).readDoubleLE(0);

/** One batch request the page made: when, its body, and the deadline then. */
interface Send {
  t: number;
  body: number[];
  deadline: number;
  /** When the request settled (answered or failed), in browser time. */
  answered?: number;
}

/**
 * An init script, run before the shim, wrapping `fetch`: the shim captures
 * the wrapper as the original, so every batch request of the transport
 * passes through it, and it notes the browser time, the body and the flush
 * deadline the transport reports at that moment (the deadline that governed
 * the batch: the transport adapts it only after sending), and when the
 * request settled: its reaction is registered before the transport's, so
 * it runs just before the transport sees the answer.
 */
const SEND_RECORDER =
  "(() => { const real = window.fetch; const then = Promise.prototype.then; " +
  "const now = performance.now.bind(performance); " +
  "window.__ctSends = []; " +
  "window.fetch = function (input, init) { " +
  "let e; " +
  "if (String(input).endsWith('/batches') && init && init.body) { " +
  "const shim = window.__ctBoundaryShim; " +
  "const s = shim && shim.uploadStatus ? shim.uploadStatus() : undefined; " +
  "e = { t: now(), body: Array.from(init.body), " +
  "deadline: s ? s.flushDeadlineMs : -1 }; " +
  "window.__ctSends.push(e); } " +
  "const p = real.apply(this, arguments); " +
  "if (e) { const settled = () => { e.answered = now(); }; " +
  "then.call(p, settled, settled); } " +
  "return p; }; })();";

async function sendsOf(page: TPage): Promise<Send[]> {
  return page.evaluate(
    () => (globalThis as unknown as { __ctSends: Send[] }).__ctSends,
  );
}

/**
 * The flush deadline each batch was due under, by §11.1's rule, worked out
 * from the batches alone: 50 ms; after the first 8 batches, every batch the
 * deadline cut (fewer than 256 records, under the byte bound, not final)
 * doubles it, up to 2 s. Batch 0 is sent when the configuration arrives,
 * not by the deadline, but it is one of the first 8 either way.
 */
function deadlineSchedule(
  batches: { body: Uint8Array; parsed: ParsedBatch }[],
): Map<number, number> {
  const out = new Map<number, number>();
  let d = DEADLINE_MS;
  for (const { body, parsed } of [...batches].sort(
    (a, b) => a.parsed.envelope.batch_seq - b.parsed.envelope.batch_seq,
  )) {
    const seq = parsed.envelope.batch_seq;
    out.set(seq, d);
    const full = parsed.records.length >= 256 || body.length > FULL_BATCH_BYTES;
    if (!full && !parsed.envelope.final && seq + 1 >= FAST_BATCHES) {
      d = Math.min(DEADLINE_MAX_MS, d * 2);
    }
  }
  return out;
}

/**
 * One run of the fixture page's interval ticks, as the page reports it in
 * `window.__ctTickRuns` (`fixtures/transport.js`): `t0` is the
 * `performance.now()` the page read just before `setInterval`, `interval`
 * the delay it asked for, `ticks` how many ticks it runs.
 */
interface TickRun {
  t0: number;
  interval: number;
  ticks: number;
}

async function tickRunsOf(page: TPage): Promise<TickRun[]> {
  return page.evaluate(
    () =>
      (globalThis as unknown as { __ctTickRuns?: TickRun[] }).__ctTickRuns ??
      [],
  );
}

/**
 * How far the coarsened `performance.now()` may misplace a read (Chromium
 * rounds it to 100 µs and adds jitter), for the model's own check in
 * {@link pageRuns} only.
 */
const CLOCK_GRAIN_MS = 0.5;

/**
 * Each page time read (a `Clock` of `performance.now()`), sorted by when it
 * ran, with a lower bound on when it came due.
 *
 * A tick of `setInterval` runs no earlier than it is due, and under load
 * well after, so the time it ran says little about when it came due.
 * Chromium runs a repeating timer on a fixed grid from the moment it was
 * started, one grid point per interval: a tick that ran late moves no later
 * tick, and the points a tick ran a whole interval or more past are skipped
 * (Blink's `TimerBase::RunInternal`, "This computation should be drift
 * free",
 * https://source.chromium.org/chromium/chromium/src/+/main:third_party/blink/renderer/platform/timer.cc).
 * The grid starts no earlier than the `t0` the page read just before it
 * called `setInterval`, so the run's `k`-th tick is due no earlier than
 * `t0 + k * interval`: at that grid point, or at a later one after a skip.
 * The bound holds whatever the page's tasks cost, which a bound taken from
 * when the tick before ran does not: the browser takes the time it
 * schedules the next tick from before the shim and the page start their
 * work, and a stalled renderer can stop between the two (under a 32-way CPU
 * load such a bound put a tick 3 ms after it ran in two runs of five). After a
 * skip the bound is low by the points skipped, which only excuses more.
 * A read that is not one of the run's ticks (the page's `t0` itself, a
 * read past the run's last tick, or one before any run) gets no bound:
 * nothing says when it came due, so it never counts as due after an aim.
 */
function pageRuns(
  values: number[],
  runs: TickRun[],
): { ran: number; due: number }[] {
  const sorted = [...values].sort((a, b) => a - b);
  const out: { ran: number; due: number }[] = [];
  let phase: TickRun | undefined;
  let k = 0;
  for (const ran of sorted) {
    // The run of ticks this read belongs to: the latest started by then.
    const current = runs
      .filter((p) => p.t0 <= ran)
      .reduce<
        TickRun | undefined
      >((a, p) => (a === undefined || p.t0 > a.t0 ? p : a), undefined);
    if (current !== phase) {
      phase = current;
      k = 0;
    }
    if (phase === undefined || ran === phase.t0 || k >= phase.ticks) {
      out.push({ ran, due: -Infinity });
      continue;
    }
    k += 1;
    const due = phase.t0 + k * phase.interval;
    // The model's own check: no tick runs before the bound says it came
    // due. A browser that scheduled intervals otherwise, or a read the page
    // made among its ticks, fails here, loudly, rather than by excusing
    // what it should not.
    expect(
      due,
      `tick ${k} of the run from ${phase.t0}, run at ${ran}`,
    ).toBeLessThanOrEqual(ran + CLOCK_GRAIN_MS);
    out.push({ ran, due });
  }
  return out;
}

/**
 * Check that no timed record waited longer than its batch's deadline.
 * The page's ticks read `performance.now()`; such a read's value is the
 * browser time it was made, so its wait is its batch's send time minus its
 * value. Returns each batch's oldest wait and how many batches were excused
 * by a stalled renderer.
 *
 * A batch should leave at its oldest record's time plus the deadline, or at
 * the answer to the batch before if that came later (§11.1: the bound
 * assumes the previous batch is answered within it; the timer is not armed
 * while a batch is in flight, and the answer sends a batch that is due at
 * once). The transport aims its flush timer 10 ms before the deadline, and
 * a timer due at its aim runs before every page task that came due after
 * it. So a batch that leaves late fails when a tick that came due after the
 * aim ran before the send (bar one within 3 ms of the send, which an
 * overdue timer of another task queue may run first): its timer was aimed
 * late and let the page run first. A tick due before the aim that ran
 * after it proves nothing: under load both timers ran late, in due order.
 * Due times are lower bounds ({@link pageRuns}), so the check never fails a
 * tick that may have come due before the aim, and fails every tick that
 * certainly came due after it.
 *
 * The bound is browser time in which the page runs. When the operating
 * system does not schedule the renderer (seen under a 32-way CPU load: a
 * batch sent 64 ms after its oldest read, its window holding 9 of the
 * page's 5 ms ticks where 14 fit), nothing in the page runs, the transport
 * included, and the batch goes the moment the page runs again. The page's
 * ticks show such a stall: a tick due at `d` that ran at `r` waited out
 * `[d, r]` as the flush timer did. A batch that left late passes when the
 * part of its delay no tick shows, the time from when it should have left
 * to the start of the stall (`d`) plus the time from the stall's end (`r`)
 * to the send, is at most {@link LATE_TIMER_SLACK_MS}; it is counted in
 * `stalls`. A tick that ran on time shows nothing, so on a running page the
 * whole delay counts. A delay of at most {@link LATE_TIMER_SLACK_MS} passes
 * with no tick showing it (under the same load the flush timer ran 10 to 19
 * ms past its aim with no tick due in between, on a 25 ms page with no tick
 * due, and after the page's ticks had ended), and is counted in `unseen`.
 */
function checkWaits(
  got: ParsedBatch[],
  sends: Map<number, { t: number; answered?: number }>,
  deadlineOf: (batch: number) => number,
  runs: TickRun[],
): {
  oldestWait: Map<number, number>;
  stalls: number;
  unseen: number;
  timed: number;
} {
  const bits = Buffer.alloc(8);
  const waits: { batch: number; wait: number }[] = [];
  for (const b of got) {
    const t = sends.get(b.envelope.batch_seq)!.t;
    for (const r of b.records) {
      if (r.record === "Clock" && r.src === 2) {
        bits.writeBigUInt64LE(r.bits);
        waits.push({
          batch: b.envelope.batch_seq,
          wait: t - bits.readDoubleLE(0),
        });
      }
    }
  }
  const page = pageRuns(
    waits.map((w) => sends.get(w.batch)!.t - w.wait),
    runs,
  );
  const oldestWait = new Map<number, number>();
  for (const w of waits) {
    expect(w.wait, `batch ${w.batch}`).toBeGreaterThanOrEqual(0);
    oldestWait.set(w.batch, Math.max(oldestWait.get(w.batch) ?? 0, w.wait));
  }
  let stalls = 0;
  let unseen = 0;
  for (const [batch, wait] of oldestWait) {
    const deadline = deadlineOf(batch);
    if (wait <= deadline) continue;
    const sent = sends.get(batch)!.t;
    const answer = Math.min(sends.get(batch - 1)?.answered ?? -Infinity, sent);
    const goal = Math.max(sent - wait + deadline, answer);
    const aim = Math.max(sent - wait + deadline - 10, answer);
    const dueMeanwhile = page.filter(
      (p) => p.ran > aim && p.ran < sent - 3 && p.due > aim,
    );
    // The least delay no tick shows: none at all, or the best tick's.
    const late = sent - goal;
    const shown = page
      .filter((p) => Number.isFinite(p.due))
      .map(
        (p) =>
          Math.max(0, p.due - goal) + Math.max(0, Math.min(late, sent - p.ran)),
      );
    const unshown = Math.min(late, ...shown);
    const detail = `batch ${batch}: waited ${wait} ms, deadline ${deadline} ms, left ${late} ms late, ${unshown} ms of it shown by no tick; ticks ${JSON.stringify(dueMeanwhile)} came due after the aim ${aim} and ran before the send`;
    expect(dueMeanwhile, detail).toEqual([]);
    expect(unshown, detail).toBeLessThanOrEqual(LATE_TIMER_SLACK_MS);
    if (late <= LATE_TIMER_SLACK_MS) unseen += 1;
    else stalls += 1;
  }
  return { oldestWait, stalls, unseen, timed: waits.length };
}

/**
 * How much of a batch's delay may go unexplained by the page's ticks (see
 * {@link checkWaits}).
 */
const LATE_TIMER_SLACK_MS = 15;

/** When each batch first left the page, in browser time, by batch_seq. */
function sendTimes(sends: Send[]): Map<number, Send> {
  const out = new Map<number, Send>();
  for (const s of sends) {
    const b = parseBatch(Uint8Array.from(s.body));
    if (!out.has(b.envelope.batch_seq)) out.set(b.envelope.batch_seq, s);
  }
  return out;
}

beforeAll(async () => {
  const fromEnv = process.env.CT_JSBOUND;
  const candidates = [
    "codetracer/libs/jsbound/target/release/ct-jsbound",
    "codetracer/libs/jsbound/target/debug/ct-jsbound",
  ].map((c) => path.join(WORKSPACE, c));
  const found =
    fromEnv !== undefined && fromEnv !== ""
      ? fromEnv
      : candidates.find((c) => fs.existsSync(c));
  if (found === undefined) {
    throw new Error(
      "ct-jsbound is not built: cargo build --bin ct-jsbound in codetracer/libs/jsbound (or set CT_JSBOUND)",
    );
  }
  CT_JSBOUND = found;
  browser = await chromium().launch({ headless: true });
}, TIMEOUT);

afterAll(async () => {
  await browser?.close();
  for (const s of servers) await s.close();
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

describe("the batched upload transport", () => {
  it(
    "transport_tab_killed_mid_session_delivers_a_prefix",
    async () => {
      const ingest = await stub();
      const server = await site(ingest);
      // A browser of its own, so it can be killed.
      const killable = await chromium().launchServer({ headless: true });
      let killed = false;
      /** The last seq of the last flush the page saw complete. */
      let flushedSeq = 0;
      try {
        const b = await chromium().connect(killable.wsEndpoint());
        const page = await (await b.newContext()).newPage();
        await page.goto(`${server.origin}/transport.html`);
        const N = 6;
        for (let i = 0; i < N; i++) await page.click("#one");
        expect(await textOf(page, "clicks")).toBe(String(N));
        // The last completed flush: the transport is idle and the ingest
        // accepted everything written so far.
        const flushed = await until(
          () => status(page),
          idle,
          "the transport did not go idle",
        );
        flushedSeq = flushed!.lastAcceptedSeq;
        // Vacuity guard: N inputs wrote at least a Task, an Input and a
        // Clock each before the flush.
        expect(flushedSeq).toBeGreaterThanOrEqual(3 * N);
        // More input, then the browser process dies with no pagehide.
        for (let i = 0; i < 3; i++) await page.click("#one");
        await killable.kill();
        killed = true;
      } finally {
        if (!killed) await killable.close();
      }
      await sleep(300);

      const got = ingest.batches.map((b) => b.parsed);
      expect(got.length).toBeGreaterThan(0);
      // A contiguous prefix: batch_seq 0, 1, 2, … and seq 1, 2, 3, …
      // with nothing dropped, nothing final and no End.
      expect(got.map((b) => b.envelope.batch_seq)).toEqual(
        got.map((_, i) => i),
      );
      const seqs = got.flatMap(seqsOf);
      expect(seqs).toEqual(seqs.map((_, i) => i + 1));
      expect(got.every((b) => b.envelope.dropped.length === 0)).toBe(true);
      expect(got.some((b) => b.envelope.final)).toBe(false);
      expect(got.some((b) => b.records.some((r) => r.record === "End"))).toBe(
        false,
      );
      const lastSeq = got[got.length - 1].envelope.last_seq;
      expect(lastSeq).toBe(seqs.length);
      // The flush the page saw complete is in the prefix.
      expect(lastSeq).toBeGreaterThanOrEqual(flushedSeq);

      // The assembler turns the prefix into a valid recording, ended by
      // the ingest's idle finalisation.
      const records = assemble(
        ingest.batches.map((b) => b.body),
        ["--idle"],
      );
      const end = records[records.length - 1];
      expect(end).toEqual({
        record: "End",
        last_seq: BigInt(lastSeq),
        reason: 3,
      });
      expect(records.filter((r) => r.record === "Gap")).toEqual([]);
    },
    TIMEOUT,
  );
  it(
    "transport_ring_overflow_reports_the_dropped_range",
    async () => {
      const ingest = await stub({ enabled: true, ring_bytes: 4096 });
      const server = await site(ingest);
      const context = await browser.newContext();
      let randoms: number[];
      let stalledBatch: number;
      try {
        const page = await context.newPage();
        await page.goto(`${server.origin}/transport.html`);
        const ready = await until(
          () => status(page),
          idle,
          "the transport did not go idle",
        );
        // The configuration's ring is the one in use.
        expect(ready!.ringBytes).toBe(4096);
        expect(ready!.droppedRecords).toBe(0);
        stalledBatch = ingest.batches.length;
        ingest.stall();
        // 2000 Math.random() reads in one task: about 50 KiB of frames.
        await page.click("#burst");
        await until(
          () => textOf(page, "burst-done"),
          (t) => t === "2000",
          "the burst did not finish",
        );
        await until(
          async () => ingest.held(),
          (n) => n === 1,
          "no batch was held by the stalled ingest",
        );
        // While the ingest stalls the ring overflows: frames are dropped.
        const during = await status(page);
        expect(during!.droppedRecords).toBeGreaterThan(0);
        ingest.release();
        await page.evaluate(() =>
          (
            globalThis as unknown as {
              __ctBoundaryShim: { stop(): Promise<void> };
            }
          ).__ctBoundaryShim.stop(),
        );
        randoms = await page.evaluate(
          () => (globalThis as unknown as { __randoms: number[] }).__randoms,
        );
      } finally {
        await context.close();
      }
      expect(randoms.length).toBe(2000);
      const got = ingest.batches.map((b) => b.parsed);
      // The batch held while the ring overflowed, then the next one, which
      // is the first to carry `dropped`, and the only one.
      expect(got[stalledBatch].envelope.dropped).toEqual([]);
      const withDrops = got.filter((b) => b.envelope.dropped.length > 0);
      expect(withDrops.map((b) => b.envelope.batch_seq)).toEqual([
        stalledBatch + 1,
      ]);
      const dropped = withDrops[0].envelope.dropped;
      expect(dropped.length).toBe(1);
      const [first, last] = dropped[0];

      // Which records were evicted, worked out from the page's own values
      // and the batches, not from the transport's bookkeeping: the burst's
      // reads are consecutive records, so each value's seq is its position
      // plus one offset, which the values that arrived fix. The hole starts
      // after the batch the ingest held (its records were sent) and ends at
      // the first value that arrived after it; the held batch may hold
      // records of the click before the burst, or the first values.
      const arrived = new Map<number, number>();
      for (const b of got) {
        for (const r of b.records) {
          if (r.record === "Random" && r.src === 1) {
            arrived.set(randomValue(r.bytes), Number(r.seq));
          }
        }
      }
      const offsets = new Set<number>();
      randoms.forEach((v, i) => {
        const seq = arrived.get(v);
        if (seq !== undefined) offsets.add(seq - i);
      });
      // One offset: the arrived values sit at consecutive seqs.
      expect([...offsets].length).toBe(1);
      const offset = [...offsets][0];
      const evicted = randoms
        .map((v, i) => (arrived.has(v) ? undefined : offset + i))
        .filter((s): s is number => s !== undefined);
      // Vacuity guard: the overflow evicted most of the burst, and the
      // burst's last values arrived after the hole.
      expect(evicted.length).toBeGreaterThan(1000);
      expect(arrived.has(randoms[randoms.length - 1])).toBe(true);
      // The evicted values are one run of seqs...
      expect(evicted).toEqual(evicted.map((_, i) => evicted[0] + i));
      // ...that ends exactly where the dropped range ends...
      expect(last).toBe(evicted[evicted.length - 1]);
      // ...and the range starts right after the held batch's last record,
      // at or before the first evicted value. Before it only by records of
      // the click written before the burst's first read (its pointer and
      // mouse events' tasks, inputs and effects, a few dozen): when the
      // held batch ended before the burst, the burst's first value is the
      // first evicted one.
      expect(first).toBe(got[stalledBatch].envelope.last_seq + 1);
      expect(first).toBeLessThanOrEqual(evicted[0]);
      expect(evicted[0] - first).toBeLessThan(64);
      if (evicted[0] > first) expect(evicted[0]).toBe(offset);
      const delivered = new Set(got.flatMap(seqsOf));
      for (let s = first; s <= last; s++) {
        expect(delivered.has(s), `seq ${s} is in the dropped range`).toBe(
          false,
        );
      }

      // The assembled log has one Gap, of exactly that range.
      const records = assemble(ingest.batches.map((b) => b.body));
      expect(records.filter((r) => r.record === "Gap")).toEqual([
        {
          record: "Gap",
          first_seq: BigInt(first),
          last_seq: BigInt(last),
          reason: 1,
        },
      ]);
      expect(records[records.length - 1].record).toBe("End");
    },
    TIMEOUT,
  );

  it(
    "transport_refused_batch_reports_its_records_and_drops_again",
    async () => {
      // The ring overflows while the ingest stalls, as above; then the
      // batch that reports the eviction is refused (413, over the size
      // limit). Its records and the drops it reported never reached the
      // ingest, so the next batch must report both, as one range.
      const ingest = await stub({ enabled: true, ring_bytes: 4096 });
      const server = await site(ingest);
      const context = await browser.newContext();
      let stalledBatch: number;
      let droppedBefore: number;
      let droppedAfter: number;
      try {
        const page = await context.newPage();
        await page.goto(`${server.origin}/transport.html`);
        await until(() => status(page), idle, "the transport did not go idle");
        stalledBatch = ingest.batches.length;
        ingest.stall();
        await page.click("#burst");
        await until(
          () => textOf(page, "burst-done"),
          (t) => t === "2000",
          "the burst did not finish",
        );
        await until(
          async () => ingest.held(),
          (n) => n === 1,
          "no batch was held by the stalled ingest",
        );
        droppedBefore = (await status(page))!.droppedRecords;
        ingest.refuseNext(413);
        ingest.release();
        // The refusal comes before the stop, so the refused batch is not the
        // final one and a batch after it reports what it lost.
        await until(
          async () => ingest.requests.filter((r) => r.status === 413).length,
          (n) => n === 1,
          "the ingest refused no batch",
        );
        await page.evaluate(() =>
          (
            globalThis as unknown as {
              __ctBoundaryShim: { stop(): Promise<void> };
            }
          ).__ctBoundaryShim.stop(),
        );
        droppedAfter = (await status(page))!.droppedRecords;
      } finally {
        await context.close();
      }
      // Vacuity guards: the ring did overflow, and the ingest refused one
      // batch that carried records.
      expect(droppedBefore).toBeGreaterThan(0);
      expect(droppedAfter).toBeGreaterThan(droppedBefore);
      expect(ingest.requests.filter((r) => r.status === 413).length).toBe(1);

      const got = ingest.batches.map((b) => b.parsed);
      // The refused batch_seq is missing; the batch after it carries one
      // dropped range, from right after the held batch to right before its
      // own first record: the evicted records and the refused batch's.
      const held = got[stalledBatch];
      const next = got[stalledBatch + 1];
      expect(held.envelope.dropped).toEqual([]);
      expect(next.envelope.batch_seq).toBe(held.envelope.batch_seq + 2);
      expect(next.envelope.dropped).toEqual([
        [held.envelope.last_seq + 1, next.envelope.first_seq - 1],
      ]);
      const [first, last] = next.envelope.dropped[0];
      expect(last - first + 1).toBe(droppedAfter);
      expect(got.filter((b) => b.envelope.dropped.length > 0)).toEqual([next]);
      // Every seq is delivered or in that range, once.
      const delivered = got.flatMap(seqsOf);
      const end = delivered[delivered.length - 1];
      const expected: number[] = [];
      for (let s = 1; s <= end; s++)
        if (s < first || s > last) expected.push(s);
      expect(delivered).toEqual(expected);

      // The assembled log has one Gap, of exactly that range.
      const records = assemble(ingest.batches.map((b) => b.body));
      expect(records.filter((r) => r.record === "Gap")).toEqual([
        {
          record: "Gap",
          first_seq: BigInt(first),
          last_seq: BigInt(last),
          reason: 1,
        },
      ]);
      expect(records[records.length - 1].record).toBe("End");
    },
    TIMEOUT,
  );

  it(
    "transport_sends_nothing_without_consent",
    async () => {
      const dnt =
        "Object.defineProperty(Navigator.prototype, 'doNotTrack', " +
        "{ get() { return '1'; }, configurable: true });";
      const gpc =
        "Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', " +
        "{ get() { return true; }, configurable: true });";
      interface Case {
        name: string;
        config: unknown;
        install: string[];
        query: string;
        init?: string;
        /** The requests the ingest must see: none, the config alone, or batches. */
        want: "nothing" | "config-only" | "batches";
      }
      const cases: Case[] = [
        {
          name: "dnt",
          config: { enabled: true },
          install: [],
          query: "",
          init: dnt,
          want: "nothing",
        },
        {
          name: "gpc",
          config: { enabled: true },
          install: [],
          query: "",
          init: gpc,
          want: "nothing",
        },
        // Learning that recording is disabled takes the config request
        // itself, and nothing follows it.
        {
          name: "disabled",
          config: { enabled: false },
          install: [],
          query: "",
          want: "config-only",
        },
        {
          name: "consent-refused",
          config: { enabled: true },
          install: ["--consent-required"],
          query: "?consent=no",
          want: "nothing",
        },
        {
          name: "consent-never-asked",
          config: { enabled: true },
          install: ["--consent-required"],
          query: "",
          want: "nothing",
        },
        // The configuration requires consent the page never gives: the
        // config request, then nothing.
        {
          name: "config-requires-consent",
          config: { enabled: true, consent_required: true },
          install: [],
          query: "",
          want: "config-only",
        },
        // Vacuity guards, in the same run: consent given, and no consent
        // required, each upload.
        {
          name: "consent-given",
          config: { enabled: true },
          install: ["--consent-required"],
          query: "?consent=yes",
          want: "batches",
        },
        {
          name: "no-consent-needed",
          config: { enabled: true },
          install: [],
          query: "",
          want: "batches",
        },
      ];
      const results = await Promise.all(
        cases.map(async (c) => {
          const ingest = await stub(c.config);
          const server = await site(ingest, c.install);
          const context = await browser.newContext();
          let installed: boolean;
          try {
            const page = await context.newPage();
            if (c.init !== undefined)
              await page.addInitScript({ content: c.init });
            await page.goto(`${server.origin}/transport.html${c.query}`);
            for (let i = 0; i < 3; i++) await page.click("#one");
            expect(await textOf(page, "clicks"), c.name).toBe("3");
            installed = await page.evaluate(
              () => "__ctBoundaryShim" in globalThis,
            );
            await sleep(400);
            // Leave the page: pagehide is where a beacon would go.
            await page.goto("about:blank");
            await sleep(400);
          } finally {
            await context.close();
          }
          return { c, ingest, installed };
        }),
      );
      for (const { c, ingest, installed } of results) {
        const seen = ingest.requests.map((r) => `${r.method} ${r.path}`);
        if (c.want === "nothing") {
          expect(seen, c.name).toEqual([]);
        } else if (c.want === "config-only") {
          expect(seen, c.name).toEqual([
            `GET ${new URL(ingest.base).pathname}/config`,
          ]);
        } else {
          expect(ingest.batches.length, c.name).toBeGreaterThan(0);
          // The session's final batch went at pagehide.
          expect(
            ingest.batches.some((b) => b.parsed.envelope.final),
            c.name,
          ).toBe(true);
        }
        // With a privacy signal the recorder does not start at all.
        expect(installed, c.name).toBe(c.init === undefined);
      }
    },
    TIMEOUT,
  );

  it(
    "transport_flushes_at_256_records_or_50_ms",
    async () => {
      const ingest = await stub();
      const server = await site(ingest);
      const context = await browser.newContext();
      let sends: Send[];
      let runs: TickRun[];
      try {
        const page = await context.newPage();
        // Before the shim: the shim captures this wrapper as `fetch`, so the
        // transport's requests pass through it (see the header).
        await page.addInitScript({ content: SEND_RECORDER });
        await page.goto(`${server.origin}/transport.html`);
        await until(() => status(page), idle, "the transport did not go idle");
        // A known rate: a 5 ms interval, each tick a Task and a Clock.
        await page.click("#ticks");
        await until(
          () => textOf(page, "ticks-done"),
          (t) => t === "150",
          "the ticks did not finish",
        );
        await until(() => status(page), idle, "the transport did not go idle");
        // A burst: 600 records in one task.
        await page.click("#burst-600");
        await until(
          () => textOf(page, "burst-done"),
          (t) => t === "600",
          "the burst did not finish",
        );
        await until(() => status(page), idle, "the transport did not go idle");
        sends = await sendsOf(page);
        runs = await tickRunsOf(page);
      } finally {
        await context.close();
      }
      const sent = sendTimes(sends);
      const got = ingest.batches.map((b) => b.parsed);
      expect(sent.size).toBe(got.length);
      // At most 256 records per batch.
      for (const b of got) {
        expect(
          b.records.length,
          `batch ${b.envelope.batch_seq}`,
        ).toBeLessThanOrEqual(256);
      }
      // The deadline each batch was due under: 50 ms for the first 8, then
      // doubled by each batch the deadline cut (§11.1). The transport
      // reports the same deadline when it sends each batch.
      const schedule = deadlineSchedule(ingest.batches);
      for (const [seq, s] of sent) {
        expect(s.deadline, `batch ${seq}`).toBe(schedule.get(seq));
        if (seq < FAST_BATCHES) expect(s.deadline).toBe(DEADLINE_MS);
      }
      // The page reported its one run of ticks, the due times' grid.
      expect(runs.map((r) => r.interval)).toEqual([5]);
      const { oldestWait, stalls, unseen, timed } = checkWaits(
        got,
        sent,
        (b) => schedule.get(b)!,
        runs,
      );
      // Most batches met their deadline outright.
      expect(stalls + unseen, "batches excused").toBeLessThan(got.length / 2);
      // Vacuity guards: the ticks were timed, a batch was cut by the count
      // (exactly 256 records), and one of the first 8 by the 50 ms deadline
      // (fewer records, its oldest timed record having waited a good part
      // of the 50 ms), so the 50 ms bound was exercised; and the deadline
      // grew past 50 ms in the run.
      expect(timed).toBeGreaterThanOrEqual(150);
      expect(got.some((b) => b.records.length === 256)).toBe(true);
      expect(
        got.some(
          (b) =>
            b.envelope.batch_seq < FAST_BATCHES &&
            b.records.length < 256 &&
            (oldestWait.get(b.envelope.batch_seq) ?? 0) >= 20,
        ),
      ).toBe(true);
      expect(Math.max(...schedule.values())).toBeGreaterThan(DEADLINE_MS);
      expect(stalls, "batches excused by a stalled page").toBeLessThanOrEqual(
        2,
      );
      // The transport added nothing to the log: its flush timers (one per
      // batch here) and its requests went through the originals, so the log
      // holds no timeout registration (the page registers only its
      // interval) and no request to the ingest.
      const all = got.flatMap((b) => b.records);
      expect(got.length).toBeGreaterThan(3);
      expect(all.filter((r) => r.record === "TaskReg" && r.kind === 1)).toEqual(
        [],
      );
      expect(
        all.filter((r) => r.record === "TaskReg" && r.kind === 2).length,
      ).toBe(1);
      expect(
        all.filter(
          (r) => r.record === "NetRequest" && r.url.startsWith(ingest.base),
        ),
      ).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    "transport_flush_timer_fires_at_its_aim",
    async () => {
      // §11.1: the flush timer is aimed FLUSH_TIMER_LEAD_MS (10 ms) ahead of
      // the deadline, the room a timer has to run late on a busy page. While
      // a page runs a short repeating timer, Chromium runs a timer of 32 ms
      // or more at that timer's next wake-up, after its tick: on a page
      // ticking every 5 ms, up to 5 ms after it was due (shorter timers run
      // on time). A transport that waited for its aim with one long timer
      // spent half the lead there, and the page's tick due after the aim ran
      // before the flush (under load the batch then left past its
      // deadline). The batches of the 5 ms page are cut by the deadline (50
      // ms, then doubling) until they reach 256 records; how late past its
      // aim each leaves is the wait of its oldest timed record less the aim.
      // With one long timer the median was 4 to 5 ms.
      const ingest = await stub();
      const server = await site(ingest);
      const context = await browser.newContext();
      let sends: Send[];
      try {
        const page = await context.newPage();
        await page.addInitScript({ content: SEND_RECORDER });
        await page.goto(`${server.origin}/transport.html`);
        await until(() => status(page), idle, "the transport did not go idle");
        await page.click("#ticks");
        await until(
          () => textOf(page, "ticks-done"),
          (t) => t === "150",
          "the ticks did not finish",
        );
        await until(() => status(page), idle, "the transport did not go idle");
        sends = await sendsOf(page);
      } finally {
        await context.close();
      }
      const sent = sendTimes(sends);
      const schedule = deadlineSchedule(ingest.batches);
      const bits = Buffer.alloc(8);
      const late: number[] = [];
      for (const { parsed: b } of ingest.batches) {
        const seq = b.envelope.batch_seq;
        if (b.records.length >= 256 || !sent.has(seq)) continue;
        let wait = -Infinity;
        for (const r of b.records) {
          if (r.record !== "Clock" || r.src !== 2) continue;
          bits.writeBigUInt64LE(r.bits);
          wait = Math.max(wait, sent.get(seq)!.t - bits.readDoubleLE(0));
        }
        if (!Number.isFinite(wait)) continue;
        late.push(wait - (schedule.get(seq)! - FLUSH_TIMER_LEAD_MS));
      }
      // Vacuity: enough batches cut by the deadline, each with a timed record.
      expect(late.length, "deadline-cut batches").toBeGreaterThanOrEqual(6);
      late.sort((a, b) => a - b);
      const median = late[late.length >> 1];
      expect(
        median,
        `each batch's lateness past its aim, in ms: ${JSON.stringify(late)}`,
      ).toBeLessThan(2);
    },
    TIMEOUT,
  );

  it(
    "transport_backs_off_its_flush_deadline_when_batches_are_cut_by_it",
    async () => {
      // A page that keeps writing a few records at a time must not make a
      // request every 50 ms: the ingest allows 600 requests per client and
      // site key a minute, and 4096 batches a session. First a steady 25 ms
      // timer (80 records a second: every batch is cut by the deadline,
      // which doubles after the first 8 batches up to its 2 s cap), then a
      // steady 5 ms timer (400 records a second: batches are cut at 256
      // records, which leaves the deadline as it is).
      const ingest = await stub();
      const server = await site(ingest);
      const context = await browser.newContext();
      let sends: Send[];
      let runs: TickRun[];
      let fastFrom: number;
      try {
        const page = await context.newPage();
        await page.addInitScript({ content: SEND_RECORDER });
        await page.goto(`${server.origin}/transport.html`);
        await until(() => status(page), idle, "the transport did not go idle");
        await page.click("#steady-slow");
        await until(
          () => textOf(page, "steady-done"),
          (t) => t === "480",
          "the 25 ms ticks did not finish",
          60_000,
        );
        await until(
          () => status(page),
          idle,
          "the transport did not go idle",
          10_000,
        );
        await page.evaluate(() => {
          document.getElementById("steady-done")!.textContent = "";
        });
        fastFrom = await page.evaluate(() => performance.now());
        await page.click("#steady-fast");
        await until(
          () => textOf(page, "steady-done"),
          (t) => t === "2000",
          "the 5 ms ticks did not finish",
          60_000,
        );
        await until(
          () => status(page),
          idle,
          "the transport did not go idle",
          10_000,
        );
        sends = await sendsOf(page);
        runs = await tickRunsOf(page);
      } finally {
        await context.close();
      }
      const sent = sendTimes(sends);
      const got = ingest.batches.map((b) => b.parsed);
      expect(sent.size).toBe(got.length);
      const schedule = deadlineSchedule(ingest.batches);
      const order = [...sent.keys()].sort((a, b) => a - b);
      // The transport's deadline is the rule's, batch by batch; the first 8
      // batches are due at 50 ms; it never exceeds the cap, and reaches it.
      for (const seq of order) {
        const d = sent.get(seq)!.deadline;
        expect(d, `batch ${seq}`).toBe(schedule.get(seq));
        if (seq < FAST_BATCHES) expect(d, `batch ${seq}`).toBe(DEADLINE_MS);
        expect(d).toBeLessThanOrEqual(DEADLINE_MAX_MS);
      }
      // The ramp: 50 ms x 8, then each deadline-cut batch doubles it.
      const distinct = [...new Set(order.map((s) => sent.get(s)!.deadline))];
      expect(distinct).toEqual([50, 100, 200, 400, 800, 1600, 2000]);
      for (const b of got) {
        expect(
          b.records.length,
          `batch ${b.envelope.batch_seq}`,
        ).toBeLessThanOrEqual(256);
      }
      const sentAt = new Map([...sent].map(([k, s]) => [k, s.t]));
      // The page reported its two runs of ticks, the due times' grids: the
      // 25 ms one, then the 5 ms one, started after `fastFrom`.
      expect(runs.map((r) => r.interval)).toEqual([25, 5]);
      expect(runs[1].t0).toBeGreaterThanOrEqual(fastFrom);
      const { oldestWait, stalls, unseen } = checkWaits(
        got,
        sent,
        (b) => schedule.get(b)!,
        runs,
      );
      // Most batches met their deadline outright.
      expect(stalls + unseen, "batches excused").toBeLessThan(got.length / 2);
      expect(stalls, "batches excused by a stalled page").toBeLessThanOrEqual(
        2,
      );
      // At the cap, in the slow phase: batches cut by the 2 s deadline,
      // whose oldest record really waited most of it, sent about 2 s apart:
      // 30 requests a minute.
      const slowAtCap = order.filter(
        (s) =>
          sentAt.get(s)! < fastFrom &&
          sent.get(s)!.deadline === DEADLINE_MAX_MS &&
          got[s].records.length < 256,
      );
      expect(slowAtCap.length).toBeGreaterThanOrEqual(2);
      for (const s of slowAtCap) {
        expect(oldestWait.get(s) ?? 0, `batch ${s}`).toBeGreaterThanOrEqual(
          1500,
        );
      }
      for (let i = 1; i < slowAtCap.length; i++) {
        if (slowAtCap[i] !== slowAtCap[i - 1] + 1) continue;
        expect(
          sentAt.get(slowAtCap[i])! - sentAt.get(slowAtCap[i - 1])!,
        ).toBeGreaterThanOrEqual(1900);
      }
      // The fast phase: full batches of 256 records, each sent long before
      // the 2 s deadline, which they leave as it was.
      const fast = order.filter((s) => sentAt.get(s)! >= fastFrom);
      const full = fast.filter((s) => got[s].records.length === 256);
      expect(full.length).toBeGreaterThanOrEqual(10);
      for (const s of fast) {
        expect(sent.get(s)!.deadline, `batch ${s}`).toBe(DEADLINE_MAX_MS);
      }
      for (const s of full) {
        expect(oldestWait.get(s) ?? 0, `batch ${s}`).toBeLessThan(1500);
      }
      // Between the first full batch and the last batch of the run, every
      // batch is full: none leaves before its oldest record's deadline (a
      // flush timer armed for a record a full batch took is cancelled with
      // it, or it would fire early and send a part batch).
      for (const s of fast.filter(
        (x) => x > full[0] && x < fast[fast.length - 1],
      )) {
        expect(got[s].records.length, `batch ${s}`).toBe(256);
      }
      // Every record arrived: one contiguous run of seqs, no drops.
      const seqs = got.flatMap(seqsOf);
      expect(seqs).toEqual(seqs.map((_, i) => i + 1));
      expect(got.every((b) => b.envelope.dropped.length === 0)).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "transport_final_flush_carries_no_ingest_cookie",
    async () => {
      // The ingest's host on another site than the page (localhost against
      // 127.0.0.1), holding a SameSite=None cookie: what a visitor signed in
      // to the ingest's host elsewhere carries. A request with credentials
      // sends it; the transport's final flush, at pagehide, must not.
      const ingest = await stub({ enabled: true }, { host: "localhost" });
      const server = await site(ingest);
      const context = await browser.newContext();
      await context.addCookies([
        {
          name: "ct_visitor",
          value: "signed-in",
          domain: "localhost",
          path: "/",
          secure: true,
          sameSite: "None",
        },
      ]);
      const isControl = (r: { path: string }) =>
        r.path.endsWith("/control-beacon");
      const batchRequests = () =>
        ingest.requests.filter(
          (r) => r.method === "POST" && r.path.endsWith("/batches"),
        );
      try {
        const page = await context.newPage();
        await page.goto(`${server.origin}/transport.html`);
        await until(() => status(page), idle, "the transport did not go idle");
        // Positive control: a beacon the page sends to the ingest carries
        // the cookie (a beacon's credentials mode is always include), and
        // the ingest refuses it.
        // (Its own path, so the batches the shim uploads meanwhile, which
        // record the page's beacon, are not mistaken for it.)
        expect(
          await page.evaluate(
            (url: string) => navigator.sendBeacon(url, new Blob(["x"])),
            `${ingest.base}/control-beacon`,
          ),
        ).toBe(true);
        const control = (await until(
          async () => ingest.requests.find(isControl),
          (r) => r !== undefined && r.status !== undefined,
          "the page's beacon did not arrive",
        ))!;
        expect(control.cookie).toBe("ct_visitor=signed-in");
        expect(control.status).toBe(403);
        // Records waiting at pagehide, then leave the page.
        for (let i = 0; i < 3; i++) await page.click("#one");
        await page.goto(`${server.origin}/transport-consent.html`);
        await until(
          async () => ingest.batches.some((b) => b.parsed.envelope.final),
          (f) => f,
          "the final batch did not arrive",
        );
      } finally {
        await context.close();
      }
      // The final batch was accepted, carrying End, and no request of the
      // transport carried the cookie: the page's beacon is the only one.
      const final = ingest.batches.find((b) => b.parsed.envelope.final)!;
      expect(final.parsed.records.some((r) => r.record === "End")).toBe(true);
      const withCookie = ingest.requests.filter((r) => r.cookie !== undefined);
      expect(withCookie.map(isControl), JSON.stringify(withCookie)).toEqual([
        true,
      ]);
      expect(ingest.requests.filter((r) => r.status === 403).length).toBe(1);
      // Vacuity guard: the transport made batch requests, every one after
      // the cookie existed.
      expect(batchRequests().length).toBeGreaterThanOrEqual(2);
      // The whole session assembles without a Gap.
      const records = assemble(ingest.batches.map((b) => b.body));
      expect(records.filter((r) => r.record === "Gap")).toEqual([]);
      expect(records[records.length - 1].record).toBe("End");
    },
    TIMEOUT,
  );

  it(
    "transport_reads_the_page_visibility_without_logging_it_as_the_page",
    async () => {
      // The page's reads of `document.visibilityState` are logged (§10.1);
      // the transport reads it too, at every `visibilitychange`, to send
      // what waits when the page is hidden, and its read is none of the
      // page's: through the captured original it writes no record.
      const ingest = await stub();
      const server = await site(ingest);
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.goto(`${server.origin}/transport.html`);
        await until(() => status(page), idle, "the transport did not go idle");
        // The page reads the state once, then a `visibilitychange` reaches
        // the transport's listener (dispatched by the page: headless
        // Chromium never hides a page, and the transport reacts to any).
        await page.evaluate(() => {
          void document.visibilityState;
          document.dispatchEvent(new Event("visibilitychange"));
          document.dispatchEvent(new Event("visibilitychange"));
        });
        await page.goto(`${server.origin}/transport-consent.html`);
        await until(
          async () => ingest.batches.some((b) => b.parsed.envelope.final),
          (f) => f,
          "the final batch did not arrive",
        );
      } finally {
        await context.close();
      }
      const records = assemble(ingest.batches.map((b) => b.body));
      const reads = records.filter(
        (r) =>
          r.record === "PlatformValue" &&
          r.query === "document.visibilityState",
      );
      // The page's one read, and none of the transport's two.
      expect(reads).toHaveLength(1);
      expect(records[records.length - 1].record).toBe("End");
    },
    TIMEOUT,
  );

  it(
    "transport_leaves_back_forward_cache_eligibility_unchanged",
    async () => {
      // Chromium reports why a page was not restored from the back/forward
      // cache (`Page.backForwardCacheNotUsed`) even where the embedder
      // keeps the cache off, as headless Chromium does: the reasons are the
      // page's eligibility. Playwright also launches with
      // `--disable-back-forward-cache`, which this browser does not, so
      // the page's own reasons are reported. The fixture server serves the
      // page `Cache-Control: no-store`, the case where a script's request
      // can cost a page its eligibility.
      const bf = await chromium().launch({
        headless: true,
        ignoreDefaultArgs: ["--disable-back-forward-cache"],
      });
      /** Load the page, act, leave it and come back: the reasons. */
      const reasons = async (
        origin: string,
        act: (page: TPage) => Promise<void> = async () => undefined,
      ): Promise<string[]> => {
        const context = await bf.newContext();
        try {
          const page = await context.newPage();
          const cdp = await context.newCDPSession(page);
          const seen: string[] = [];
          cdp.on("Page.backForwardCacheNotUsed", (e) => {
            const ex = (e as { notRestoredExplanations: { reason: string }[] })
              .notRestoredExplanations;
            for (const x of ex) seen.push(x.reason);
          });
          await cdp.send("Page.enable");
          await page.goto(`${origin}/transport.html`);
          await page.click("#one");
          await act(page);
          await page.goto(`${origin}/elsewhere.html`);
          await page.goBack();
          await until(
            async () => seen.length,
            (n) => n > 0,
            "Chromium reported no back/forward cache outcome",
          );
          return [...new Set(seen)].sort();
        } finally {
          await context.close();
        }
      };
      const serve = async (dir: string): Promise<string> => {
        fs.writeFileSync(path.join(dir, "elsewhere.html"), "<p>elsewhere</p>");
        const s = await startFixtureServer(dir);
        servers.push(s);
        return s.origin;
      };
      try {
        // Without the shim.
        const plainDir = copyFixtures();
        tmpDirs.push(plainDir);
        const plain = await serve(plainDir);
        const baseline = await reasons(plain);

        // The transport open and idle, then with a batch in flight.
        const idleIngest = await stub();
        const idleSite = await site(idleIngest);
        const withIdle = await reasons(await serve(idleSite.dir), async (p) => {
          await until(() => status(p), idle, "the transport did not go idle");
          expect(idleIngest.batches.length).toBeGreaterThan(0);
        });
        const busyIngest = await stub();
        const busySite = await site(busyIngest);
        const withBusy = await reasons(await serve(busySite.dir), async (p) => {
          await until(() => status(p), idle, "the transport did not go idle");
          busyIngest.stall();
          await p.click("#burst-600");
          await until(
            async () => busyIngest.held(),
            (n) => n === 1,
            "no batch was in flight",
          );
        });
        busyIngest.release();
        expect(withIdle).toEqual(baseline);
        expect(withBusy).toEqual(baseline);

        // Positive controls, in the same run: the probe sees a blocker the
        // page adds (an unload handler), and the one an ingest answering
        // `no-store` would add to this page through the transport.
        const withUnload = await reasons(plain, async (p) => {
          await p.evaluate(() => {
            window.onunload = () => undefined;
          });
        });
        expect(withUnload.filter((r) => !baseline.includes(r))).not.toEqual([]);
        const noStoreIngest = await stub({ enabled: true }, { noStore: true });
        const noStoreSite = await site(noStoreIngest);
        const withNoStore = await reasons(
          await serve(noStoreSite.dir),
          async (p) => {
            await until(() => status(p), idle, "the transport did not go idle");
          },
        );
        expect(withNoStore).toContain(
          "JsNetworkRequestReceivedCacheControlNoStoreResource",
        );
        expect(baseline).not.toContain(
          "JsNetworkRequestReceivedCacheControlNoStoreResource",
        );
      } finally {
        await bf.close();
      }
    },
    TIMEOUT,
  );

  it(
    "transport_session_with_consent_replays_without_divergence",
    async () => {
      // The consent callback runs page code (a boundary read). Record mode
      // calls it inside `__ctBoundaryShim.consent`, and so does replay mode:
      // the uploaded session, assembled, replays to its End.
      const ingest = await stub();
      const server = await site(ingest, ["--consent-required"], true);
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.goto(`${server.origin}/transport-consent.html`);
        for (let i = 0; i < 3; i++) await page.click("#one");
        expect(await textOf(page, "clicks")).toBe("3");
        await page.evaluate(() =>
          (
            globalThis as unknown as {
              __ctBoundaryShim: { stop(): Promise<void> };
            }
          ).__ctBoundaryShim.stop(),
        );
      } finally {
        await context.close();
      }
      expect(ingest.batches.some((b) => b.parsed.envelope.final)).toBe(true);
      const dir = tmp("ct-transport-batches-");
      ingest.batches.forEach((b, i) =>
        fs.writeFileSync(path.join(dir, String(i)), b.body),
      );
      const ct = path.join(tmp("ct-transport-ct-"), "session.ct");
      const r = spawnSync(
        CT_JSBOUND,
        ["assemble", "--recording-id", RECORDING_ID, "--out", ct, dir],
        { encoding: "utf-8" },
      );
      expect(r.status, r.stderr).toBe(0);
      // Vacuity guard: the callback's read is in the log, the first record
      // of the page script's task (the script registers it as it runs).
      const records = loadBoundaryLog(ct).records;
      const script = records.findIndex(
        (x) => x.record === "DocTask" && x.src.endsWith("/transport.js"),
      );
      expect(script).toBeGreaterThan(0);
      expect(records[script + 1]).toMatchObject({ record: "Clock", src: 1 });

      const report = await replaySession({
        log: ct,
        build: server.dir,
        browser: browser as unknown as Parameters<
          typeof replaySession
        >[0]["browser"],
        timeoutMs: 60_000,
      });
      expect(report.divergence).toBeUndefined();
      expect(report.status, report.error).toBe("replayed");
    },
    TIMEOUT,
  );

  it(
    "transport_full_ring_costs_the_page_what_an_in_page_log_costs",
    async () => {
      // A ring at its cap evicts a frame on every append. That must cost
      // the page about what keeping the log in the page costs, however
      // many frames the ring holds: here the default 4 MiB ring holds about
      // 160,000, while consent is pending, so nothing leaves the page.
      const reads = async (
        base: string,
      ): Promise<{ ms: number; dropped?: number }> => {
        const context = await browser.newContext();
        try {
          const page = await context.newPage();
          await page.goto(`${base}/transport.html`);
          const burst = (n: number) =>
            page.evaluate((k: number) => {
              let s = 0;
              for (let i = 0; i < k; i++) s += Math.random();
              return s;
            }, n);
          await burst(200_000); // fills the ring
          const t0 = performance.now();
          await burst(200_000); // every read evicts one
          const ms = performance.now() - t0;
          return { ms, dropped: (await status(page))?.droppedRecords };
        } finally {
          await context.close();
        }
      };
      const ingest = await stub();
      const waiting = await site(ingest, ["--consent-required"]);
      const inPageDir = copyFixtures();
      tmpDirs.push(inPageDir);
      execFileSync(
        process.execPath,
        [
          CLI,
          "boundary-shim",
          path.join(inPageDir, "transport.html"),
          "--build-hash",
          FIXTURE_BUILD_HASH,
        ],
        { stdio: "pipe" },
      );
      const inPage = await startFixtureServer(inPageDir);
      servers.push(inPage);

      const ring = await reads(waiting.origin);
      const log = await reads(inPage.origin);
      // Vacuity guard: nothing was requested, so every frame stayed in the
      // ring, which overflowed by most of the second burst.
      expect(ingest.requests).toEqual([]);
      expect(ring.dropped).toBeGreaterThan(150_000);
      expect(log.dropped).toBeUndefined();
      // An eviction that moved the ring's entries made this about 100
      // times slower (33 s against 0.3 s, measured 2026-10-24).
      expect(
        ring.ms,
        `ring ${ring.ms} ms, in-page log ${log.ms} ms`,
      ).toBeLessThan(5 * log.ms + 500);
    },
    TIMEOUT,
  );

  it(
    "transport_deadline_oracle_fails_a_flush_timer_aimed_late",
    async () => {
      // Positive control of the oracle the flush-deadline tests rely on
      // (checkWaits): a transport whose flush timer is aimed 20 ms late
      // (10 ms past the deadline, so within LATE_TIMER_SLACK_MS: only the
      // ticks that came due after the aim can tell) must fail it, on the
      // 5 ms page and on the 25 ms one. An init script before the shim adds
      // 20 ms to every `setTimeout`, which the shim captures as the
      // original, so only the transport's timers are late (the page's ticks
      // are an interval).
      for (const c of [
        { button: "#ticks", n: "150" },
        { button: "#ticks-slow", n: "80" },
      ]) {
        const ingest = await stub();
        const server = await site(ingest);
        const context = await browser.newContext();
        let sends: Send[];
        let runs: TickRun[];
        try {
          const page = await context.newPage();
          await page.addInitScript({ content: SEND_RECORDER });
          await page.addInitScript({
            content:
              "(() => { const real = window.setTimeout; " +
              "window.setTimeout = function (f, d, ...a) { " +
              "return real.call(this, f, (Number(d) || 0) + 20, ...a); }; })();",
          });
          await page.goto(`${server.origin}/transport.html`);
          await until(
            () => status(page),
            idle,
            "the transport did not go idle",
          );
          await page.click(c.button);
          await until(
            () => textOf(page, "ticks-done"),
            (t) => t === c.n,
            "the ticks did not finish",
          );
          await until(
            () => status(page),
            idle,
            "the transport did not go idle",
          );
          sends = await sendsOf(page);
          runs = await tickRunsOf(page);
        } finally {
          await context.close();
        }
        const sent = sendTimes(sends);
        const got = ingest.batches.map((b) => b.parsed);
        expect(sent.size, c.button).toBe(got.length);
        expect(runs.length, c.button).toBe(1);
        const schedule = deadlineSchedule(ingest.batches);
        expect(
          () => checkWaits(got, sent, (b) => schedule.get(b)!, runs),
          c.button,
        ).toThrow(/came due after the aim/);
      }
    },
    TIMEOUT,
  );

  it(
    "transport_waits_for_an_answer_without_spinning_its_timer",
    async () => {
      // While a batch is in flight nothing more can be sent, so the flush
      // timer must wait for the answer instead of firing again and again
      // at a deadline already past. The transport's timers are counted by
      // wrapping `setTimeout` before the shim, which captures the wrapper as
      // the original (the page's own timer here is an interval).
      const ingest = await stub();
      const server = await site(ingest);
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.addInitScript({
          content:
            "(() => { const real = window.setTimeout; window.__ctTimeouts = 0; " +
            "window.setTimeout = function () { window.__ctTimeouts += 1; " +
            "return real.apply(this, arguments); }; })();",
        });
        await page.goto(`${server.origin}/transport.html`);
        await until(() => status(page), idle, "the transport did not go idle");
        const timeouts = () =>
          page.evaluate(
            () =>
              (globalThis as unknown as { __ctTimeouts: number }).__ctTimeouts,
          );
        const ticks = async (n: string) => {
          await page.click("#ticks");
          await until(
            () => textOf(page, "ticks-done"),
            (t) => t === n,
            "the ticks did not finish",
          );
        };

        // Positive control: an answered run of ticks (750 ms) arms a timer
        // per batch, about fifteen.
        const c0 = await timeouts();
        await ticks("150");
        await until(() => status(page), idle, "the transport did not go idle");
        const answered = (await timeouts()) - c0;
        expect(answered).toBeGreaterThanOrEqual(5);

        // The ingest holds the next batch for as long as another run of
        // ticks takes, so their records wait past their deadline.
        await page.evaluate(() => {
          document.getElementById("ticks-done")!.textContent = "";
        });
        ingest.stall();
        await page.click("#one");
        await until(
          async () => ingest.held(),
          (n) => n === 1,
          "no batch was held by the stalled ingest",
        );
        const c1 = await timeouts();
        await ticks("150");
        const whileHeld = (await timeouts()) - c1;
        ingest.release();
        await until(() => status(page), idle, "the transport did not go idle");
        expect(whileHeld).toBeLessThanOrEqual(2);
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );
});

/**
 * The oracle of the flush-deadline tests ({@link checkWaits}) on batches
 * made up here, each case the shape of a run the browser can produce: the
 * checks the browser tests rely on, held to cases that would otherwise come
 * up once in tens of runs under load. No browser and no transport: the
 * input is what the browser tests hand the oracle.
 */
describe("the flush-deadline oracle", () => {
  /** A batch whose timed records are page reads at these times. */
  function batchOf(seq: number, ran: number[]): ParsedBatch {
    const bits = Buffer.alloc(8);
    return {
      envelope: { batch_seq: seq },
      records: ran.map((t) => {
        bits.writeDoubleLE(t);
        return { record: "Clock", src: 2, bits: bits.readBigUInt64LE(0) };
      }),
      frames: new Uint8Array(),
    } as unknown as ParsedBatch;
  }
  /** Page reads 5 ms apart, from `a` to `b`. */
  function onTime(a: number, b: number): number[] {
    const out: number[] = [];
    for (let t = a; t <= b; t += 5) out.push(t);
    return out;
  }
  /** Page reads 25 ms apart, from `a` to `b`. */
  function every25(a: number, b: number): number[] {
    return onTime(a, b).filter((t) => (t - a) % 25 === 0);
  }
  // A run of ticks started at 595, so its grid is the multiples of 5.
  const RUNS = [{ t0: 595, interval: 5, ticks: 1000 }];
  // Batch 1 holds the ticks from 630 (its oldest record) under a 200 ms
  // deadline: the flush timer is aimed at 820.
  const deadline = () => 200;

  it("oracle_excuses_a_tick_due_before_the_aim_that_ran_after_it", () => {
    // The issue's run: the tick due at the aim (820) ran 4.7 ms after it,
    // and the flush timer, due at the aim too, ran after it in due order;
    // the batch left 3.9 ms past its deadline.
    const got = [
      batchOf(0, onTime(600, 625)),
      batchOf(1, [...onTime(630, 815), 824.7]),
    ];
    const sends = new Map([
      [0, { t: 626, answered: 627 }],
      [1, { t: 833.9 }],
    ]);
    const { unseen } = checkWaits(got, sends, deadline, RUNS);
    expect(unseen).toBe(1);
  });

  it("oracle_fails_a_tick_due_after_the_aim_that_ran_before_the_send", () => {
    // Positive control: the tick due at 825, after the aim, ran (on time)
    // before the batch left: the transport's timer was aimed late.
    const got = [
      batchOf(0, onTime(600, 625)),
      batchOf(1, [...onTime(630, 825)]),
    ];
    const sends = new Map([
      [0, { t: 626, answered: 627 }],
      [1, { t: 833.9 }],
    ]);
    expect(() => checkWaits(got, sends, deadline, RUNS)).toThrow(
      /came due after the aim/,
    );
  });

  it("oracle_excuses_ticks_due_while_the_batch_before_was_unanswered", () => {
    // The batch before was answered 16 ms after this batch's aim (820), and this
    // batch left at once: the ticks due at 825, 830 and 835 ran while nothing could be
    // sent (§11.1: the bound assumes the previous batch is answered in time).
    const got = [
      batchOf(0, onTime(600, 625)),
      batchOf(1, [...onTime(630, 835)]),
    ];
    const sends = new Map([
      [0, { t: 626, answered: 836 }],
      [1, { t: 836.5 }],
    ]);
    const { unseen } = checkWaits(got, sends, deadline, RUNS);
    expect(unseen).toBe(1);
  });

  it("oracle_fails_a_tick_due_after_the_answer_that_ran_before_the_send", () => {
    // Positive control: the answer came at 821, so the batch was due then;
    // the tick due at 825 ran first, so the transport did not send at once.
    const got = [
      batchOf(0, onTime(600, 625)),
      batchOf(1, [...onTime(630, 825)]),
    ];
    const sends = new Map([
      [0, { t: 626, answered: 821 }],
      [1, { t: 833.9 }],
    ]);
    expect(() => checkWaits(got, sends, deadline, RUNS)).toThrow(
      /came due after the aim/,
    );
  });

  it("oracle_excuses_a_delay_a_late_tick_shows_on_a_25_ms_page", () => {
    // A stalled renderer on a 25 ms page: the tick due at 825 ran 20 ms
    // late, at 845, and the batch, due at 825 (the aim 815), left 2.8 ms
    // after it, 22.8 ms late. The ticks either side of the aim are only
    // 45 ms apart: a stall shorter than three intervals still shows, in the
    // tick that waited it out.
    const slow = [{ t0: 475, interval: 25, ticks: 100 }];
    const got = [
      batchOf(0, every25(500, 600)),
      batchOf(1, [...every25(625, 800), 845]),
    ];
    const sends = new Map([
      [0, { t: 601, answered: 602 }],
      [1, { t: 847.8 }],
    ]);
    const { stalls } = checkWaits(got, sends, deadline, slow);
    expect(stalls).toBe(1);
  });

  it("oracle_fails_a_long_delay_no_tick_shows", () => {
    // Positive control: the batch left 20 ms late (due at 830, sent at
    // 850), and every tick ran on time: the page was running.
    const got = [
      batchOf(0, onTime(600, 625)),
      batchOf(1, [...onTime(630, 815)]),
    ];
    const sends = new Map([
      [0, { t: 626, answered: 627 }],
      [1, { t: 850 }],
    ]);
    expect(() => checkWaits(got, sends, deadline, RUNS)).toThrow(
      /20 ms of it shown by no tick/,
    );
  });

  it("oracle_fails_a_delay_longer_than_the_stall_a_tick_shows", () => {
    // Positive control: the last tick, due at 820, waited 10 ms (a stall
    // from 820 to 830), but the batch, due at 830, left at 860: the page
    // ran for 30 ms after the stall before the transport sent.
    const lastAt830 = [{ t0: 595, interval: 5, ticks: 45 }];
    const got = [
      batchOf(0, onTime(600, 625)),
      batchOf(1, [...onTime(630, 815), 830]),
    ];
    const sends = new Map([
      [0, { t: 626, answered: 627 }],
      [1, { t: 860 }],
    ]);
    expect(() => checkWaits(got, sends, deadline, lastAt830)).toThrow(
      /30 ms of it shown by no tick/,
    );
  });

  it("oracle_excuses_a_long_delay_the_ticks_show_as_a_stall", () => {
    // Nothing of the page ran from 815 to 850 (seven ticks missed), and the
    // batch went 30 ms late; the tick due at 820 ran last, at 850.
    const got = [
      batchOf(0, onTime(600, 625)),
      batchOf(1, [...onTime(630, 815), 850]),
    ];
    const sends = new Map([
      [0, { t: 626, answered: 627 }],
      [1, { t: 860 }],
    ]);
    const { stalls } = checkWaits(got, sends, deadline, RUNS);
    expect(stalls).toBe(1);
  });
});

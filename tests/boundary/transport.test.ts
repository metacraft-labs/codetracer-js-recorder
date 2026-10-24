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
 * - **The flush-deadline test wraps `fetch` in an init script** that runs
 *   before the shim, so the shim captures the wrapper as the original and
 *   the transport's requests pass through it: it notes the browser time of
 *   each batch request and calls the real `fetch`. Nothing else observes
 *   when a batch leaves the page in browser time. The timer-spin test
 *   wraps `setTimeout` the same way, only to count the transport's timers.
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
  options: { noStore?: boolean } = {},
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
      let sends: { t: number; body: number[] }[];
      try {
        const page = await context.newPage();
        // Before the shim: the shim captures this wrapper as `fetch`, so the
        // transport's requests pass through it (see the header).
        await page.addInitScript({
          content:
            "(() => { const real = window.fetch; " +
            "const now = performance.now.bind(performance); " +
            "window.__ctSends = []; " +
            "window.fetch = function (input, init) { " +
            "if (String(input).endsWith('/batches') && init && init.body) " +
            "window.__ctSends.push({ t: now(), body: Array.from(init.body) }); " +
            "return real.apply(this, arguments); }; })();",
        });
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
        sends = await page.evaluate(
          () =>
            (
              globalThis as unknown as {
                __ctSends: { t: number; body: number[] }[];
              }
            ).__ctSends,
        );
      } finally {
        await context.close();
      }
      // When each batch left the page, in browser time, by batch_seq.
      const sentAt = new Map<number, number>();
      for (const s of sends) {
        const b = parseBatch(Uint8Array.from(s.body));
        if (!sentAt.has(b.envelope.batch_seq))
          sentAt.set(b.envelope.batch_seq, s.t);
      }
      const got = ingest.batches.map((b) => b.parsed);
      expect(sentAt.size).toBe(got.length);
      const bits = Buffer.alloc(8);
      const waits: { batch: number; wait: number; size: number }[] = [];
      for (const b of got) {
        // At most 256 records per batch.
        expect(
          b.records.length,
          `batch ${b.envelope.batch_seq}`,
        ).toBeLessThanOrEqual(256);
        const t = sentAt.get(b.envelope.batch_seq)!;
        for (const r of b.records) {
          // A performance.now() read's value is the browser time it was
          // made, so its wait is the batch's send time minus its value.
          if (r.record === "Clock" && r.src === 2) {
            bits.writeBigUInt64LE(r.bits);
            waits.push({
              batch: b.envelope.batch_seq,
              wait: t - bits.readDoubleLE(0),
              size: b.records.length,
            });
          }
        }
      }
      // Vacuity guards: the ticks were timed, a batch was cut by the count
      // (exactly 256 records), and one by the deadline (fewer records, its
      // oldest timed record having waited a good part of the 50 ms).
      expect(waits.length).toBeGreaterThanOrEqual(150);
      expect(got.some((b) => b.records.length === 256)).toBe(true);
      expect(waits.some((w) => w.size < 256 && w.wait >= 20)).toBe(true);
      // The bound is browser time in which the page runs. When the operating
      // system does not schedule the renderer (seen under a 32-way CPU
      // load: a batch sent 64 ms after its oldest read, its window holding
      // 9 of the page's 5 ms ticks where 14 fit), nothing in the page runs,
      // the transport included, and the batch goes the moment the page runs
      // again. So a wait over 50 ms passes only when the page's own ticks
      // show that stall: none ran between the flush timer's aim (40 ms) and
      // the send (bar the one an overdue interval runs first, within 3 ms
      // of it), and the ticks either side of the aim are at least 15 ms
      // apart. A transport that sends late while the page runs still fails.
      const ticks = waits
        .map((w) => sentAt.get(w.batch)! - w.wait)
        .sort((a, b) => a - b);
      const oldestWait = new Map<number, number>();
      for (const w of waits) {
        expect(w.wait, `batch ${w.batch}`).toBeGreaterThanOrEqual(0);
        oldestWait.set(w.batch, Math.max(oldestWait.get(w.batch) ?? 0, w.wait));
      }
      let stalls = 0;
      for (const [batch, wait] of oldestWait) {
        if (wait <= 50) continue;
        const sent = sentAt.get(batch)!;
        const aim = sent - wait + 40;
        const ranMeanwhile = ticks.filter((v) => v > aim && v < sent - 3);
        const before = ticks.filter((v) => v <= aim).pop();
        const after = ticks.find((v) => v > aim);
        const detail = `batch ${batch}: waited ${wait} ms; ticks ${JSON.stringify(ranMeanwhile)} ran after the aim ${aim}`;
        expect(ranMeanwhile, detail).toEqual([]);
        expect(before, detail).toBeDefined();
        expect(after, detail).toBeDefined();
        expect(after! - before!, detail).toBeGreaterThanOrEqual(15);
        stalls += 1;
      }
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

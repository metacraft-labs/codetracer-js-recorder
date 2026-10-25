/**
 * Seeking in a boundary recording (CodeTracer's JS-Boundary-Recording
 * specification §5.5, §7.2, §7.3, §12): range materialisation through the
 * checkpoint index, and a missed boundary read localised at the first
 * checkpoint it disturbs.
 *
 * A browser heap cannot be restored, so `ct-boundary-replay --seq-from
 * --seq-to` replays from the start with the trace's emission off until the
 * last checkpoint at or before the range's start and stops at the first
 * checkpoint at or after its end, both found in `jsbound.chk`: a range
 * materialisation must hold exactly the events the full materialisation holds
 * between those two quiescent points. A checkpoint where an instrumented
 * frame is open (an `async` function suspended at an `await`) is not one: a
 * bound there moves out to the nearest checkpoint with no frame open
 * (`fixtures/seeking-async.html`).
 *
 * A session is recorded for real on `fixtures/seeking.html` (the generic shim
 * installed by the shipped deploy route, headless Chromium), assembled into a
 * `.ct` by codetracer's real `ct-jsbound assemble`, and replayed by the real
 * runner, which writes its traces through codetracer's real `record-web`
 * (`session-manager record-web`); the traces are read back with `ct-print`.
 *
 * One deliberate alteration, and no mocks: the missed-read case records and
 * replays with a build of the shim that has no `offsetWidth` seam, made here
 * from the shim's built modules by removing that one getter from its layout
 * table. It exists only in this test (never in the package), because it is a
 * shim with a known defect: the defect a checkpoint is there to catch.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as esbuild from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type BoundaryRecord,
  type CheckpointRow,
  decodeLog,
  type RecordOf,
} from "../../packages/boundary-format/src/index.js";
import {
  quiescentBounds,
  rangeBounds,
  readCtfsMember,
  type ReplayOptions,
  type ReplayReport,
  replaySession,
} from "../../packages/boundary-replay/src/index.js";
import {
  type CtFullEvent,
  type CtFullValue,
  ctPrintFull,
  requireCtPrint,
} from "../helpers/ct-print.js";
import {
  expectReplayed,
  indexWhere,
  type Page,
  type RecordReplay,
  replaced,
  startRecordReplay,
} from "./record-replay.js";
import {
  assembleRecording,
  ctJsboundPath,
  sessionManagerPath,
} from "./siblings.js";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const TIMEOUT = 600_000;
/** Clicks on #go (the fixture's CLICKS): each is followed by a checkpoint. */
const CLICKS = 6;
/** The key of the storage read right before the fixture's offsetWidth read. */
const WIDTH_ANCHOR = "seeking-before-offsetWidth";

let SESSION_MANAGER: string;
let CT_JSBOUND: string;
/** The shipped shim: the session every range is cut from. */
let shipped: RecordReplay;
let records: BoundaryRecord[];
let ct: string;

/** Click #go CLICKS times, each once the previous click has finished. */
async function clickThrough(page: Page): Promise<void> {
  for (let n = 1; n <= CLICKS; n++) {
    await page.click("#go");
    // Polled from Node: an in-page poll would be recorded as the page's.
    const deadline = Date.now() + 20_000;
    while (
      (await page.evaluate(() =>
        document.body.getAttribute("data-finished"),
      )) !== String(n)
    ) {
      if (Date.now() > deadline) throw new Error(`click ${n} did not finish`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

function assemble(rr: RecordReplay, rs: BoundaryRecord[]): string {
  return assembleRecording(
    CT_JSBOUND,
    rs,
    rr.tmp("ct-seek-batches-"),
    rr.tmp("ct-seek-ct-"),
  );
}

/** Replay `log` against the shipped build, writing a trace. */
async function materialise(
  log: string,
  range: Partial<ReplayOptions> = {},
): Promise<{ report: ReplayReport; out: string }> {
  const out = path.join(shipped.tmp("ct-seek-out-"), "trace.ct");
  const report = await replaySession({
    log,
    build: shipped.build,
    out,
    sessionManager: SESSION_MANAGER,
    browser: shipped.browser,
    timeoutMs: 120_000,
    ...range,
  });
  return { report, out };
}

/** The `Checkpoint` records of `rs`, in log order. */
const checkpointsOf = (rs: BoundaryRecord[]): RecordOf<"Checkpoint">[] =>
  rs.filter((r): r is RecordOf<"Checkpoint"> => r.record === "Checkpoint");

/** A decoded value without its trace-local type id (interned per trace). */
function value(v: CtFullValue | undefined): unknown {
  if (v === undefined) return undefined;
  const { type_id: _typeId, elements, field_values, ...rest } = v;
  return {
    ...rest,
    ...(elements === undefined ? {} : { elements: elements.map(value) }),
    ...(field_values === undefined
      ? {}
      : { field_values: field_values.map(value) }),
  };
}

/**
 * An event as it reads in any trace: positions, keys and interned ids are
 * trace-local (record-web interns paths, functions, names and types in the
 * order it first sees them), so they are left out; names, lines, depths and
 * values are kept.
 */
function normalised(e: CtFullEvent): unknown {
  switch (e.kind) {
    case "step":
      return {
        kind: e.kind,
        path: e.path,
        line: e.line,
        step_kind: e.step_kind,
        function: e.function,
        depth: e.depth,
        vars: e.vars.map((v) => [v.varname, value(v.value)]),
      };
    case "call_entry":
      return {
        kind: e.kind,
        function: e.function,
        depth: e.depth,
        args: e.args.map((a) => [a.varname, value(a.value)]),
      };
    case "call_exit":
      return {
        kind: e.kind,
        function: e.function,
        depth: e.depth,
        return_value: value(e.return_value),
      };
    case "io":
      return {
        kind: e.kind,
        io_kind: e.io_kind,
        text: e.text,
        bytes_b64: e.bytes_b64,
        metadata: e.metadata,
      };
    default:
      return { kind: e.kind };
  }
}

/** Where a trace is: steps, calls entered and calls returned so far. */
interface Position {
  steps: number;
  calls: number;
  returns: number;
}

/**
 * The events of `events` (a whole trace, in stream order) between positions
 * `a` (inclusive) and `b` (exclusive): each step by its index, each call
 * entry and exit by how many came before it.
 */
function slice(events: CtFullEvent[], a: Position, b: Position): unknown[] {
  const out: unknown[] = [];
  let calls = 0;
  let returns = 0;
  for (const e of events) {
    let at: number;
    let lo: number;
    let hi: number;
    if (e.kind === "call_entry") {
      [at, lo, hi] = [calls++, a.calls, b.calls];
    } else if (e.kind === "call_exit") {
      [at, lo, hi] = [returns++, a.returns, b.returns];
    } else if (e.kind === "io") {
      [at, lo, hi] = [e.step_id, a.steps, b.steps];
    } else {
      [at, lo, hi] = [e.step_index, a.steps, b.steps];
    }
    if (at >= lo && at < hi) out.push(normalised(e));
  }
  return out;
}

/**
 * Check the range trace at `out`, bounded at checkpoints `from` and `to`
 * (`null`: the session's start, `End`), against the full trace's events
 * between positions `a` and `b`: its provenance names those bounds, it holds
 * at least one step (the vacuity guard, asserted before comparing), and its
 * events are exactly that slice's.
 */
function expectSliceOfFull(
  name: string,
  out: string,
  full: CtFullEvent[],
  from: RecordOf<"Checkpoint"> | null,
  to: RecordOf<"Checkpoint"> | null,
  a: Position,
  b: Position,
): void {
  const trace = ctPrintFull(out);
  expect(trace.metadata.args, name).toContain(
    `seq-range=${from?.seq ?? "start"}..${to?.seq ?? "end"}`,
  );
  expect(
    trace.events.filter((e) => e.kind === "step").length,
    name,
  ).toBeGreaterThanOrEqual(1);
  expect(trace.events.map(normalised), name).toEqual(slice(full, a, b));
  expect(trace.counts.steps, name).toBe(b.steps - a.steps);
}

/**
 * The test-only shim build with no `offsetWidth` seam (see the header): the
 * loop that patches the layout getters skips that one, in the record mode
 * (`seams-dom.js`, which logs the getters) and in the replay mode
 * (`replay/dom.js`, which answers them from the log), so the read reaches
 * the platform on both sides, as a read the recorder missed does.
 */
async function shimWithoutOffsetWidth(): Promise<{
  record: string;
  replay: string;
}> {
  const loop = "for (const [name, g] of orig.layoutGetters) {";
  const rewritten = new Set<string>();
  const plugin: esbuild.Plugin = {
    name: "no-offset-width",
    setup(build) {
      build.onLoad(
        {
          filter:
            /boundary-shim[\\/]dist[\\/]browser[\\/](seams-dom|replay[\\/]dom)\.js$/,
        },
        (args) => {
          const text = fs.readFileSync(args.path, "utf-8");
          // The loop must be found exactly once, or this build is not the
          // build it claims to be.
          if (text.split(loop).length !== 2) {
            throw new Error(
              `${args.path}: the layout getter loop is not found once`,
            );
          }
          rewritten.add(
            path.basename(path.dirname(args.path)) +
              "/" +
              path.basename(args.path),
          );
          return {
            contents: text.replace(
              loop,
              `${loop} if (name === "offsetWidth") continue;`,
            ),
            loader: "js",
          };
        },
      );
    },
  };
  const bundle = async (entry: string): Promise<string> => {
    const r = await esbuild.build({
      entryPoints: [
        path.join(REPO_ROOT, "packages/boundary-shim/dist/browser", entry),
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
      plugins: [plugin],
    });
    return r.outputFiles[0].text;
  };
  const out = {
    record: await bundle("entry.js"),
    replay: await bundle("replay-entry.js"),
  };
  expect([...rewritten].sort()).toEqual([
    "browser/seams-dom.js",
    "replay/dom.js",
  ]);
  return out;
}

beforeAll(async () => {
  SESSION_MANAGER = sessionManagerPath();
  CT_JSBOUND = ctJsboundPath();
  requireCtPrint();
  shipped = await startRecordReplay();
  records = await shipped.record("seeking.html", clickThrough);
  ct = assemble(shipped, records);
}, TIMEOUT);

afterAll(async () => {
  await shipped?.close();
});

describe("range materialisation", () => {
  it(
    "range_materialisation_equals_slice_of_full",
    async () => {
      const cks = checkpointsOf(records);
      // Vacuity guard: checkpoints spread over the session, one per click.
      expect(cks.length).toBeGreaterThanOrEqual(CLICKS);
      const end = records[records.length - 1] as RecordOf<"End">;
      expect(end.record).toBe("End");
      const lastSeq = end.last_seq;

      const full = await materialise(ct);
      expect(full.report.error).toBeUndefined();
      expect(full.report.status).toBe("replayed");
      const fullTrace = ctPrintFull(full.out);
      const total = full.report.trace!;
      const at = full.report.checkpointTrace!;
      // The positions the runner reports are the trace's: its counts are
      // record-web's, and one is reported per checkpoint of the log.
      expect(fullTrace.counts.steps).toBe(total.steps);
      expect(
        fullTrace.events.filter((e) => e.kind === "call_entry").length,
      ).toBe(total.calls);
      expect(
        fullTrace.events.filter((e) => e.kind === "call_exit").length,
      ).toBe(total.returns);
      expect(at.map((p) => p.seq)).toEqual(cks.map((c) => c.seq.toString()));
      // This fixture suspends no frame across a checkpoint, so every range
      // is bounded at the checkpoints the index alone gives (the case of a
      // suspended frame is the next test's).
      expect(at.map((p) => p.open)).toEqual(cks.map(() => 0));

      const mid = (a: bigint, b: bigint) => (a + b) / 2n;
      const n = cks.length;
      // Five ranges over the session: from its start, past a checkpoint on
      // both bounds, exactly on two checkpoints, between checkpoints, and to
      // its end. Each with the checkpoints the specification bounds it at.
      const cases: {
        seqFrom: bigint;
        seqTo: bigint;
        from: RecordOf<"Checkpoint"> | null;
        to: RecordOf<"Checkpoint"> | null;
      }[] = [
        { seqFrom: 1n, seqTo: cks[1].seq, from: null, to: cks[1] },
        {
          seqFrom: cks[1].seq + 3n,
          seqTo: cks[2].seq + 3n,
          from: cks[1],
          to: cks[3],
        },
        { seqFrom: cks[2].seq, seqTo: cks[3].seq, from: cks[2], to: cks[3] },
        {
          seqFrom: mid(cks[3].seq, cks[4].seq),
          seqTo: mid(cks[4].seq, cks[5].seq),
          from: cks[3],
          to: cks[5],
        },
        {
          seqFrom: cks[n - 2].seq + 1n,
          seqTo: lastSeq,
          from: cks[n - 2],
          to: cks[n - 1].seq >= lastSeq ? cks[n - 1] : null,
        },
      ];
      const position = (c: RecordOf<"Checkpoint"> | null, start: boolean) => {
        if (c === null)
          return start ? { steps: 0, calls: 0, returns: 0 } : total;
        const p = at.find((x) => x.seq === c.seq.toString());
        if (p === undefined)
          throw new Error(`no position for checkpoint ${c.seq}`);
        return p;
      };
      for (const c of cases) {
        const name = `range ${c.seqFrom}..${c.seqTo}`;
        const r = await materialise(ct, { seqFrom: c.seqFrom, seqTo: c.seqTo });
        expect(r.report.error, name).toBeUndefined();
        expect(r.report.status, name).toBe("replayed");
        expect(r.report.range, name).toEqual({
          seqFrom: c.seqFrom.toString(),
          seqTo: c.seqTo.toString(),
          from:
            c.from === null
              ? null
              : expect.objectContaining({
                  ordinal: c.from.ordinal,
                  seq: c.from.seq.toString(),
                }),
          to:
            c.to === null
              ? null
              : expect.objectContaining({
                  ordinal: c.to.ordinal,
                  seq: c.to.seq.toString(),
                }),
          widened: false,
        });
        expectSliceOfFull(
          name,
          r.out,
          fullTrace.events,
          c.from,
          c.to,
          position(c.from, true),
          position(c.to, false),
        );
        // The replay stopped at the range's end: it compared the checkpoints
        // up to that one and no further (all of them when it ran to End).
        expect(r.report.checkpoints, name).toBe(
          c.to === null ? n : cks.indexOf(c.to) + 1,
        );
      }
    },
    TIMEOUT,
  );

  it(
    "range_bounded_inside_a_suspended_async_frame_widens_to_checkpoints_with_no_frame_open",
    async () => {
      // A session whose clicks 1 and 4 are handled by an `async` function
      // that awaits the click's fetch: the checkpoint after each of those
      // clicks falls while the function is suspended (fixtures/
      // seeking-async.js).
      const asyncRecords = await shipped.record(
        "seeking-async.html",
        clickThrough,
      );
      const asyncCt = assemble(shipped, asyncRecords);
      const cks = checkpointsOf(asyncRecords);
      // One after each click (the i-th after click i+1), and any the session
      // ends with.
      expect(cks.length).toBeGreaterThanOrEqual(CLICKS);

      const full = await materialise(asyncCt);
      expect(full.report.error).toBeUndefined();
      expect(full.report.status).toBe("replayed");
      expect(full.report.range).toBeUndefined();
      const fullTrace = ctPrintFull(full.out);
      const total = full.report.trace!;
      const at = full.report.checkpointTrace!;
      expect(at.map((p) => p.seq)).toEqual(cks.map((c) => c.seq.toString()));
      // Vacuity guard: the checkpoint after each async click (1 and 4) has
      // the suspended function open, and no other has a frame open, so the
      // bounds below do fall inside a suspended frame.
      expect(at.map((p) => p.open > 0)).toEqual(
        cks.map((_, i) => i === 0 || i === 3),
      );
      const position = (c: RecordOf<"Checkpoint"> | null, start: boolean) =>
        c === null
          ? start
            ? { steps: 0, calls: 0, returns: 0 }
            : total
          : at.find((x) => x.seq === c.seq.toString())!;

      // Each asked-for range has a bound at a checkpoint with the async
      // frame open; the range is moved out to the nearest checkpoints with
      // none (or the session's start), and equals that slice of the full
      // trace: no call entered without its entry, none closed early.
      const cases: {
        seqFrom: bigint;
        seqTo: bigint;
        from: RecordOf<"Checkpoint"> | null;
        to: RecordOf<"Checkpoint"> | null;
      }[] = [
        // Both bounds moved: from inside the first async frame (to the
        // session's start), to inside the second (on to the next checkpoint).
        { seqFrom: cks[0].seq, seqTo: cks[3].seq, from: null, to: cks[4] },
        // Only the end moved: to inside the second async frame.
        {
          seqFrom: cks[1].seq + 1n,
          seqTo: cks[3].seq,
          from: cks[1],
          to: cks[4],
        },
        // Only the start moved, to an earlier checkpoint: from inside the
        // second async frame.
        {
          seqFrom: cks[3].seq,
          seqTo: cks[3].seq + 1n,
          from: cks[2],
          to: cks[4],
        },
      ];
      for (const c of cases) {
        const name = `range ${c.seqFrom}..${c.seqTo}`;
        const r = await materialise(asyncCt, {
          seqFrom: c.seqFrom,
          seqTo: c.seqTo,
        });
        expect(r.report.error, name).toBeUndefined();
        expect(r.report.status, name).toBe("replayed");
        expect(r.report.range, name).toEqual({
          seqFrom: c.seqFrom.toString(),
          seqTo: c.seqTo.toString(),
          from:
            c.from === null
              ? null
              : expect.objectContaining({ seq: c.from.seq.toString() }),
          to:
            c.to === null
              ? null
              : expect.objectContaining({ seq: c.to.seq.toString() }),
          widened: true,
        });
        expectSliceOfFull(
          name,
          r.out,
          fullTrace.events,
          c.from,
          c.to,
          position(c.from, true),
          position(c.to, false),
        );
      }
    },
    TIMEOUT,
  );

  it("range_bounds_are_found_in_the_checkpoint_index", () => {
    const rows: CheckpointRow[] = [10n, 20n, 30n].map((seq, i) => ({
      ordinal: i,
      seq,
      logOffset: 100 * (i + 1),
    }));
    const seqs = (b: ReturnType<typeof rangeBounds>) => [
      b.from?.seq,
      b.to?.seq,
    ];
    expect(seqs(rangeBounds(rows, 40n))).toEqual([undefined, undefined]);
    expect(seqs(rangeBounds(rows, 40n, 1n, 9n))).toEqual([undefined, 10n]);
    expect(seqs(rangeBounds(rows, 40n, 10n, 10n))).toEqual([10n, 20n]);
    expect(seqs(rangeBounds(rows, 40n, 11n, 20n))).toEqual([10n, 20n]);
    expect(seqs(rangeBounds(rows, 40n, 19n, 21n))).toEqual([10n, 30n]);
    expect(seqs(rangeBounds(rows, 40n, 30n, 40n))).toEqual([30n, undefined]);
    expect(seqs(rangeBounds(rows, 40n, 31n))).toEqual([30n, undefined]);
    expect(seqs(rangeBounds([], 40n, 5n, 6n))).toEqual([undefined, undefined]);
    // Outside the log, or reversed: refused, never clamped.
    expect(() => rangeBounds(rows, 40n, 0n, 5n)).toThrow(/first seq/);
    expect(() => rangeBounds(rows, 40n, 5n, 41n)).toThrow(/last seq, 40/);
    expect(() => rangeBounds(rows, 40n, 6n, 5n)).toThrow(/before --seq-from/);
  });

  it("range_bounds_move_out_to_checkpoints_with_no_frame_open", () => {
    const rows: CheckpointRow[] = [10n, 20n, 30n, 40n].map((seq, i) => ({
      ordinal: i,
      seq,
      logOffset: 100 * (i + 1),
    }));
    const seqs = (b: ReturnType<typeof quiescentBounds>) => [
      b.from?.seq,
      b.to?.seq,
    ];
    const trace = (open: number[]) =>
      open.map((o, i) => ({ seq: rows[i].seq.toString(), open: o }));
    const planned = { from: rows[2], to: rows[3] };
    // Planned bounds with no frame open are kept.
    expect(
      seqs(
        quiescentBounds(
          planned,
          { checkpointTrace: trace([0, 0, 0, 0]), stoppedAt: "40" },
          rows,
        ),
      ),
    ).toEqual([30n, 40n]);
    // A `from` with frames open moves to the last earlier checkpoint with
    // none, or the session's start; the end is where the replay stopped
    // (`End` when it did not stop at a checkpoint).
    expect(
      seqs(
        quiescentBounds(
          planned,
          {
            checkpointTrace: trace([0, 1, 2, 1]),
            fromNotQuiescent: true,
          },
          rows,
        ),
      ),
    ).toEqual([10n, undefined]);
    expect(
      seqs(
        quiescentBounds(
          planned,
          {
            checkpointTrace: trace([1, 0, 1, 0]),
            fromNotQuiescent: true,
            stoppedAt: "40",
          },
          rows,
        ),
      ),
    ).toEqual([20n, 40n]);
    expect(
      seqs(
        quiescentBounds(
          planned,
          {
            checkpointTrace: trace([1, 1, 1, 0]),
            fromNotQuiescent: true,
            stoppedAt: "40",
          },
          rows,
        ),
      ),
    ).toEqual([undefined, 40n]);
    // A checkpoint the index does not have is an error, never a guess.
    expect(() =>
      quiescentBounds(
        planned,
        { checkpointTrace: trace([0, 0, 0, 0]), stoppedAt: "41" },
        rows,
      ),
    ).toThrow(/seq 41/);
  });

  it(
    "replay_refuses_a_recording_whose_checkpoint_index_disagrees",
    async () => {
      const chk = readCtfsMember(ct, "jsbound.chk");
      // Vacuity guard: the index has rows to edit.
      expect(chk.length).toBeGreaterThanOrEqual(20 * CLICKS);
      const bytes = fs.readFileSync(ct);
      const at = bytes.indexOf(Buffer.from(chk));
      expect(at).toBeGreaterThan(0);
      expect(bytes.indexOf(Buffer.from(chk), at + 1)).toBe(-1);
      const edited = Buffer.from(bytes);
      edited[at + 20 + 4] ^= 1; // the second row's seq
      const file = path.join(shipped.tmp("ct-seek-edited-"), "edited.ct");
      fs.writeFileSync(file, edited);
      // The edit reached the member the reader sees.
      expect(Buffer.from(readCtfsMember(file, "jsbound.chk"))).not.toEqual(
        Buffer.from(chk),
      );
      await expect(
        replaySession({
          log: file,
          build: shipped.build,
          browser: shipped.browser,
        }),
      ).rejects.toThrow(/jsbound\.chk: row 1 /);
      // Negative control: the unedited recording replays.
      const clean = await replaySession({
        log: ct,
        build: shipped.build,
        browser: shipped.browser,
        timeoutMs: 120_000,
      });
      expectReplayed(clean, records);
    },
    TIMEOUT,
  );
});

describe("divergence localisation", () => {
  it(
    "missed_layout_read_is_reported_at_first_divergent_checkpoint",
    async () => {
      const blindShim = await shimWithoutOffsetWidth();
      const blind = await startRecordReplay(undefined, {
        bundleSource: blindShim.record,
      });
      try {
        const missed = await blind.record("seeking.html", clickThrough);
        // The shipped shim logs the read right after its anchor; the test
        // build has no record of it at all.
        const anchor = (rs: BoundaryRecord[]) =>
          indexWhere(rs, "StorageRead", (r) => r.key === WIDTH_ANCHOR);
        const read = records[anchor(records) + 1];
        expect(read.record === "LayoutRead" && read.prop).toBe("offsetWidth");
        const isWidth = (r: BoundaryRecord) =>
          r.record === "LayoutRead" && r.prop === "offsetWidth";
        expect(records.filter(isWidth).length).toBe(1);
        expect(missed.filter(isWidth).length).toBe(0);

        // Where the replay must stop: the first checkpoint after the read.
        const readAt = anchor(missed);
        const after = missed.findIndex(
          (r, i) => i > readAt && r.record === "Checkpoint",
        );
        const before = missed
          .map((r, i) => (i < readAt && r.record === "Checkpoint" ? i : -1))
          .filter((i) => i >= 0)
          .pop();
        // Vacuity guard: checkpoints match before the read, so the report
        // localises it between two of them.
        expect(after).toBeGreaterThan(readAt);
        expect(before).toBeDefined();
        const first = missed[after] as RecordOf<"Checkpoint">;
        const last = missed[before!] as RecordOf<"Checkpoint">;
        expect(last.ordinal).toBe(first.ordinal - 1);

        // A replay viewport other than the recorded one.
        const env = missed[1] as RecordOf<"Env">;
        expect(env.record).toBe("Env");
        const otherViewport = (rs: BoundaryRecord[]) =>
          replaced<"Env">(rs, 1, { viewport_w: env.viewport_w - 300 });

        const blindCt = assemble(blind, otherViewport(missed));
        const report = await replaySession({
          log: blindCt,
          build: blind.build,
          browser: blind.browser,
          shimReplayBundle: blindShim.replay,
          timeoutMs: 120_000,
        });
        expect(report.status, report.error).toBe("diverged");
        const d = report.divergence!;
        expect(`${d.kind} at ${d.seq}`, d.detail).toBe(
          `CheckpointMismatch at ${first.seq}`,
        );
        expect(d.lastCheckpoint).toEqual({
          ordinal: last.ordinal,
          seq: last.seq.toString(),
          scheme: last.scheme,
          stateHash: last.state_hash,
          logOffset: expect.any(Number),
        });
        // The offset is the checkpoint's frame in the recording's log, from
        // its jsbound.chk: a Checkpoint frame (tag 0x4d) carrying that seq.
        const log = readCtfsMember(blindCt, "jsbound.log");
        const off = d.lastCheckpoint!.logOffset!;
        expect(log[off + 4]).toBe(0x4d);
        expect(
          new DataView(log.buffer, log.byteOffset + off + 5, 8).getBigUint64(
            0,
            true,
          ),
        ).toBe(last.seq);
        expect(decodeLog(log).offsets).toContain(off);

        // Negative control: the shipped shim on the same fixture and the same
        // two viewports replays clean, so the checkpoint is what caught the
        // miss.
        const control = await replaySession({
          log: assemble(shipped, otherViewport(records)),
          build: shipped.build,
          browser: shipped.browser,
          timeoutMs: 120_000,
        });
        expectReplayed(control, records);
        // And the test build at the recorded viewport replays clean: the
        // miss shows only where the layout differs.
        const sameViewport = await replaySession({
          log: assemble(blind, missed),
          build: blind.build,
          browser: blind.browser,
          shimReplayBundle: blindShim.replay,
          timeoutMs: 120_000,
        });
        expectReplayed(sameViewport, missed);
      } finally {
        await blind.close();
      }
    },
    TIMEOUT,
  );
});

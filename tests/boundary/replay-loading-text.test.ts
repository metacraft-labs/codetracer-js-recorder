/**
 * A task that ran while the document was parsed is replayed where the parser
 * was on record, to the character (CodeTracer's JS-Boundary-Recording
 * specification §6, "The document's own tasks": `Loading.text`, and the
 * runner's parser gates at every token boundary): a node the task inserts
 * lands on the same side of the text and comments the parser inserts around
 * it as it did on record, and a position replay cannot stop the parser at
 * (inside a run of text the network cut in two) is a typed divergence, never
 * a document with other text.
 *
 * Each case records a fixture page for real, in headless Chromium, against
 * the real fixture server, with the generic shim installed by the shipped
 * deploy route (`record-replay.ts`), and replays the log with the real
 * runner:
 *
 * - `trailing-text.html?chunks=…`: the server sends the page in two pieces,
 *   cut after the comment that follows the page's script, so the script's
 *   timer always runs while the parser waits for the text after it: the
 *   element the timer appends goes before that text on record. The replay
 *   serves the page whole, so only a gate at the boundary after the comment,
 *   taken at the logged `Loading`, holds the parser there.
 * - `trailing-text.html` served whole: whether the timer runs before the
 *   parser reached the comment and text after the script depends on the
 *   machine (under load Chromium's parser yields there); whichever the
 *   recording has, the replay must reproduce. Run it under `stress-ng` to
 *   make both happen.
 * - `gates-unseen.html`: the page counts the replay's gates it can see
 *   wherever its code runs (while the parser runs its scripts, in a timer,
 *   at `DOMContentLoaded`, at `load` and after it) and writes the counts
 *   into the document: a gate left in it diverges at a checkpoint.
 * - `trailing-rcdata.html?chunks=…`: the cut is inside a `<textarea>`'s
 *   text, which the parser inserts as far as the network delivered it; no
 *   gate can stop the parser inside raw text, so the replay diverges with
 *   `TaskOrderMismatch` at the timer's `Loading`.
 *
 * Negative controls: the logged `text` changed by one (a position inside
 * the run no gate reaches) diverges at that `Loading`, and changed to the
 * position after the trailing text releases the timer after it, which the
 * final checkpoint catches.
 *
 * No mocks: the browser, the server and the runner are real.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type BoundaryRecord,
  type RecordOf,
} from "../../packages/boundary-format/src/index.js";
import { seqAt } from "../../packages/boundary-replay/src/index.js";
import {
  type RecordReplay,
  expectDiverged,
  expectReplayed,
  lastCheckpoint,
  replaced,
  startRecordReplay,
} from "./record-replay.js";

const TIMEOUT = 120_000;

/** The gap between the pieces of a chunked page, in milliseconds. */
const CHUNK_GAP_MS = 800;

let rr: RecordReplay;

beforeAll(async () => {
  rr = await startRecordReplay();
}, TIMEOUT);

afterAll(async () => {
  await rr?.close();
});

/** How long the rcdata page's timer waits (`?timer=`), in milliseconds. */
const RCDATA_TIMER_MS = 100;

/**
 * Record `pagePath` until the recording is of the case under test, at most
 * three times: its log has the page's timer run while the document was
 * parsed (a `Loading` of phase 1 right before the timer's `Task`), and
 * `wanted` accepts what the page wrote. A recording is of whatever the
 * machine did: under load a timer can run later than the gap between a
 * page's pieces, which records another case than the one under test, not a
 * defect of the replay. Only the recording is retried, never a replay: each
 * test replays the recording this accepts, once, and asserts on that, and
 * asserts the case again (a recording of another case after three tries
 * fails the test).
 */
async function recordUntil(
  pagePath: string,
  wanted: (slots: string[]) => boolean,
): Promise<{ records: BoundaryRecord[]; slots: string[] }> {
  const ofTheCase = (r: { records: BoundaryRecord[]; slots: string[] }) =>
    timerRanWhileParsing(r.records) && wanted(r.slots);
  let recorded = await rr.recordPage(pagePath);
  for (let i = 1; i < 3 && !ofTheCase(recorded); i++) {
    recorded = await rr.recordPage(pagePath);
  }
  return recorded;
}

/** Record `trailing-rcdata.html`, sent in two pieces, cut inside its text. */
function recordRcdata() {
  return recordUntil(
    `trailing-rcdata.html?chunks=${CHUNK_GAP_MS}&timer=${RCDATA_TIMER_MS}`,
    (got) => got.length === 2 && got[0] === "followed by text",
  );
}

/**
 * Whether the log has the first timer (the one the page's script sets) run
 * while the document was parsed: a `Loading` of phase 1 right before its
 * `Task`.
 */
function timerRanWhileParsing(rs: BoundaryRecord[]): boolean {
  const task = rs.findIndex((r) => r.record === "Task" && r.kind === 1);
  const loading = task > 0 ? rs[task - 1] : undefined;
  return loading?.record === "Loading" && loading.phase === 1;
}

/**
 * The index of the `Task` of the first timer (the one the page's script
 * sets), and of the `Loading` right before it.
 */
function timerTask(rs: BoundaryRecord[]): { task: number; loading: number } {
  expect(
    timerRanWhileParsing(rs),
    "the log has the timer run while the document was parsed",
  ).toBe(true);
  const task = rs.findIndex((r) => r.record === "Task" && r.kind === 1);
  expect(task, "the log has the timer's Task").toBeGreaterThan(0);
  const loading = task - 1;
  expect(rs[loading].record, "a Loading precedes the timer's Task").toBe(
    "Loading",
  );
  return { task, loading };
}

describe("a task released while the document is parsed", () => {
  it(
    "replay_releases_a_task_before_the_text_the_parser_had_not_reached_on_record",
    async () => {
      const { records: rs, slots } = await recordUntil(
        `trailing-text.html?chunks=${CHUNK_GAP_MS}`,
        (got) => got[0] !== "followed by nothing",
      );
      // Vacuity guard: on record the timer ran before the parser inserted
      // the text after the script, so the element went before that text:
      // while the parser waited for the second piece (after the comment),
      // or, under load, when it yielded right after the script (before the
      // comment).
      expect(["followed by text", "followed by #comment"]).toContain(slots[0]);
      expect(slots).toHaveLength(1);
      const { loading } = timerTask(rs);
      const at = rs[loading] as RecordOf<"Loading">;
      expect(at.phase).toBe(1);
      expectReplayed(await rr.replay(rs), rs);

      // Negative control: a position inside the run of text after the
      // comment, which no gate can stop the parser at, is a typed
      // divergence at that `Loading`.
      expectDiverged(
        await rr.replay(
          replaced<"Loading">(rs, loading, { text: at.text + 1 }),
        ),
        "TaskOrderMismatch",
        seqAt(rs, loading),
      );
      // Negative control: the position after the trailing text (the comment,
      // when the timer ran before it, and the whitespace and text after it,
      // up to `</body>`) releases the timer after it, and the element lands
      // after the text: the final checkpoint differs. Every `Loading` from
      // the timer's on that the parser had not yet brought past that text
      // (input the browser dispatched while the parser waited, a hover, is
      // logged there too, before or after the timer) is moved past it: to the
      // text of the whole body, plus the element's own text ("late") when
      // the element is in the document.
      // A comment counts its data (`ct:chunk`) and one.
      const comment = "ct:chunk".length + 1;
      const trailing = "\n    text the parser inserts after the script\n  ";
      const beforeComment =
        slots[0] === "followed by #comment" ? at.text : at.text - comment;
      const whole = beforeComment + comment + trailing.length;
      let moved = rs;
      for (let i = loading; i < rs.length; i++) {
        const r = rs[i];
        if (r.record !== "Loading" || r.phase !== 1) continue;
        const late = r.elements > at.elements ? "late".length : 0;
        if (r.text - late < whole) {
          moved = replaced<"Loading">(moved, i, { text: whole + late });
        }
      }
      expectDiverged(
        await rr.replay(moved),
        "CheckpointMismatch",
        lastCheckpoint(rs),
      );
    },
    TIMEOUT,
  );

  it(
    "replay_releases_a_task_on_the_same_side_of_trailing_text_as_on_record",
    async () => {
      // The page served whole: where the parser was when the timer ran is
      // up to the machine. Either recording replays to `End`.
      const { records: rs, slots } = await rr.recordPage("trailing-text.html");
      expect([
        "followed by text",
        "followed by #comment",
        "followed by nothing",
      ]).toContain(slots[0]);
      expect(slots).toHaveLength(1);
      // Vacuity guard: the page's timer is in the log (with a `Loading`
      // before it when it ran before `load`, which is the case that needs
      // the parser held: under load, before the comment and the text).
      expect(rs.some((r) => r.record === "Task" && r.kind === 1)).toBe(true);
      expectReplayed(await rr.replay(rs), rs);
    },
    TIMEOUT,
  );

  it(
    "replay_reports_a_task_recorded_inside_a_run_of_text_as_a_typed_divergence",
    async () => {
      // The timer waits RCDATA_TIMER_MS, within the gap between the
      // pieces, so the parser is inside the textarea when it runs; under
      // load the parser may not have got there yet (the timer then runs
      // before the textarea is in the document, a recording of another
      // case), so the page is recorded again, at most three times.
      const { records: rs, slots } = await recordRcdata();
      // Vacuity guard: on record the timer ran with only the textarea's
      // first piece of text in the document.
      const full = "before the cut <!--ct:chunk--> after the cut".length;
      const piece = "before the cut <!--ct:chunk-->".length;
      expect(slots).toEqual(["followed by text", `area ${piece} of ${full}`]);
      const { loading } = timerTask(rs);
      const inside = rs[loading] as RecordOf<"Loading">;
      expect(inside.phase).toBe(1);
      // The browser may have dispatched input (a hover) at the same position
      // before the timer ran: the replay diverges at the first `Loading` of
      // that position.
      const first = rs.findIndex(
        (r) =>
          r.record === "Loading" &&
          r.phase === 1 &&
          r.elements === inside.elements &&
          r.scripts === inside.scripts &&
          r.text === inside.text,
      );
      expectDiverged(
        await rr.replay(rs),
        "TaskOrderMismatch",
        seqAt(rs, first),
      );
    },
    TIMEOUT,
  );

  it(
    "replay_leaves_no_gate_for_the_page_to_meet",
    async () => {
      // A gate takes itself out, with the gates right before it (the
      // DOMContentLoaded and load gates, before the last parser gate),
      // rather than searching the document for gates at each of them; the
      // page counts the gates it can see at every point it runs and writes
      // the counts into the document, which the checkpoints compare.
      const { records: rs, slots } = await rr.recordPage("gates-unseen.html");
      // Vacuity guard: every point ran, on record (the timer wherever the
      // machine ran it), and saw no gate.
      expect(slots).toHaveLength(6);
      for (const when of [
        "parsing",
        "timer",
        "a later script",
        "DOMContentLoaded",
        "load",
        "after load",
      ]) {
        expect(slots, when).toContain(`${when} 0`);
      }
      expectReplayed(await rr.replay(rs), rs);
    },
    TIMEOUT,
  );
});

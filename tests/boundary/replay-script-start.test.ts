/**
 * An external script that changes the document before its first boundary
 * record is replayed from where it ran (CodeTracer's JS-Boundary-Recording
 * specification §6, "The document's own tasks"): the recorder writes the
 * script's `DocTask` 1 before its first record, after the `Loading` of that
 * moment, so the position counts what the script inserted before it. The
 * replay holds the script until that `DocTask` comes due, so the replayed
 * document cannot reach that position with the script held: the scheduler
 * lets the script go where the parser waits for it and takes the `Loading`
 * and the `DocTask` at the script's first record, comparing the position
 * then, as the recorder measured it.
 *
 * Each case records a fixture page for real, in headless Chromium, against
 * the real fixture server, with the generic shim installed by the shipped
 * deploy route (`record-replay.ts`), and replays the log with the real
 * runner:
 *
 * - `script-start.html`: a parser-blocking script in the body, the parser
 *   held at it (phase 1);
 * - `script-start-defer.html`: the same script, `defer`, run once the
 *   document is parsed (phase 2);
 * - `script-start-async.html`: the same script, `async`, run while the
 *   parser waits for a slow parser-blocking script (phase 1);
 * - `script-start-async-late.html`: the same script, `async` and answered
 *   late, run after `DOMContentLoaded` (phase 3);
 * - `script-start-async-stream.html`, served in two pieces: the same script,
 *   `async`, run while the parser waits for the network. The replay is
 *   served the page whole, so the parser, which nothing holds, parses past
 *   the logged position: the specified outcome is a typed divergence at
 *   that `Loading`, never the script run elsewhere;
 * - `script-start-quiet.html`: the parser-blocking script, with its first
 *   record made conditional on a storage read before it. A log whose read
 *   is edited so that the replayed script writes no record must diverge
 *   when the script settles without it, at its `Loading`.
 *
 * The script inserts two elements and their text, then constructs a
 * `MutationObserver` (its first record, a `TaskReg`) and reads the clock.
 * Negative control: a logged position the script does not bring the
 * document to diverges at that `Loading`, never replays the script
 * elsewhere.
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
  indexWhere,
  replaced,
  startRecordReplay,
} from "./record-replay.js";

const TIMEOUT = 120_000;

let rr: RecordReplay;

beforeAll(async () => {
  rr = await startRecordReplay();
}, TIMEOUT);

afterAll(async () => {
  await rr?.close();
});

/** Whether `src` is the URL of `script-start.js` (any query). */
const isScriptStart = (src: string): boolean =>
  new URL(src).pathname === "/script-start.js";

/**
 * The index of the script's `DocTask` 1, after checking the shape the case
 * is about: the `Loading` right before it, in `phase`, and the script's
 * first record (its observer's `TaskReg{kind 10}`) right after it.
 */
function scriptStart(records: BoundaryRecord[], phase: number): number {
  const task = indexWhere(
    records,
    "DocTask",
    (d) => d.kind === 1 && isScriptStart(d.src),
  );
  const loading = records[task - 1] as RecordOf<"Loading">;
  expect(loading.record).toBe("Loading");
  expect(loading.phase).toBe(phase);
  const first = records[task + 1] as RecordOf<"TaskReg">;
  expect(first.record).toBe("TaskReg");
  expect(first.kind).toBe(10);
  return task;
}

describe("a script that changes the document before its first record", () => {
  // The page's own elements up to the moment the script starts, CodeTracer's
  // own excepted: `html`, `head`, `meta`, `title`, `body`, `ul`, `div` and
  // the script, and then
  // - with `defer`, the `p` the parser inserted before it ran;
  // - `async` and the parser waiting, the slow script it waits for;
  // - `async` after DOMContentLoaded, the `p`.
  for (const [page, phase, elements] of [
    ["script-start.html", 1, 8],
    ["script-start-defer.html", 2, 9],
    ["script-start-async.html", 1, 9],
    ["script-start-async-late.html", 3, 9],
  ] as const) {
    it(
      `replays_from_its_loading_position: ${page}`,
      async () => {
        const { records: rs, slots } = await rr.recordPage(page);
        // Vacuity guard: the page ran its script and its observer saw the
        // element inserted after the first read.
        expect(slots).toEqual(["observed 1", "clock true", "after true"]);
        const task = scriptStart(rs, phase);
        const loading = rs[task - 1] as RecordOf<"Loading">;
        // Vacuity guard: the position counts the two elements the script
        // inserted before its first record, which no parser position has.
        expect(loading.elements).toBe(elements + 2);
        if (page === "script-start-async.html") {
          // Vacuity guard: the async script ran while the parser waited
          // for the slow one, which ran after it.
          const hold = indexWhere(
            rs,
            "DocTask",
            (d) => new URL(d.src).pathname === "/script-start-hold.js",
          );
          expect(hold).toBeGreaterThan(task);
        }
        expectReplayed(await rr.replay(rs), rs);
        // A position the script does not bring the document to is refused
        // at its Loading, never replayed elsewhere.
        const off = replaced<"Loading">(rs, task - 1, {
          elements: loading.elements + 1,
        });
        expectDiverged(
          await rr.replay(off),
          "TaskOrderMismatch",
          seqAt(rs, task - 1),
        );
      },
      TIMEOUT,
    );
  }

  it(
    "an_async_script_run_while_the_parser_waited_for_the_network_diverges_at_its_loading",
    async () => {
      const { records: rs, slots } = await rr.recordPage(
        "script-start-async-stream.html?chunks=600",
      );
      expect(slots).toEqual(["observed 1", "clock true", "after true"]);
      const task = scriptStart(rs, 1);
      const loading = rs[task - 1] as RecordOf<"Loading">;
      // Vacuity guard: the script ran between the page's two pieces, the
      // `p` of the second not yet parsed: the page's eight elements up to
      // the script and the script's two.
      expect(loading.elements).toBe(10);
      const r = await rr.replay(rs);
      expectDiverged(r, "TaskOrderMismatch", seqAt(rs, task - 1));
      expect(r.divergence?.recorded).toBe(
        `phase 1, 10 elements, 0 scripts run, ${loading.text} of text`,
      );
      // The script did not run elsewhere: the replayed document has the
      // parser's elements (the `p` too) and none of the script's.
      expect(r.divergence?.actual).toMatch(/^phase 2, 9 elements, /);
    },
    TIMEOUT,
  );

  it(
    "a_script_that_settles_without_its_first_record_diverges",
    async () => {
      const { records: rs, slots } = await rr.recordPage(
        "script-start-quiet.html",
      );
      expect(slots).toEqual(["observed 1", "clock true", "after true"]);
      const task = scriptStart(rs, 1);
      // Positive control: the log as recorded replays.
      expectReplayed(await rr.replay(rs), rs);
      // The read the script's first record depends on, made before the
      // script by the page's inline script: answered "1", the replayed
      // script changes the document as recorded and writes no record.
      const read = indexWhere(
        rs,
        "StorageRead",
        (s) => s.key === "script-start-quiet",
      );
      expect(read).toBeLessThan(task);
      expect((rs[read] as RecordOf<"StorageRead">).present).toBe(0);
      const quiet = replaced<"StorageRead">(rs, read, {
        present: 1,
        value: "1",
      });
      const r = await rr.replay(quiet);
      expectDiverged(r, "TaskOrderMismatch", seqAt(rs, task - 1));
      expect(r.divergence?.detail).toContain(
        "ran without writing the record the log has it write first",
      );
    },
    TIMEOUT,
  );
});

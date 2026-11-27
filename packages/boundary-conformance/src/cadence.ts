/**
 * The checkpoint cadence of CodeTracer's JS-Boundary-Recording
 * specification §7.3, as an oracle over a decoded log. Written from the
 * specification's sentences, not from any recorder's code, and the one
 * implementation of the rule: the conformance suite's `checkpoints` check
 * and the generic shim's own tests both call it.
 *
 * §7.3: a checkpoint is taken at a quiescent point, which a recorder sees
 * as the start of the next macrotask (before its `Task`, or for an input
 * event before the `DomEffect`s and `Scrubbed` records its `Task` follows),
 * at most once there;
 * it is due when 256 seq-bearing records, or 2000 ms of recorded time, have
 * passed since the last one; and a final checkpoint precedes `End` when
 * anything was written since the last one. Recorded time comes from the
 * session's own `Clock` records: wall clock from `src` 1 and 3, monotonic
 * from `src` 2 and 4.
 *
 * No checkpoint is due, or may be taken, while the document parses (§7.3 as
 * amended for §6, "The document's own tasks"): its extent between two of
 * the parser's tokens is not in the log. A log that says the document
 * parsed (a `Loading` record with phase 1) is parsing from its start until
 * a `Loading` with a later phase, or the `DocTask` of `DOMContentLoaded` or
 * `load`; the `Loading` that starts a macrotask precedes its checkpoint.
 *
 * Which macrotask a due checkpoint lands before is decided by event
 * dispatch, not by the cadence: the recorder takes it at the first
 * macrotask start after the 256th record (or the 2000 ms mark). Measured
 * at codetracer-js-recorder `e1a67fe` (the generic shim, level 0, the
 * `sensitive-*` fixtures, 12 busy loops on the host, 2026-11-09): a typed
 * character is five macrotasks (keydown, keypress, beforeinput, input,
 * keyup), the checkpoint lands at seq 257 or 259, and which of the five
 * the 256th record falls before moves with the log's length so far, which
 * timing changes. Of 180 logs, 176 had the checkpoint before a keyup
 * `Task`, 2 before a keypress `Task`, and 2 before the `input` macrotask,
 * whose first record is a `Scrubbed` (the 256th record ended `beforeinput`).
 * The oracle accepts every such start.
 */

import type { BoundaryRecord } from "@codetracer/boundary-format";

/** §7.3's two triggers. */
export const CHECKPOINT_RECORDS = 256;
export const CHECKPOINT_RECORDED_MS = 2000;

export interface CadenceResult {
  /** Every departure from §7.3, with the `seq` it is at. */
  violations: string[];
  /** The `seq`s of the checkpoints written because 256 records had passed. */
  dueByCount: number[];
  /** The `seq`s of the checkpoints written because 2 s had passed. */
  dueByTime: number[];
  /** How many `Checkpoint` records the log holds. */
  checkpoints: number;
}

/** The IEEE-754 value of a `Clock.bits` field. */
export function clockValue(bits: bigint): number {
  const v = new DataView(new ArrayBuffer(8));
  v.setBigUint64(0, bits, true);
  return v.getFloat64(0, true);
}

/**
 * Whether `r` is a record an input event writes before its `Task`: a
 * `DomEffect` for a default action, or a `Scrubbed` in place of a value
 * `DomEffect` at a sensitive field (§9.5, §11.3.9: "a `Scrubbed` record
 * precedes an `Input` as a `DomEffect` does").
 */
function isPreTaskRecord(r: BoundaryRecord | undefined): boolean {
  return r?.record === "DomEffect" || r?.record === "Scrubbed";
}

/**
 * Whether the record at `i` starts a macrotask: a `Task` that no
 * pre-`Task` record precedes, or the first of a run of pre-`Task` records
 * (`DomEffect`s and `Scrubbed`s, which an input event's `Task` follows).
 */
function isTaskStart(records: readonly BoundaryRecord[], i: number): boolean {
  const r = records[i];
  if (r.record !== "Task" && !isPreTaskRecord(r)) return false;
  return !isPreTaskRecord(records[i - 1]);
}

/**
 * The `seq` a violation about the macrotask starting at `i` names: its
 * `Task`, the record a checkpoint taken at this boundary precedes, not the
 * `DomEffect` or `Scrubbed` before it. A checkpoint can sit between the two
 * (the recorder takes it at the start of the next macrotask, which for an
 * input event is before its pre-`Task` records, but a log whose checkpoint
 * is later still has the macrotask start at the first of them; a
 * `Checkpoint` there is skipped over to reach the `Task`), and naming
 * the first record would point at a place the checkpoint is not at. A run
 * of pre-`Task` records that no `Task` ends names its first record.
 */
function taskSeq(records: readonly BoundaryRecord[], i: number): number {
  let j = i;
  while (isPreTaskRecord(records[j]) || records[j]?.record === "Checkpoint") {
    j += 1;
  }
  const t = records[j]?.record === "Task" ? records[j] : records[i];
  return Number((t as { seq: number | bigint }).seq);
}

/** Check `records` (a decoded log, in order) against §7.3's cadence. */
export function checkpointCadence(
  records: readonly BoundaryRecord[],
): CadenceResult {
  let since = 0;
  let wallAt: number | undefined;
  let wallNow: number | undefined;
  let monoAt: number | undefined;
  let monoNow: number | undefined;
  let ordinal = 0;
  let checkpoints = 0;
  const dueByCount: number[] = [];
  const dueByTime: number[] = [];
  const violations: string[] = [];
  let parsing = records.some((r) => r.record === "Loading" && r.phase === 1);
  const due = (): boolean =>
    !parsing &&
    (since >= CHECKPOINT_RECORDS ||
      (wallAt !== undefined &&
        wallNow !== undefined &&
        wallNow - wallAt >= CHECKPOINT_RECORDED_MS) ||
      (monoAt !== undefined &&
        monoNow !== undefined &&
        monoNow - monoAt >= CHECKPOINT_RECORDED_MS));

  records.forEach((r, i) => {
    if (r.record === "End") {
      if (since > 0 && !parsing) {
        violations.push(
          `no final checkpoint before End: ${since} record(s) were written since the last one`,
        );
      }
      return;
    }
    if (!("seq" in r)) return;
    if (r.record === "Loading") parsing = r.phase === 1;
    // DOMContentLoaded and load end the parsing; every other document task
    // (a script's execution, a resource element's event) follows the
    // `Loading` that says where the document was.
    if (r.record === "DocTask" && (r.kind === 2 || r.kind === 3)) {
      parsing = false;
    }
    if (r.record === "Checkpoint") {
      checkpoints += 1;
      if (r.ordinal !== ordinal) {
        violations.push(
          `checkpoint at seq ${r.seq} has ordinal ${r.ordinal}, expected ${ordinal}`,
        );
      }
      ordinal = r.ordinal + 1;
      const atStart = i + 1 < records.length && isTaskStart(records, i + 1);
      const atEnd = records[i + 1]?.record === "End";
      const wasDue = due();
      if (!atStart && !atEnd) {
        violations.push(`checkpoint at seq ${r.seq} is not at a task boundary`);
      }
      if (parsing) {
        violations.push(
          `checkpoint at seq ${r.seq} was taken while the document parsed`,
        );
      } else if (since === 0) {
        violations.push(
          `checkpoint at seq ${r.seq} follows another with nothing between`,
        );
      } else if (!wasDue && !atEnd) {
        violations.push(`checkpoint at seq ${r.seq} was not due`);
      }
      if (since >= CHECKPOINT_RECORDS) dueByCount.push(Number(r.seq));
      else if (wasDue) dueByTime.push(Number(r.seq));
      since = 0;
      wallAt = wallNow;
      monoAt = monoNow;
      return;
    }
    if (isTaskStart(records, i) && due()) {
      violations.push(
        `no checkpoint before the task at seq ${taskSeq(records, i)}`,
      );
    }
    since += 1;
    if (r.record === "Clock") {
      const value = clockValue(r.bits);
      if (r.src === 1 || r.src === 3) {
        wallNow = value;
        wallAt ??= value;
      } else if (r.src === 2 || r.src === 4) {
        monoNow = value;
        monoAt ??= value;
      }
    }
  });
  return { violations, dueByCount, dueByTime, checkpoints };
}

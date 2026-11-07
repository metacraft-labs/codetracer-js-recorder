/**
 * Seeded edits of a recorded boundary log, for proving that a replay
 * diverges where and how it must (CodeTracer's JS-Boundary-Recording
 * specification §7.2): the conformance suite's replay leg and the runner's
 * own tests make the same edits through these functions.
 *
 * Every edit returns records that still decode strictly (§5.3): `seq`s are
 * renumbered from 1 after a record is removed or inserted, a `Gap` keeps
 * its length, and `End.last_seq` follows.
 */

import {
  type BoundaryRecord,
  encodeLog,
  seqOf,
} from "@codetracer/boundary-format";

/** `records` with every `seq` renumbered from 1 (see the module comment). */
export function renumber(records: readonly BoundaryRecord[]): BoundaryRecord[] {
  let next = 1n;
  return records.map((r) => {
    if (r.record === "Gap") {
      const len = r.last_seq - r.first_seq;
      const g = { ...r, first_seq: next, last_seq: next + len };
      next += len + 1n;
      return g;
    }
    if (r.record === "End") return { ...r, last_seq: next - 1n };
    if (seqOf(r) === undefined) return r;
    const s = { ...r, seq: next } as BoundaryRecord;
    next += 1n;
    return s;
  });
}

/** Remove the record at `index` and renumber. */
export function withoutRecord(
  records: readonly BoundaryRecord[],
  index: number,
): BoundaryRecord[] {
  return renumber(records.filter((_, i) => i !== index));
}

/**
 * Insert `record` (any `seq`, it is renumbered) before the record at
 * `index`, and renumber.
 */
export function withRecordBefore(
  records: readonly BoundaryRecord[],
  index: number,
  record: BoundaryRecord,
): BoundaryRecord[] {
  return renumber([
    ...records.slice(0, index),
    record,
    ...records.slice(index),
  ]);
}

/** Replace the record at `index` (no renumbering: same `seq`s). */
export function withRecordReplaced(
  records: readonly BoundaryRecord[],
  index: number,
  record: BoundaryRecord,
): BoundaryRecord[] {
  return records.map((r, i) => (i === index ? record : r));
}

/** Swap the records at `a` and `b`, keeping each position's `seq`. */
export function withRecordsSwapped(
  records: readonly BoundaryRecord[],
  a: number,
  b: number,
): BoundaryRecord[] {
  const out = records.slice();
  out[a] = records[b];
  out[b] = records[a];
  return renumber(out);
}

/** The `seq` of the record at `index` (decimal). */
export function seqAt(
  records: readonly BoundaryRecord[],
  index: number,
): string {
  const r = records[index];
  if (r?.record === "Gap") return r.first_seq.toString();
  const s = r === undefined ? undefined : seqOf(r);
  if (s === undefined) throw new Error(`record ${index} has no seq`);
  return s.toString();
}

/** `records` as a bare `jsbound.log` stream, bodies inline (§5.2). */
export function logBytes(records: readonly BoundaryRecord[]): Uint8Array {
  return encodeLog(records);
}

/**
 * Whether `r` is a boundary read the page makes itself, in its own code
 * (§5.2, "Replay": returned or checked), rather than a record the
 * scheduler releases: a clock, a random source, a request, a storage or
 * layout read, a declassifier's call, or a `pushState`/`replaceState`.
 */
export function isPageRead(r: BoundaryRecord): boolean {
  switch (r.record) {
    case "Clock":
    case "Random":
    case "NetRequest":
    case "StorageRead":
    case "LayoutRead":
    // A declassifier's call is a read the page makes in its own code
    // (§11.3.2): replay returns its logged output.
    case "Declassify":
      return true;
    case "Navigation":
      return r.kind === 1 || r.kind === 2;
    default:
      return false;
  }
}

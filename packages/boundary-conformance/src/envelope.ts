/**
 * The `envelope` check of the record leg (CodeTracer's JS-Boundary-Recording
 * specification §9.8, §9.9): the batches a framework uploaded, in the order
 * they arrived, against the batch envelope of the Boundary-Ingest
 * specification §4 and the assembler's envelope rules (§5.6).
 *
 * - every body parses: magic `"CTJB"` version 1, an envelope of at most
 *   4 KiB with exactly the envelope's fields, each frame whole and strictly
 *   decoded (`parseBatch`);
 * - `batch_seq` starts at 0 and each batch's is the previous one's plus one
 *   (the harness's server loses nothing); a batch repeated with the same
 *   bytes is the ingest's idempotent retry and is skipped, while the same
 *   `batch_seq` with other bytes, or one that goes backwards, fails;
 * - every envelope names the session and build of the first, and the first
 *   batch begins with `Header` and `Env`, which name them too;
 * - a batch's `first_seq` and `last_seq` are its first and last
 *   seq-bearing records' (a batch with none is not checked, as the
 *   assembler does not); its `first_seq` follows the previous batch's
 *   `last_seq`, unless the batch's `dropped` ranges cover exactly the seqs
 *   between; a `dropped` range that covers anything else fails;
 * - no batch carries a `Gap` (only the assembler writes them);
 * - exactly one batch is `final`, the last.
 *
 * It also returns the session's log as the assembler would join it (stream
 * prefix, every batch's frames in order, a `Gap{reason: 1}` for each dropped
 * range), for the `decode` check.
 */

import {
  type ParsedBatch,
  BatchFormatError,
  encodeFrame,
  parseBatch,
  seqOf,
  streamPrefix,
} from "@codetracer/boundary-format";

export interface EnvelopeResult {
  /** Every departure from the rules above; empty when the batches conform. */
  problems: string[];
  /** The batches accepted, in order (retries skipped). */
  batches: ParsedBatch[];
  /** The joined log, when the batches could be joined. */
  log?: Uint8Array;
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** Merge sorted, overlapping or adjacent ranges. */
function merge(ranges: [number, number][]): [number, number][] {
  const sorted = [...ranges].sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** Check `bodies`, the batch bodies of one session in arrival order. */
export function checkBatches(bodies: readonly Uint8Array[]): EnvelopeResult {
  const problems: string[] = [];
  const batches: ParsedBatch[] = [];
  const seen = new Map<number, Uint8Array>();
  /** The greatest batch_seq accepted so far (-1 before any). */
  let prevSeq = -1;
  if (bodies.length === 0) {
    return { problems: ["no batch was uploaded"], batches };
  }
  for (const [i, body] of bodies.entries()) {
    let b: ParsedBatch;
    try {
      b = parseBatch(body);
    } catch (e) {
      const why = e instanceof BatchFormatError ? e.message : String(e);
      problems.push(`batch #${i} (in arrival order) is refused: ${why}`);
      continue;
    }
    const n = b.envelope.batch_seq;
    const earlier = seen.get(n);
    if (earlier !== undefined) {
      if (!sameBytes(earlier, body)) {
        problems.push(
          `batch_seq ${n} arrived twice with different bytes (arrival #${i})`,
        );
      }
      continue;
    }
    if (n <= prevSeq) {
      problems.push(
        `batch_seq goes backwards: arrival #${i} carries batch_seq ${n} after ${prevSeq}`,
      );
    } else if (n !== prevSeq + 1) {
      problems.push(`batch_seq skips from ${prevSeq} to ${n} at arrival #${i}`);
    }
    prevSeq = Math.max(prevSeq, n);
    seen.set(n, body);
    batches.push(b);
  }
  if (batches.length === 0) return { problems, batches };

  const first = batches[0].envelope;
  const header = batches[0].records[0];
  if (header?.record !== "Header" || batches[0].records[1]?.record !== "Env") {
    problems.push(
      `the first batch begins with ${batches[0].records
        .slice(0, 2)
        .map((r) => r.record)
        .join(", ")} instead of Header, Env`,
    );
  } else if (
    header.session_id !== first.session_id ||
    header.build_hash !== first.build_hash
  ) {
    problems.push(
      `the Header names session ${header.session_id} build ${header.build_hash}, the envelope ${first.session_id} ${first.build_hash}`,
    );
  }

  const joined: Uint8Array[] = [streamPrefix()];
  let lastSeq = 0;
  for (const [i, b] of batches.entries()) {
    const e = b.envelope;
    const at = `batch_seq ${e.batch_seq}`;
    if (
      e.session_id !== first.session_id ||
      e.build_hash !== first.build_hash
    ) {
      problems.push(
        `${at} names session ${e.session_id} build ${e.build_hash}, the first batch ${first.session_id} ${first.build_hash}`,
      );
    }
    if (e.final !== (i === batches.length - 1)) {
      problems.push(
        e.final
          ? `${at} is final but ${batches.length - 1 - i} batch(es) follow it`
          : `the last batch, ${at}, is not final`,
      );
    }
    if (b.records.some((r) => r.record === "Gap")) {
      problems.push(
        `${at} carries a Gap record, which only the assembler writes`,
      );
    }
    if (
      i > 0 &&
      b.records.some((r) => r.record === "Header" || r.record === "Env")
    ) {
      problems.push(
        `${at} carries a Header or Env, which only the first batch may`,
      );
    }
    const seqs = b.records
      .map((r) => seqOf(r))
      .filter((s): s is bigint => s !== undefined)
      .map(Number);
    const end = b.records.find((r) => r.record === "End");
    // The first seq this batch says is not missing: its first record's, or
    // for a batch carrying only End the one after End.last_seq (§5.3).
    let upto: number | undefined;
    if (seqs.length > 0) {
      if (e.first_seq !== seqs[0] || e.last_seq !== seqs[seqs.length - 1]) {
        problems.push(
          `${at} declares seq ${e.first_seq}..${e.last_seq} but carries ${seqs[0]}..${seqs[seqs.length - 1]}`,
        );
      }
      upto = seqs[0];
    } else if (end !== undefined && end.record === "End") {
      upto = Number(end.last_seq) + 1;
    }
    const dropped = merge(e.dropped);
    if (upto !== undefined) {
      const hole: [number, number] | undefined =
        upto > lastSeq + 1 ? [lastSeq + 1, upto - 1] : undefined;
      if (hole === undefined && dropped.length > 0) {
        problems.push(
          `${at} declares dropped ${JSON.stringify(e.dropped)} but its first seq ${upto} follows the previous batch's last seq ${lastSeq}`,
        );
      } else if (
        hole !== undefined &&
        (dropped.length !== 1 ||
          dropped[0][0] !== hole[0] ||
          dropped[0][1] !== hole[1])
      ) {
        problems.push(
          dropped.length === 0
            ? `${at}'s first seq ${upto} does not follow the previous batch's last seq ${lastSeq}, and no dropped range covers ${hole[0]}..${hole[1]}`
            : `${at}'s dropped ${JSON.stringify(e.dropped)} does not cover exactly the missing seq ${hole[0]}..${hole[1]}`,
        );
      } else if (hole !== undefined) {
        joined.push(
          encodeFrame({
            record: "Gap",
            first_seq: BigInt(hole[0]),
            last_seq: BigInt(hole[1]),
            reason: 1,
          }),
        );
      }
      if (upto < lastSeq + 1) {
        problems.push(
          `${at}'s first seq ${upto} repeats seqs up to the previous batch's last seq ${lastSeq}`,
        );
      }
    } else if (dropped.length > 0) {
      problems.push(`${at} declares dropped ranges but carries no seq`);
    }
    if (seqs.length > 0) lastSeq = seqs[seqs.length - 1];
    else if (end !== undefined && end.record === "End")
      lastSeq = Number(end.last_seq);
    joined.push(b.frames);
  }
  let size = 0;
  for (const part of joined) size += part.length;
  const log = new Uint8Array(size);
  let at = 0;
  for (const part of joined) {
    log.set(part, at);
    at += part.length;
  }
  return { problems, batches, log };
}

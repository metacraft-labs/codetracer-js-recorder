/**
 * `jsbound.chk`, the checkpoint index of a boundary recording (CodeTracer's
 * JS-Boundary-Recording specification §5.5): one fixed-width row per
 * `Checkpoint` record of `jsbound.log`, `ordinal:u32, seq:u64,
 * log_offset:u64` (little-endian), where `log_offset` is the byte offset of
 * the `Checkpoint` frame in the log.
 *
 * The index is derived: the assembler writes it, any reader may rebuild it
 * from the log, and a reader must refuse a stored index that disagrees with
 * the log. This is the TypeScript side of codetracer `libs/jsbound`'s
 * `derive_checkpoint_index`, `encode_checkpoint_index` and
 * `verify_checkpoint_index`; the replay runner checks every recording it
 * reads against the index the Rust assembler wrote, so the two derivations
 * cannot drift apart unnoticed.
 */

import type { DecodedLog } from "./codec.js";

/** The width of one row: `ordinal:u32, seq:u64, log_offset:u64`. */
export const CHECKPOINT_ROW_LEN = 20;

/** One row of `jsbound.chk`. */
export interface CheckpointRow {
  ordinal: number;
  seq: bigint;
  /** The byte offset of the `Checkpoint` frame in `jsbound.log`. */
  logOffset: number;
}

/** The index of a decoded log: one row per `Checkpoint`, in log order. */
export function deriveCheckpointIndex(log: DecodedLog): CheckpointRow[] {
  const rows: CheckpointRow[] = [];
  log.records.forEach((r, i) => {
    if (r.record === "Checkpoint") {
      rows.push({ ordinal: r.ordinal, seq: r.seq, logOffset: log.offsets[i] });
    }
  });
  return rows;
}

/** The bytes of `jsbound.chk` for `rows`. */
export function encodeCheckpointIndex(
  rows: readonly CheckpointRow[],
): Uint8Array {
  const out = new Uint8Array(rows.length * CHECKPOINT_ROW_LEN);
  const view = new DataView(out.buffer);
  rows.forEach((row, i) => {
    const at = i * CHECKPOINT_ROW_LEN;
    view.setUint32(at, row.ordinal, true);
    view.setBigUint64(at + 4, row.seq, true);
    view.setBigUint64(at + 12, BigInt(row.logOffset), true);
  });
  return out;
}

/**
 * The rows of a stored `jsbound.chk`, unchecked: `undefined` when its length
 * is not a whole number of rows. Check them with {@link verifyCheckpointIndex}
 * before trusting them.
 */
export function decodeCheckpointIndex(
  bytes: Uint8Array,
): CheckpointRow[] | undefined {
  if (bytes.length % CHECKPOINT_ROW_LEN !== 0) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rows: CheckpointRow[] = [];
  for (let at = 0; at < bytes.length; at += CHECKPOINT_ROW_LEN) {
    rows.push({
      ordinal: view.getUint32(at, true),
      seq: view.getBigUint64(at + 4, true),
      logOffset: Number(view.getBigUint64(at + 12, true)),
    });
  }
  return rows;
}

/** A stored `jsbound.chk` that disagrees with its log (§5.5). */
export class CheckpointIndexMismatchError extends Error {
  constructor(detail: string) {
    super(`jsbound.chk: ${detail}`);
    this.name = "CheckpointIndexMismatchError";
  }
}

const describeRow = (r: CheckpointRow): string =>
  `{ordinal ${r.ordinal}, seq ${r.seq}, log_offset ${r.logOffset}}`;

/**
 * Check a stored `jsbound.chk` against the index rebuilt from `log` and
 * return the rows; throws {@link CheckpointIndexMismatchError}, naming the
 * first row that differs, for an index that was edited, reordered, extended,
 * shortened or cut mid-row. The comparison is of the whole encoding.
 */
export function verifyCheckpointIndex(
  log: DecodedLog,
  chk: Uint8Array,
): CheckpointRow[] {
  const rows = deriveCheckpointIndex(log);
  const rebuilt = encodeCheckpointIndex(rows);
  if (rebuilt.length === chk.length && rebuilt.every((b, i) => b === chk[i])) {
    return rows;
  }
  const stored = decodeCheckpointIndex(chk);
  if (stored === undefined) {
    throw new CheckpointIndexMismatchError(
      `it holds ${chk.length} byte(s), not a whole number of ${CHECKPOINT_ROW_LEN}-byte rows; the log's ${rows.length} Checkpoint record(s) index as ${rebuilt.length} byte(s)`,
    );
  }
  for (let i = 0; i < Math.min(stored.length, rows.length); i++) {
    const a = stored[i];
    const b = rows[i];
    if (
      a.ordinal !== b.ordinal ||
      a.seq !== b.seq ||
      a.logOffset !== b.logOffset
    ) {
      throw new CheckpointIndexMismatchError(
        `row ${i} is ${describeRow(a)}, but the log's Checkpoint record there indexes as ${describeRow(b)}`,
      );
    }
  }
  throw new CheckpointIndexMismatchError(
    `it holds ${stored.length} row(s), but the log has ${rows.length} Checkpoint record(s)`,
  );
}

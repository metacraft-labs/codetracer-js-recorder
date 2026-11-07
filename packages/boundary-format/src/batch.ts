/**
 * The uploaded batch (CodeTracer's Boundary-Ingest specification §4): how a
 * recorder sends a run of `jsbound.log` frames to the ingest.
 *
 * ```text
 * batch    := magic envelope frames
 * magic    := "CTJB" u8 version (1)
 * envelope := len:u32 json[len]        UTF-8 JSON, at most 4 KiB
 * frames   := CTBL-framed jsbound records, first_seq..last_seq
 * ```
 *
 * The envelope is `{session_id, batch_seq, first_seq, last_seq, dropped,
 * build_hash, final}`. Both parsers are held to one set of batch vectors
 * (`tests/boundary/vectors/batches.json`, written by the Rust side). One
 * deliberate difference: a seq above 2^53 - 1 is refused here, where a
 * JavaScript number could no longer hold it exactly. The Rust implementation (codetracer `libs/jsbound`,
 * `batch.rs`) parses the same shape for the assembler; this one serves the
 * recorders and the conformance suite, which checks the envelope of every
 * batch a framework uploads.
 */

import { BoundaryFormatError, decodeRecord, nextFrame } from "./codec.js";
import type { BoundaryRecord } from "./schema.js";

/** `"CTJB"`. */
export const BATCH_MAGIC = new Uint8Array([0x43, 0x54, 0x4a, 0x42]);
/** The one batch version. */
export const BATCH_VERSION = 1;
/** The largest envelope, in bytes. */
export const MAX_ENVELOPE_LEN = 4096;

/** The batch envelope. `seq`s are JSON numbers. */
export interface BatchEnvelope {
  /** The client-minted session id, 32 lowercase hex digits. */
  session_id: string;
  /** The batch's position in the session, from 0. */
  batch_seq: number;
  /** The `seq` of the batch's first seq-bearing record. */
  first_seq: number;
  /** The `seq` of the batch's last seq-bearing record. */
  last_seq: number;
  /** Inclusive `seq` ranges the recorder dropped before this batch. */
  dropped: [number, number][];
  /** The session's build hash, 64 lowercase hex digits. */
  build_hash: string;
  /** Whether this is the session's last batch. */
  final: boolean;
}

/** Why a batch body was refused. The Rust parser refuses the same ways. */
export type BatchErrorCode =
  | "BadMagic"
  | "UnsupportedVersion"
  | "EnvelopeTooLarge"
  | "Truncated"
  | "BadEnvelope"
  | "Frame";

export class BatchFormatError extends Error {
  readonly code: BatchErrorCode;
  constructor(code: BatchErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "BatchFormatError";
    this.code = code;
  }
}

/** A parsed batch. */
export interface ParsedBatch {
  envelope: BatchEnvelope;
  /** The batch's records, each decoded strictly as a frame. */
  records: BoundaryRecord[];
  /** The frame run itself (no stream prefix), as uploaded. */
  frames: Uint8Array;
}

const ENVELOPE_KEYS = [
  "session_id",
  "batch_seq",
  "first_seq",
  "last_seq",
  "dropped",
  "build_hash",
  "final",
] as const;

/** Encode a batch body from its envelope and frame run. */
export function encodeBatch(
  envelope: BatchEnvelope,
  frames: Uint8Array,
): Uint8Array {
  const ordered: Record<string, unknown> = {};
  for (const k of ENVELOPE_KEYS) ordered[k] = envelope[k];
  const json = new TextEncoder().encode(JSON.stringify(ordered));
  const out = new Uint8Array(9 + json.length + frames.length);
  out.set(BATCH_MAGIC, 0);
  out[4] = BATCH_VERSION;
  new DataView(out.buffer).setUint32(5, json.length, true);
  out.set(json, 9);
  out.set(frames, 9 + json.length);
  return out;
}

const isLowerHex = (s: unknown, len: number): boolean =>
  typeof s === "string" && s.length === len && /^[0-9a-f]+$/.test(s);

const isSeq = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/**
 * Parse a batch body: the magic, the envelope (every field present with its
 * type, `session_id` and `build_hash` lowercase hex, every `dropped` range
 * `[a, b]` with `1 <= a <= b`, no other field), and every frame whole and
 * decoded strictly. The stream rules (`Header` first, `seq` continuity)
 * are not applied: they hold across a session's batches, not within one.
 */
export function parseBatch(body: Uint8Array): ParsedBatch {
  if (body.length < 5) {
    throw new BatchFormatError(
      "Truncated",
      `${body.length} byte(s), shorter than the prefix`,
    );
  }
  for (let i = 0; i < 4; i++) {
    if (body[i] !== BATCH_MAGIC[i]) {
      throw new BatchFormatError(
        "BadMagic",
        'the batch does not start with "CTJB"',
      );
    }
  }
  if (body[4] !== BATCH_VERSION) {
    throw new BatchFormatError(
      "UnsupportedVersion",
      `batch version ${body[4]} is not supported (only ${BATCH_VERSION})`,
    );
  }
  if (body.length < 9) {
    throw new BatchFormatError("Truncated", "inside the envelope length");
  }
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const envLen = view.getUint32(5, true);
  if (envLen > MAX_ENVELOPE_LEN) {
    throw new BatchFormatError(
      "EnvelopeTooLarge",
      `the envelope declares ${envLen} bytes; the limit is ${MAX_ENVELOPE_LEN}`,
    );
  }
  const framesAt = 9 + envLen;
  if (body.length < framesAt) {
    throw new BatchFormatError("Truncated", "inside the envelope");
  }
  const envelope = parseEnvelope(body.subarray(9, framesAt));
  const frames = body.subarray(framesAt);
  const records: BoundaryRecord[] = [];
  let pos = 0;
  try {
    for (;;) {
      const frame = nextFrame(frames, pos);
      if (frame === undefined) break;
      records.push(decodeRecord(frame.payload, framesAt + pos));
      pos += 4 + frame.payload.length;
    }
  } catch (e) {
    if (e instanceof BoundaryFormatError) {
      throw new BatchFormatError("Frame", `a frame is refused: ${e.message}`);
    }
    throw e;
  }
  if (pos !== frames.length) {
    throw new BatchFormatError(
      "Truncated",
      `${frames.length - pos} byte(s) of a partial frame at the end`,
    );
  }
  return { envelope, records, frames };
}

/**
 * The rules serde (the Rust parser) applies to the envelope's JSON text and
 * `JSON.parse` does not: a field may appear once, and a number must be
 * written as an integer (`0`, not `0.0` or `0e0`). The envelope holds no
 * string that could contain a `"` unescaped, so the scan below needs only
 * to step over strings to find the keys and the numbers.
 */
function checkEnvelopeText(text: string): void {
  const keys = new Set<string>();
  for (const m of text.matchAll(/"((?:[^"\\]|\\.)*)"\s*:/g)) {
    let key: string;
    try {
      key = JSON.parse(`"${m[1]}"`) as string;
    } catch {
      continue; // not valid JSON: JSON.parse refuses the whole text
    }
    if (keys.has(key)) {
      throw new BatchFormatError(
        "BadEnvelope",
        `field ${JSON.stringify(key)} appears more than once`,
      );
    }
    keys.add(key);
  }
  const outsideStrings = text.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  for (const m of outsideStrings.matchAll(/-?[0-9][0-9.eE+-]*/g)) {
    if (/[.eE]/.test(m[0])) {
      throw new BatchFormatError(
        "BadEnvelope",
        `${m[0]} is not written as an integer`,
      );
    }
  }
}

function parseEnvelope(bytes: Uint8Array): BatchEnvelope {
  let json: unknown;
  let text: string;
  try {
    // ignoreBOM keeps a byte-order mark in the text, where JSON.parse
    // refuses it as serde does; the default would strip it silently.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
    json = JSON.parse(text);
  } catch (e) {
    throw new BatchFormatError(
      "BadEnvelope",
      `not UTF-8 JSON: ${(e as Error).message}`,
    );
  }
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    throw new BatchFormatError("BadEnvelope", "not a JSON object");
  }
  checkEnvelopeText(text);
  const o = json as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!(ENVELOPE_KEYS as readonly string[]).includes(k)) {
      throw new BatchFormatError(
        "BadEnvelope",
        `unknown field ${JSON.stringify(k)}`,
      );
    }
  }
  const bad = (why: string): never => {
    throw new BatchFormatError("BadEnvelope", why);
  };
  if (!isLowerHex(o.session_id, 32)) {
    bad(
      `session_id ${JSON.stringify(o.session_id)} is not 32 lowercase hex digits`,
    );
  }
  if (!isLowerHex(o.build_hash, 64)) {
    bad(
      `build_hash ${JSON.stringify(o.build_hash)} is not 64 lowercase hex digits`,
    );
  }
  for (const k of ["batch_seq", "first_seq", "last_seq"] as const) {
    if (!isSeq(o[k]))
      bad(`${k} ${JSON.stringify(o[k])} is not a non-negative integer`);
  }
  // An absent `dropped` or `final` takes its default; a `null` is refused,
  // as serde refuses it.
  const dropped = o.dropped === undefined ? [] : o.dropped;
  if (!Array.isArray(dropped)) bad("dropped is not an array");
  for (const range of dropped as unknown[]) {
    if (
      !Array.isArray(range) ||
      range.length !== 2 ||
      !isSeq(range[0]) ||
      !isSeq(range[1]) ||
      range[0] < 1 ||
      range[0] > range[1]
    ) {
      bad(`dropped range ${JSON.stringify(range)} is not a seq range`);
    }
  }
  const fin = o.final === undefined ? false : o.final;
  if (typeof fin !== "boolean") bad("final is not a boolean");
  return {
    session_id: o.session_id as string,
    batch_seq: o.batch_seq as number,
    first_seq: o.first_seq as number,
    last_seq: o.last_seq as number,
    dropped: dropped as [number, number][],
    build_hash: o.build_hash as string,
    final: fin as boolean,
  };
}

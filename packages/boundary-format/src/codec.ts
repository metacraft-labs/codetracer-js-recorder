/**
 * Encoder and strict decoder of `jsbound.log` (CodeTracer's
 * JS-Boundary-Recording specification, §5.2 and §5.3).
 *
 * ```text
 * stream  := "CTBL" version:u8(1) frame*
 * frame   := len:u32 tag:u8 body          1 <= len <= 64 MiB
 * ```
 *
 * The decoder refuses, with a {@link BoundaryFormatError} whose `code` is one
 * of {@link DECODE_ERROR_CODES}: a stream that is not CTBL version 1, an
 * unknown tag, a `vocab` other than 1, a frame of length 0 or over 64 MiB, a
 * frame shorter or longer than its fields, a string that is not UTF-8, an
 * unknown `blobref` kind, an enumerated field outside its value set
 * ({@link ENUM_VALUE_SETS}), an inline body over 1024 bytes, a first frame that
 * is not `Header` or a second that is not `Env`, a `seq` that does not follow
 * the previous one without a `Gap` covering the difference, a `Gap` that does
 * not, an `End` whose `last_seq` is not the last `seq`, and any byte after
 * `End`. A stream that merely stops early is not refused: it decodes, and its
 * {@link Termination} says how it stopped.
 *
 * The codes, the decoding and the encoding are held to the byte vectors the
 * Rust implementation (codetracer `libs/jsbound`) writes; the Rust decoder
 * reports the same code for every refusal vector.
 *
 * Works in browsers and Node alike: it uses only `Uint8Array`, `DataView`,
 * `TextEncoder` and `TextDecoder`.
 */

import {
  type BlobRef,
  type BoundaryRecord,
  type RecordDef,
  type WireType,
  CTBL_MAGIC,
  CTBL_VERSION,
  ENUM_VALUE_SETS,
  MAX_FRAME_LEN,
  MAX_INLINE_BLOB,
  VOCAB,
  recordDefByName,
  recordDefByTag,
  seqOf,
} from "./schema.js";

/** Every reason a stream is refused. The Rust decoder uses the same names. */
export const DECODE_ERROR_CODES = [
  "BadMagic",
  "UnsupportedVersion",
  "UnsupportedVocab",
  "UnknownTag",
  "EmptyFrame",
  "FrameTooLarge",
  "FieldOverrun",
  "TrailingFieldBytes",
  "InvalidUtf8",
  "UnknownBlobKind",
  "UnknownEnumValue",
  "InlineBlobTooLarge",
  "HeaderNotFirst",
  "EnvNotSecond",
  "SeqDiscontinuity",
  "GapMismatch",
  "EndSeqMismatch",
  "BytesAfterEnd",
] as const;

/** A refusal's name. */
export type DecodeErrorCode = (typeof DECODE_ERROR_CODES)[number];

/** A refused stream: which rule, and the offset of the frame it is about. */
export class BoundaryFormatError extends Error {
  readonly code: DecodeErrorCode;
  readonly offset: number;

  constructor(code: DecodeErrorCode, offset: number, detail: string) {
    super(`${code} at byte ${offset}: ${detail}`);
    this.name = "BoundaryFormatError";
    this.code = code;
    this.offset = offset;
  }
}

/** How a decoded stream ended (spec §5.3 rule 4). */
export type Termination =
  | "Complete"
  | "TruncatedUnterminated"
  | "TruncatedMidRecord";

/** A decoded `jsbound.log`. */
export interface DecodedLog {
  /** The complete records, in stream order. */
  records: BoundaryRecord[];
  /** The byte offset of each record's frame in the log. */
  offsets: number[];
  termination: Termination;
}

const U64_MAX = (1n << 64n) - 1n;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const utf8Encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/**
 * A growable little-endian byte buffer.
 *
 * Every writer calls `reserve` BEFORE touching `buf` or `view`: `reserve`
 * may replace both, and `this.view.setX(this.reserve(n), v)` would evaluate
 * `this.view` first and write into the buffer it just discarded.
 */
class ByteWriter {
  private buf = new Uint8Array(64);
  private view = new DataView(this.buf.buffer);
  length = 0;

  private reserve(n: number): number {
    const at = this.length;
    if (at + n > this.buf.length) {
      let size = this.buf.length * 2;
      while (size < at + n) size *= 2;
      const next = new Uint8Array(size);
      next.set(this.buf.subarray(0, at));
      this.buf = next;
      this.view = new DataView(next.buffer);
    }
    this.length += n;
    return at;
  }

  u8(v: number): void {
    const at = this.reserve(1);
    this.view.setUint8(at, v);
  }
  u16(v: number): void {
    const at = this.reserve(2);
    this.view.setUint16(at, v, true);
  }
  u32(v: number): void {
    const at = this.reserve(4);
    this.view.setUint32(at, v, true);
  }
  u64(v: bigint): void {
    const at = this.reserve(8);
    this.view.setBigUint64(at, v, true);
  }
  f64(v: number): void {
    const at = this.reserve(8);
    this.view.setFloat64(at, v, true);
  }
  bytes(b: Uint8Array): void {
    const at = this.reserve(b.length);
    this.buf.set(b, at);
  }
  lenPrefixed(b: Uint8Array): void {
    this.u32(b.length);
    this.bytes(b);
  }
  setU32At(at: number, v: number): void {
    this.view.setUint32(at, v, true);
  }
  finish(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

function checkInt(name: string, v: unknown, max: number): asserts v is number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > max) {
    throw new RangeError(
      `${name}: ${String(v)} is not an integer in 0..${max}`,
    );
  }
}

function putField(
  w: ByteWriter,
  name: string,
  type: WireType,
  v: unknown,
): void {
  switch (type) {
    case "u8":
      checkInt(name, v, 0xff);
      return w.u8(v);
    case "u16":
      checkInt(name, v, 0xffff);
      return w.u16(v);
    case "u32":
      checkInt(name, v, 0xffffffff);
      return w.u32(v);
    case "u64":
      if (typeof v !== "bigint" || v < 0n || v > U64_MAX) {
        throw new RangeError(`${name}: ${String(v)} is not a u64 bigint`);
      }
      return w.u64(v);
    case "f64":
      if (typeof v !== "number") {
        throw new TypeError(`${name}: ${String(v)} is not a number`);
      }
      return w.f64(v);
    case "str":
      if (typeof v !== "string") {
        throw new TypeError(`${name}: ${String(v)} is not a string`);
      }
      return w.lenPrefixed(utf8Encoder.encode(v));
    case "bytes":
      if (!(v instanceof Uint8Array)) {
        throw new TypeError(`${name}: not a Uint8Array`);
      }
      return w.lenPrefixed(v);
    case "blob": {
      const blob = v as BlobRef;
      if (blob?.kind === "inline" && blob.bytes instanceof Uint8Array) {
        w.u8(0);
        return w.lenPrefixed(blob.bytes);
      }
      if (
        blob?.kind === "ref" &&
        blob.sha256 instanceof Uint8Array &&
        blob.sha256.length === 32
      ) {
        w.u8(1);
        w.bytes(blob.sha256);
        return putField(w, `${name}.len`, "u64", blob.len);
      }
      throw new TypeError(
        `${name}: not a blobref ({kind: "inline", bytes} or {kind: "ref", sha256: 32 bytes, len})`,
      );
    }
  }
}

function writeFrame(w: ByteWriter, record: BoundaryRecord): void {
  const def = recordDefByName(record.record);
  if (def === undefined) {
    throw new TypeError(`unknown record kind ${String(record.record)}`);
  }
  const lenAt = w.length;
  w.u32(0); // patched below
  w.u8(def.tag);
  const fields = record as unknown as Record<string, unknown>;
  for (const [name, type] of def.fields) {
    putField(w, `${def.name}.${name}`, type, fields[name]);
  }
  w.setU32At(lenAt, w.length - lenAt - 4);
}

/**
 * Encode one record as a complete frame (`len:u32 tag:u8 body`). A producer
 * writes each frame with one write, so a crash leaves whole frames.
 *
 * @throws RangeError / TypeError for a field of the wrong type or range.
 */
export function encodeFrame(record: BoundaryRecord): Uint8Array {
  const w = new ByteWriter();
  writeFrame(w, record);
  return w.finish();
}

/** Encode a frame run with no stream prefix (the body of an uploaded batch). */
export function encodeFrames(records: readonly BoundaryRecord[]): Uint8Array {
  const w = new ByteWriter();
  for (const r of records) writeFrame(w, r);
  return w.finish();
}

/** The `"CTBL" 1` stream prefix. */
export function streamPrefix(): Uint8Array {
  const p = new Uint8Array(5);
  p.set(CTBL_MAGIC);
  p[4] = CTBL_VERSION;
  return p;
}

/** Encode a whole `jsbound.log`: the stream prefix and every frame. */
export function encodeLog(records: readonly BoundaryRecord[]): Uint8Array {
  const w = new ByteWriter();
  w.bytes(streamPrefix());
  for (const r of records) writeFrame(w, r);
  return w.finish();
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/** Reads one frame's payload; a shortfall is `FieldOverrun`. */
class PayloadReader {
  private pos = 0;
  private readonly view: DataView;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly frameOffset: number,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get position(): number {
    return this.pos;
  }

  get length(): number {
    return this.bytes.length;
  }

  private take(n: number): number {
    if (this.pos + n > this.bytes.length) {
      throw new BoundaryFormatError(
        "FieldOverrun",
        this.frameOffset,
        `the frame is shorter than its fields: wanted ${n} byte(s) at payload offset ${this.pos} of ${this.bytes.length}`,
      );
    }
    const at = this.pos;
    this.pos += n;
    return at;
  }

  u8(): number {
    return this.view.getUint8(this.take(1));
  }
  u16(): number {
    return this.view.getUint16(this.take(2), true);
  }
  u32(): number {
    return this.view.getUint32(this.take(4), true);
  }
  u64(): bigint {
    return this.view.getBigUint64(this.take(8), true);
  }
  f64(): number {
    return this.view.getFloat64(this.take(8), true);
  }
  raw(n: number): Uint8Array {
    const at = this.take(n);
    return this.bytes.slice(at, at + n);
  }
  lenPrefixed(): Uint8Array {
    return this.raw(this.u32());
  }
}

function getField(r: PayloadReader, type: WireType, offset: number): unknown {
  switch (type) {
    case "u8":
      return r.u8();
    case "u16":
      return r.u16();
    case "u32":
      return r.u32();
    case "u64":
      return r.u64();
    case "f64":
      return r.f64();
    case "str": {
      const at = r.position;
      const bytes = r.lenPrefixed();
      try {
        return utf8Decoder.decode(bytes);
      } catch {
        throw new BoundaryFormatError(
          "InvalidUtf8",
          offset,
          `the string at payload offset ${at} is not UTF-8`,
        );
      }
    }
    case "bytes":
      return r.lenPrefixed();
    case "blob": {
      const kind = r.u8();
      if (kind === 0) return { kind: "inline", bytes: r.lenPrefixed() };
      if (kind === 1) return { kind: "ref", sha256: r.raw(32), len: r.u64() };
      throw new BoundaryFormatError(
        "UnknownBlobKind",
        offset,
        `blobref kind ${kind} is neither 0 (inline) nor 1 (reference)`,
      );
    }
  }
}

/**
 * Decode one frame payload (`tag:u8 body`). `offset` is the frame's offset
 * in the input, for the error.
 */
export function decodeRecord(payload: Uint8Array, offset = 0): BoundaryRecord {
  const r = new PayloadReader(payload, offset);
  const tag = r.u8();
  const def: RecordDef | undefined = recordDefByTag(tag);
  if (def === undefined) {
    throw new BoundaryFormatError(
      "UnknownTag",
      offset,
      `frame tag 0x${tag.toString(16).padStart(2, "0")} is not a jsbound record (vocab ${VOCAB} defines 0x40-0x53 and 0x5f)`,
    );
  }
  const record: Record<string, unknown> = { record: def.name };
  for (const [name, type] of def.fields) {
    record[name] = getField(r, type, offset);
  }
  if (r.position !== r.length) {
    throw new BoundaryFormatError(
      "TrailingFieldBytes",
      offset,
      `the ${def.name} frame has ${r.length - r.position} byte(s) after its last field`,
    );
  }
  // Once the frame is whole: every enumerated field, in wire order.
  for (const [name, type] of def.fields) {
    if (type !== "u8") continue;
    const set = ENUM_VALUE_SETS[def.name]?.[name];
    const v = record[name] as number;
    if (set === undefined || v < set[0] || v > set[1]) {
      throw new BoundaryFormatError(
        "UnknownEnumValue",
        offset,
        set === undefined
          ? `${def.name}.${name} is a u8 field with no value set in this decoder`
          : `${def.name}.${name} is ${v}; vocab ${VOCAB} defines ${set[0]} to ${set[1]}`,
      );
    }
  }
  return record as unknown as BoundaryRecord;
}

/**
 * The stream-level rules of spec §5.3, applied record by record. Exported
 * for producers that want to check a stream as they write it.
 */
export class StreamRules {
  private count = 0;
  private nextSeq = 1n;
  private isEnded = false;

  /** Whether `End` has been accepted. */
  get ended(): boolean {
    return this.isEnded;
  }

  /** The last `seq` accepted (0 before any). */
  get lastSeq(): bigint {
    return this.nextSeq - 1n;
  }

  /** Check `record`, found at `offset`, and advance; throws on a refusal. */
  accept(record: BoundaryRecord, offset: number): void {
    const fail = (code: DecodeErrorCode, detail: string): never => {
      throw new BoundaryFormatError(code, offset, detail);
    };
    if (this.isEnded) {
      fail("BytesAfterEnd", `a ${record.record} frame follows the End frame`);
    }
    if (this.count === 0) {
      if (record.record !== "Header") {
        fail(
          "HeaderNotFirst",
          `the first frame must be Header, but it is ${record.record}`,
        );
      } else if (record.vocab !== VOCAB) {
        fail(
          "UnsupportedVocab",
          `Header vocab ${record.vocab} is not supported: this decoder reads vocab ${VOCAB} only`,
        );
      }
    } else if (record.record === "Header") {
      fail("HeaderNotFirst", "a second Header frame");
    } else if (this.count === 1 && record.record !== "Env") {
      fail(
        "EnvNotSecond",
        `the second frame must be Env, but it is ${record.record}`,
      );
    } else if (this.count > 1 && record.record === "Env") {
      fail("EnvNotSecond", "a second Env frame");
    } else if (record.record === "Gap") {
      if (
        record.first_seq !== this.nextSeq ||
        record.last_seq < record.first_seq
      ) {
        fail(
          "GapMismatch",
          `Gap ${record.first_seq}..${record.last_seq} does not cover a range starting at the next seq ${this.nextSeq}`,
        );
      }
      this.nextSeq = this.after(record.last_seq, offset);
    } else if (record.record === "End") {
      if (record.last_seq !== this.lastSeq) {
        fail(
          "EndSeqMismatch",
          `End.last_seq is ${record.last_seq}, but the last seq is ${this.lastSeq}`,
        );
      }
      this.isEnded = true;
    } else if (record.record !== "Env") {
      const seq = seqOf(record) as bigint;
      if (seq !== this.nextSeq) {
        fail(
          "SeqDiscontinuity",
          `${record.record} has seq ${seq}, but the next seq is ${this.nextSeq} and no Gap covers the difference`,
        );
      }
      this.nextSeq = this.after(seq, offset);
    }
    if (
      (record.record === "NetResponse" && isLargeInline(record.body)) ||
      (record.record === "WsMessage" && isLargeInline(record.data))
    ) {
      fail(
        "InlineBlobTooLarge",
        `${record.record} carries an inline body over ${MAX_INLINE_BLOB} bytes`,
      );
    }
    this.count += 1;
  }

  private after(seq: bigint, offset: number): bigint {
    if (seq >= U64_MAX) {
      throw new BoundaryFormatError(
        "SeqDiscontinuity",
        offset,
        "seq overflows u64",
      );
    }
    return seq + 1n;
  }
}

function isLargeInline(blob: BlobRef): boolean {
  return blob.kind === "inline" && blob.bytes.length > MAX_INLINE_BLOB;
}

/**
 * Decode a whole `jsbound.log` strictly. Throws {@link BoundaryFormatError}
 * on a refusal; a stream that stops early decodes with its termination
 * class, its partial last frame (if any) discarded.
 */
export function decodeLog(bytes: Uint8Array): DecodedLog {
  const magicLen = Math.min(bytes.length, 4);
  for (let i = 0; i < magicLen; i++) {
    if (bytes[i] !== CTBL_MAGIC[i]) {
      throw new BoundaryFormatError(
        "BadMagic",
        0,
        'a jsbound.log starts with "CTBL", but this one does not',
      );
    }
  }
  if (bytes.length >= 5 && bytes[4] !== CTBL_VERSION) {
    throw new BoundaryFormatError(
      "UnsupportedVersion",
      4,
      `CTBL version ${bytes[4]} is not supported: this decoder reads version ${CTBL_VERSION} only`,
    );
  }
  if (bytes.length < 5) {
    return { records: [], offsets: [], termination: "TruncatedMidRecord" };
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rules = new StreamRules();
  const records: BoundaryRecord[] = [];
  const offsets: number[] = [];
  let pos = 5;
  for (;;) {
    const remaining = bytes.length - pos;
    if (rules.ended && remaining > 0) {
      throw new BoundaryFormatError(
        "BytesAfterEnd",
        pos,
        `${remaining} byte(s) follow the End frame`,
      );
    }
    if (remaining < 4) break;
    const len = view.getUint32(pos, true);
    if (len === 0) {
      throw new BoundaryFormatError(
        "EmptyFrame",
        pos,
        "a frame of length 0 has no room for its tag",
      );
    }
    if (len > MAX_FRAME_LEN) {
      throw new BoundaryFormatError(
        "FrameTooLarge",
        pos,
        `a frame declares ${len} bytes; the limit is ${MAX_FRAME_LEN} (64 MiB)`,
      );
    }
    if (remaining < 4 + len) break;
    const record = decodeRecord(bytes.subarray(pos + 4, pos + 4 + len), pos);
    rules.accept(record, pos);
    records.push(record);
    offsets.push(pos);
    pos += 4 + len;
  }
  const termination: Termination =
    pos < bytes.length
      ? "TruncatedMidRecord"
      : rules.ended
        ? "Complete"
        : "TruncatedUnterminated";
  return { records, offsets, termination };
}

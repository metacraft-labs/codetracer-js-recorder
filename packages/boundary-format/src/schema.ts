/**
 * The records of `jsbound.log`, the JS boundary log (CodeTracer's
 * JS-Boundary-Recording specification, §5.2), declared once.
 *
 * Each record is a tag, a name and its fields in wire order with their wire
 * types. The encoder, the strict decoder, the canonical JSON form and the
 * TypeScript record types are all derived from this table. The Rust
 * implementation (codetracer `libs/jsbound/src/record.rs`) declares the same
 * table, and the two are held to one set of byte vectors
 * (`tests/boundary/vectors/`, vendored by `scripts/vendor-jsbound-vectors.sh`).
 *
 * Wire types (all integers little-endian):
 *
 * | type    | bytes                                   | TypeScript    |
 * |---------|-----------------------------------------|---------------|
 * | `u8`    | 1                                       | `number`      |
 * | `u16`   | 2                                       | `number`      |
 * | `u32`   | 4                                       | `number`      |
 * | `u64`   | 8                                       | `bigint`      |
 * | `f64`   | 8, the IEEE-754 bits                    | `number`      |
 * | `str`   | `len:u32` then UTF-8                    | `string`      |
 * | `bytes` | `len:u32` then raw bytes                | `Uint8Array`  |
 * | `blob`  | `kind:u8` then inline bytes or a ref    | {@link BlobRef} |
 */

/** A wire field type. */
export type WireType =
  | "u8"
  | "u16"
  | "u32"
  | "u64"
  | "f64"
  | "str"
  | "bytes"
  | "blob";

/**
 * A body carried inline (kind 0, at most 1024 bytes in `jsbound.log`) or
 * referenced in `jsbound.blb` by its SHA-256 (kind 1).
 */
export type BlobRef =
  | { kind: "inline"; bytes: Uint8Array }
  | { kind: "ref"; sha256: Uint8Array; len: bigint };

/** The CTBL framing version `jsbound.log` uses. */
export const CTBL_VERSION = 1;
/** `"CTBL"`. */
export const CTBL_MAGIC = new Uint8Array([0x43, 0x54, 0x42, 0x4c]);
/** The `Header.vocab` this implementation reads and writes. */
export const VOCAB = 1;
/** The largest frame a decoder accepts: 64 MiB. */
export const MAX_FRAME_LEN = 64 * 1024 * 1024;
/** The largest body `jsbound.log` carries inline. */
export const MAX_INLINE_BLOB = 1024;

/** The record table (spec §5.2). Field names are the spec's. */
export const RECORD_SCHEMA = [
  {
    tag: 0x40,
    name: "Header",
    fields: [
      ["vocab", "u16"],
      ["protocol_level", "u8"],
      ["recorder_id", "str"],
      ["framework", "str"],
      ["build_hash", "str"],
      ["session_id", "str"],
      ["prev_session", "str"],
      ["capabilities", "str"],
    ],
  },
  {
    tag: 0x41,
    name: "Env",
    fields: [
      ["ua", "str"],
      ["ua_major", "u16"],
      ["viewport_w", "u32"],
      ["viewport_h", "u32"],
      ["dpr", "f64"],
      ["locale", "str"],
      ["tz", "str"],
      ["fonts_digest", "str"],
      ["color_scheme", "u8"],
      ["reduced_motion", "u8"],
      ["arms", "str"],
      ["url", "str"],
      ["referrer_origin", "str"],
      ["traceparent", "str"],
    ],
  },
  {
    tag: 0x42,
    name: "Task",
    fields: [
      ["seq", "u64"],
      ["task_id", "u64"],
      ["kind", "u8"],
    ],
  },
  {
    tag: 0x43,
    name: "TaskReg",
    fields: [
      ["seq", "u64"],
      ["task_id", "u64"],
      ["kind", "u8"],
      ["delay_ms", "f64"],
    ],
  },
  {
    tag: 0x44,
    name: "Clock",
    fields: [
      ["seq", "u64"],
      ["src", "u8"],
      ["bits", "u64"],
    ],
  },
  {
    tag: 0x45,
    name: "Random",
    fields: [
      ["seq", "u64"],
      ["src", "u8"],
      ["bytes", "bytes"],
    ],
  },
  {
    tag: 0x46,
    name: "NetRequest",
    fields: [
      ["seq", "u64"],
      ["req_id", "u64"],
      ["api", "u8"],
      ["method", "str"],
      ["url", "str"],
      ["body_digest", "str"],
    ],
  },
  {
    tag: 0x47,
    name: "NetResponse",
    fields: [
      ["seq", "u64"],
      ["req_id", "u64"],
      ["outcome", "u8"],
      ["status", "u16"],
      ["headers", "str"],
      ["body", "blob"],
    ],
  },
  {
    tag: 0x48,
    name: "WsMessage",
    fields: [
      ["seq", "u64"],
      ["req_id", "u64"],
      ["dir", "u8"],
      ["data", "blob"],
    ],
  },
  {
    tag: 0x49,
    name: "StorageRead",
    fields: [
      ["seq", "u64"],
      ["area", "u8"],
      ["key", "str"],
      ["present", "u8"],
      ["value", "str"],
    ],
  },
  {
    tag: 0x4a,
    name: "LayoutRead",
    fields: [
      ["seq", "u64"],
      ["target", "str"],
      ["prop", "str"],
      ["value", "str"],
    ],
  },
  {
    tag: 0x4b,
    name: "Input",
    fields: [
      ["seq", "u64"],
      ["task_id", "u64"],
      ["type", "str"],
      ["target", "str"],
      ["props", "str"],
      ["label", "str"],
    ],
  },
  {
    tag: 0x4c,
    name: "DomEffect",
    fields: [
      ["seq", "u64"],
      ["target", "str"],
      ["effect", "u8"],
      ["value", "str"],
    ],
  },
  {
    tag: 0x4d,
    name: "Checkpoint",
    fields: [
      ["seq", "u64"],
      ["ordinal", "u32"],
      ["scheme", "str"],
      ["state_hash", "str"],
      ["dom_digest", "str"],
    ],
  },
  {
    tag: 0x4e,
    name: "Refusal",
    fields: [
      ["seq", "u64"],
      ["feature", "str"],
      ["detail", "str"],
    ],
  },
  {
    tag: 0x4f,
    name: "Navigation",
    fields: [
      ["seq", "u64"],
      ["kind", "u8"],
      ["url", "str"],
    ],
  },
  {
    tag: 0x50,
    name: "Error",
    fields: [
      ["seq", "u64"],
      ["kind", "u8"],
      ["message", "str"],
      ["frames", "str"],
    ],
  },
  {
    tag: 0x51,
    name: "Scrubbed",
    fields: [
      ["seq", "u64"],
      ["target", "str"],
      ["class", "u8"],
      ["length", "u32"],
    ],
  },
  {
    tag: 0x52,
    name: "Gap",
    fields: [
      ["first_seq", "u64"],
      ["last_seq", "u64"],
      ["reason", "u8"],
    ],
  },
  {
    tag: 0x53,
    name: "Mark",
    fields: [
      ["seq", "u64"],
      ["name", "str"],
      ["data", "str"],
    ],
  },
  {
    tag: 0x5f,
    name: "End",
    fields: [
      ["last_seq", "u64"],
      ["reason", "u8"],
    ],
  },
] as const satisfies readonly {
  tag: number;
  name: string;
  fields: readonly (readonly [string, WireType])[];
}[];

/**
 * The value set of every enumerated field (spec §5.2), as `[least,
 * greatest]`: every `u8` field of {@link RECORD_SCHEMA} is one, and the
 * strict decoder refuses a value outside its set as `UnknownEnumValue`
 * (§5.3 rule 2). The Rust implementation carries the same table
 * (`VALUE_SETS` in codetracer `libs/jsbound/src/record.rs`), and the
 * shared refusal vectors step one past each end of every set.
 */
export const ENUM_VALUE_SETS: Readonly<
  Record<string, Readonly<Record<string, readonly [number, number]>>>
> = {
  // §9.1 levels.
  Header: { protocol_level: [0, 1] },
  // §10.4: 0 no preference, 1 light, 2 dark; 1 when reduced motion.
  Env: { color_scheme: [0, 2], reduced_motion: [0, 1] },
  Task: { kind: [1, 12] },
  TaskReg: { kind: [1, 12] },
  Clock: { src: [1, 5] },
  Random: { src: [1, 3] },
  NetRequest: { api: [1, 5] },
  NetResponse: { outcome: [1, 5] },
  WsMessage: { dir: [1, 4] },
  StorageRead: { area: [1, 3], present: [0, 2] },
  DomEffect: { effect: [1, 6] },
  Navigation: { kind: [1, 5] },
  Error: { kind: [1, 2] },
  Scrubbed: { class: [1, 4] },
  Gap: { reason: [1, 3] },
  End: { reason: [1, 4] },
};

type Schema = (typeof RECORD_SCHEMA)[number];

/** The TypeScript type of a wire type's value. */
export type WireValue<T extends WireType> = T extends "u64"
  ? bigint
  : T extends "str"
    ? string
    : T extends "bytes"
      ? Uint8Array
      : T extends "blob"
        ? BlobRef
        : number;

type RecordFromSchema<D> = D extends {
  name: infer N;
  fields: infer F extends readonly (readonly [string, WireType])[];
}
  ? { record: N } & {
      -readonly [K in F[number] as K[0]]: WireValue<K[1]>;
    }
  : never;

/** One record of `jsbound.log`, discriminated by `record`. */
export type BoundaryRecord = RecordFromSchema<Schema>;

/** A record kind's name (`"Clock"`, `"Gap"`, …). */
export type RecordKind = Schema["name"];

/** The record type of one kind. */
export type RecordOf<K extends RecordKind> = Extract<
  BoundaryRecord,
  { record: K }
>;

/** A schema entry as code that walks it sees it. */
export interface RecordDef {
  readonly tag: number;
  readonly name: RecordKind;
  readonly fields: readonly (readonly [string, WireType])[];
}

const BY_TAG = new Map<number, RecordDef>(
  RECORD_SCHEMA.map((d) => [d.tag, d as RecordDef]),
);
const BY_NAME = new Map<string, RecordDef>(
  RECORD_SCHEMA.map((d) => [d.name, d as RecordDef]),
);

/** The definition of the record with `tag`, if this vocabulary has one. */
export function recordDefByTag(tag: number): RecordDef | undefined {
  return BY_TAG.get(tag);
}

/** The definition of the record kind `name`, if this vocabulary has one. */
export function recordDefByName(name: string): RecordDef | undefined {
  return BY_NAME.get(name);
}

/**
 * The record's `seq`, for every kind that carries one (all but `Header`,
 * `Env`, `Gap` and `End`).
 */
export function seqOf(record: BoundaryRecord): bigint | undefined {
  return "seq" in record ? record.seq : undefined;
}

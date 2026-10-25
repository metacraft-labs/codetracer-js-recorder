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
      ["status_text", "str"],
      ["url", "str"],
      ["redirected", "u8"],
      ["response_type", "u8"],
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
      ["frame", "u8"],
      ["event", "str"],
      ["last_event_id", "str"],
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
    tag: 0x56,
    name: "XhrEvent",
    fields: [
      ["seq", "u64"],
      ["req_id", "u64"],
      ["target", "u8"],
      ["event", "u8"],
      ["loaded", "u64"],
      ["total", "u64"],
      ["length_computable", "u8"],
    ],
  },
  {
    tag: 0x57,
    name: "Loading",
    fields: [
      ["seq", "u64"],
      ["phase", "u8"],
      ["elements", "u32"],
      ["scripts", "u32"],
    ],
  },
  {
    tag: 0x58,
    name: "DocTask",
    fields: [
      ["seq", "u64"],
      ["kind", "u8"],
      ["src", "str"],
    ],
  },
  {
    tag: 0x59,
    name: "PlatformValue",
    fields: [
      ["seq", "u64"],
      ["src", "u8"],
      ["task_id", "u64"],
      ["query", "str"],
      ["value", "str"],
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
  // 13 a platform task: a promise the platform settles in a task of its own
  // (a whole-body read of a `Blob`, a `Request` or a `Response` the page
  // made; `crypto.subtle.digest`).
  Task: { kind: [1, 13] },
  TaskReg: { kind: [1, 13] },
  // 6 `IdleDeadline.timeRemaining()`, 7 `performance.timeOrigin`.
  Clock: { src: [1, 7] },
  Random: { src: [1, 3] },
  NetRequest: { api: [1, 5] },
  // `redirected` a boolean; `response_type` 0 (not a `fetch` response), then
  // the Fetch standard's types (RESPONSE_TYPE).
  NetResponse: { outcome: [1, 5], redirected: [0, 1], response_type: [0, 6] },
  // `frame` 0 not a message (a body piece, a close, a body's end), 1 text,
  // 2 binary (WS_FRAME).
  WsMessage: { dir: [1, 4], frame: [0, 2] },
  StorageRead: { area: [1, 3], present: [0, 2] },
  DomEffect: { effect: [1, 6] },
  Navigation: { kind: [1, 5] },
  Error: { kind: [1, 2] },
  Scrubbed: { class: [1, 4] },
  Gap: { reason: [1, 3] },
  End: { reason: [1, 4] },
  // 1 the request, 2 its upload object; the seven `ProgressEvent` types an
  // XMLHttpRequest dispatches (XHR_EVENT); a boolean.
  XhrEvent: { target: [1, 2], event: [1, 7], length_computable: [0, 1] },
  // 1 parsing, 2 parsed and DOMContentLoaded not yet dispatched, 3 after
  // DOMContentLoaded and before load (LOADING_PHASE).
  Loading: { phase: [1, 3] },
  // 1 a script runs, 2 DOMContentLoaded, 3 load, 4 a script ran that wrote no
  // record while it ran (DOC_TASK).
  DocTask: { kind: [1, 4] },
  // What produced the value (PLATFORM_VALUE_SRC).
  PlatformValue: { src: [1, 6] },
};

/**
 * `XhrEvent.target` and `XhrEvent.event` values (spec §5.2): where an
 * XMLHttpRequest `ProgressEvent` was dispatched, and its type.
 */
export const XHR_EVENT = {
  target: { request: 1, upload: 2 },
  event: {
    loadstart: 1,
    progress: 2,
    abort: 3,
    error: 4,
    load: 5,
    timeout: 6,
    loadend: 7,
  },
} as const;

/**
 * `Loading.phase` values (spec §5.2, §6 "The document's own tasks"): where
 * the document was in its own loading when the records that follow ran.
 */
export const LOADING_PHASE = {
  parsing: 1,
  parsed: 2,
  contentLoaded: 3,
} as const;

/**
 * `DocTask.kind` values (spec §5.2, §6 "The document's own tasks"): a task
 * of the document's own loading that runs page code.
 */
export const DOC_TASK = {
  /** A script runs: written before its first record, which follow. */
  script: 1,
  domContentLoaded: 2,
  load: 3,
  /**
   * A script ran that wrote no record while it ran (a module, or one whose
   * first boundary read was in a microtask): written when it settled.
   */
  scriptSettled: 4,
} as const;

/**
 * `NetResponse.response_type` values (spec §5.2): 0 for a response that is
 * not a `fetch` one, otherwise the response's `type` (Fetch standard,
 * "response type", https://fetch.spec.whatwg.org/#concept-response-type).
 */
export const RESPONSE_TYPE = {
  none: 0,
  basic: 1,
  cors: 2,
  default: 3,
  error: 4,
  opaque: 5,
  opaqueredirect: 6,
} as const;

/**
 * `WsMessage.frame` values (spec §5.2): whether an inbound or outbound
 * message was a text or a binary one (WebSocket standard, "message type";
 * an `EventSource` message is always text). 0 for the records that are not
 * messages: a piece or the end of a streamed body, and a close.
 */
export const WS_FRAME = { none: 0, text: 1, binary: 2 } as const;

/**
 * `PlatformValue.src` values (spec §5.2): which platform object handed the
 * page the value.
 */
export const PLATFORM_VALUE_SRC = {
  /** `IntersectionObserverEntry` list (callback or `takeRecords()`). */
  intersectionObserver: 1,
  /** `ResizeObserverEntry` list (callback). */
  resizeObserver: 2,
  /** `MutationRecord` list (callback or `takeRecords()`); compared. */
  mutationObserver: 3,
  /** `PerformanceObserver` entry list (callback or `takeRecords()`). */
  performanceObserver: 4,
  /** A read of the performance timeline (`performance.getEntries*()`, …). */
  performance: 5,
  /** `IdleDeadline.didTimeout`. */
  idleDeadline: 6,
} as const;

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

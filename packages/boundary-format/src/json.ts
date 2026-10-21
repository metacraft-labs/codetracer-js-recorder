/**
 * The canonical JSON form of a boundary record: the form the shared byte
 * vectors' expectations are written in, by the Rust implementation, and the
 * one tools print.
 *
 * `{"record": "<Kind>", "<field>": <value>, …}` with `u8`/`u16`/`u32` and
 * `f64` as JSON numbers, `u64` as a decimal string (a JSON number cannot
 * carry 64 bits in JavaScript), byte strings as lowercase hex, and a
 * `blobref` as `{"kind": "inline", "bytes"}` or `{"kind": "ref", "sha256",
 * "len"}`.
 */

import {
  type BlobRef,
  type BoundaryRecord,
  type WireType,
  recordDefByName,
} from "./schema.js";

/** A JSON value. */
export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

/** Lowercase hexadecimal. */
export function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** The inverse of {@link toHex}; throws on anything but an even run of hex digits. */
export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) {
    throw new TypeError(`not lowercase hex: ${JSON.stringify(hex)}`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

function fieldToJson(type: WireType, v: unknown): Json {
  switch (type) {
    case "u64":
      return (v as bigint).toString();
    case "bytes":
      return toHex(v as Uint8Array);
    case "blob": {
      const b = v as BlobRef;
      return b.kind === "inline"
        ? { kind: "inline", bytes: toHex(b.bytes) }
        : { kind: "ref", sha256: toHex(b.sha256), len: b.len.toString() };
    }
    default:
      return v as number | string;
  }
}

function fieldFromJson(
  name: string,
  type: WireType,
  v: Json | undefined,
): unknown {
  const fail = (): never => {
    throw new TypeError(`${name}: ${JSON.stringify(v)} is not a ${type}`);
  };
  switch (type) {
    case "u64":
      return typeof v === "string" && /^[0-9]+$/.test(v) ? BigInt(v) : fail();
    case "bytes":
      return typeof v === "string" ? fromHex(v) : fail();
    case "str":
      return typeof v === "string" ? v : fail();
    case "blob": {
      if (v === null || typeof v !== "object" || Array.isArray(v))
        return fail();
      if (v.kind === "inline" && typeof v.bytes === "string") {
        return { kind: "inline", bytes: fromHex(v.bytes) };
      }
      if (v.kind === "ref" && typeof v.sha256 === "string") {
        return {
          kind: "ref",
          sha256: fromHex(v.sha256),
          len: fieldFromJson(`${name}.len`, "u64", v.len),
        };
      }
      return fail();
    }
    default:
      return typeof v === "number" ? v : fail();
  }
}

/** The canonical JSON form of `record`. */
export function recordToJson(record: BoundaryRecord): { [key: string]: Json } {
  const def = recordDefByName(record.record);
  if (def === undefined) {
    throw new TypeError(`unknown record kind ${String(record.record)}`);
  }
  const fields = record as unknown as Record<string, unknown>;
  const out: { [key: string]: Json } = { record: def.name };
  for (const [name, type] of def.fields) {
    out[name] = fieldToJson(type, fields[name]);
  }
  return out;
}

/**
 * The record a canonical JSON object describes. Throws on an unknown kind,
 * a missing or extra field, or a value of the wrong type.
 */
export function recordFromJson(json: Json): BoundaryRecord {
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    throw new TypeError("a record is a JSON object");
  }
  const def =
    typeof json.record === "string" ? recordDefByName(json.record) : undefined;
  if (def === undefined) {
    throw new TypeError(`unknown record kind ${JSON.stringify(json.record)}`);
  }
  const out: Record<string, unknown> = { record: def.name };
  const known = new Set<string>(["record"]);
  for (const [name, type] of def.fields) {
    known.add(name);
    out[name] = fieldFromJson(`${def.name}.${name}`, type, json[name]);
  }
  for (const key of Object.keys(json)) {
    if (!known.has(key)) {
      throw new TypeError(`${def.name} has no field ${key}`);
    }
  }
  return out as unknown as BoundaryRecord;
}

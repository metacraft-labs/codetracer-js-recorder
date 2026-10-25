/**
 * Reading the boundary recording a replay starts from (CodeTracer's
 * JS-Boundary-Recording specification §5).
 *
 * A recording is a CTFS container (`.ct`, §5.1) holding `jsbound.log` and
 * `jsbound.blb`; its members are read through the canonical CTFS reader in
 * the recorder's native addon, never through a second container decoder.
 * A bare `jsbound.log` stream (starting with `"CTBL"`) is accepted too, as
 * the generic shim's `log()` and a joined set of batches give it; its
 * bodies are inline whatever their size, as in an uploaded batch (§5.2).
 *
 * The log is decoded strictly (§5.3) and every `jsbound.blb` reference
 * resolved, so the page receives one self-contained stream.
 *
 * A container's `jsbound.chk` (§5.5) is checked against the index rebuilt
 * from its `jsbound.log`, and a recording whose index disagrees is refused;
 * a bare stream's index is rebuilt from the stream. The runner finds the
 * quiescent points a range materialisation is bounded at in it (§12).
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

import {
  type BlobRef,
  type BoundaryRecord,
  type CheckpointRow,
  CTBL_MAGIC,
  decodeLog,
  deriveCheckpointIndex,
  encodeLog,
  type RecordOf,
  seqOf,
  toHex,
  verifyCheckpointIndex,
} from "@codetracer/boundary-format";

/** A recording, decoded and with its bodies inline. */
export interface LoadedLog {
  records: BoundaryRecord[];
  header: RecordOf<"Header">;
  env: RecordOf<"Env">;
  /** The log as one `jsbound.log` stream with every body inline. */
  stream: Uint8Array;
  /** `"ct"` for a container, `"log"` for a bare stream. */
  source: "ct" | "log";
  /**
   * The boundary recording's `recording_id` (its `meta.dat`'s, §5.1), for a
   * container; a bare stream has none.
   */
  recordingId?: string;
  /**
   * The checkpoint index (§5.5): a container's `jsbound.chk`, checked against
   * its log; a bare stream's, rebuilt from the stream.
   */
  checkpoints: CheckpointRow[];
  /**
   * The last `seq` the log accounts for: `End.last_seq`, or for a log
   * without an `End` its last seq-bearing record's (or `Gap`'s) seq.
   */
  lastSeq: bigint;
}

/** The last `seq` `records` account for (see {@link LoadedLog.lastSeq}). */
export function lastSeqOf(records: readonly BoundaryRecord[]): bigint {
  let last = 0n;
  for (const r of records) {
    if (r.record === "End") return r.last_seq;
    if (r.record === "Gap") last = r.last_seq;
    const s = seqOf(r);
    if (s !== undefined) last = s;
  }
  return last;
}

/** `meta.dat`'s magic, `"CTMD"`. */
const META_MAGIC = [0x43, 0x54, 0x4d, 0x44];

/**
 * The `recording_id` of a `meta.dat` (codetracer-trace-format-spec
 * `internal-files.md`, "Metadata (meta.dat)"): `"CTMD"`, a `u16` version,
 * `u16` flags and `u32` flags_ext (the 12-byte header of versions 6 and 7),
 * then the id as a LEB128-length-prefixed UTF-8 string, a canonical
 * UUIDv7. Only the id is read, which is why this is not the canonical
 * decoder (`codetracer_trace_writer::meta_dat::decode_meta_dat`, which the
 * native addon does not link): anything it does not expect is refused.
 */
export function metaRecordingId(meta: Uint8Array): string {
  if (meta.length < 12 || !META_MAGIC.every((b, i) => meta[i] === b)) {
    throw new Error("meta.dat does not start with CTMD");
  }
  const version = meta[4] | (meta[5] << 8);
  if (version !== 6 && version !== 7) {
    throw new Error(`meta.dat version ${version} is not read (6 and 7 are)`);
  }
  let at = 12;
  let len = 0;
  for (let shift = 0; ; shift += 7) {
    if (at >= meta.length || shift > 28) {
      throw new Error("meta.dat: the recording_id length is truncated");
    }
    const b = meta[at++];
    len |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
  }
  if (at + len > meta.length) {
    throw new Error("meta.dat: the recording_id is truncated");
  }
  const id = new TextDecoder("utf-8", { fatal: true }).decode(
    meta.subarray(at, at + len),
  );
  if (!isCanonicalUuidV7(id)) {
    throw new Error(
      `meta.dat: recording_id ${JSON.stringify(id)} is not a canonical UUIDv7`,
    );
  }
  return id;
}

/** A lowercase hyphenated UUID with version 7 and the RFC 9562 variant. */
export function isCanonicalUuidV7(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    s,
  );
}

interface CtfsAddon {
  readCtfsMember(container: string, name: string): Buffer;
  listCtfsMembers(container: string): string[];
}

/** The recorder's native addon, which carries the canonical CTFS reader. */
export function addonPath(): string {
  return path.resolve(
    __dirname,
    "..",
    "..",
    "..",
    "crates",
    "recorder_native",
    "index.node",
  );
}

let addon: CtfsAddon | undefined;
function ctfs(): CtfsAddon {
  if (addon !== undefined) return addon;
  const p = addonPath();
  if (!fs.existsSync(p)) {
    throw new Error(
      `the recorder's native addon is not built (${p}): run \`just build-native\``,
    );
  }
  addon = createRequire(__filename)(p) as CtfsAddon;
  return addon;
}

/** The members of a CTFS container, through the canonical reader. */
export function readCtfsMember(container: string, name: string): Uint8Array {
  return new Uint8Array(ctfs().readCtfsMember(container, name));
}

/** Whether `bytes` start like a `jsbound.log` stream. */
export function isBareLog(bytes: Uint8Array): boolean {
  if (bytes.length < CTBL_MAGIC.length) return false;
  return CTBL_MAGIC.every((b, i) => bytes[i] === b);
}

/** The bodies of `jsbound.blb` (§5.4), by lowercase hex SHA-256. */
export function parseBlobStore(bytes: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  while (at < bytes.length) {
    if (bytes.length - at < 40) {
      throw new Error(`jsbound.blb is truncated in a record header at ${at}`);
    }
    const hash = toHex(bytes.subarray(at, at + 32));
    const len = view.getBigUint64(at + 32, true);
    at += 40;
    if (BigInt(bytes.length - at) < len) {
      throw new Error(`jsbound.blb is truncated in the body of ${hash}`);
    }
    const body = bytes.subarray(at, at + Number(len));
    at += Number(len);
    const actual = createHash("sha256").update(body).digest("hex");
    if (actual !== hash) {
      throw new Error(`jsbound.blb body ${hash} hashes to ${actual}`);
    }
    out.set(hash, body);
  }
  return out;
}

function inlineBlob(blob: BlobRef, store: Map<string, Uint8Array>): BlobRef {
  if (blob.kind === "inline") return blob;
  const hash = toHex(blob.sha256);
  const body = store.get(hash);
  if (body === undefined || BigInt(body.length) !== blob.len) {
    throw new Error(
      `jsbound.log references body ${hash}, absent from jsbound.blb`,
    );
  }
  return { kind: "inline", bytes: body };
}

/** `records` with every `jsbound.blb` reference replaced by its body. */
export function resolveBlobs(
  records: BoundaryRecord[],
  store: Map<string, Uint8Array>,
): BoundaryRecord[] {
  return records.map((r) => {
    if (r.record === "NetResponse")
      return { ...r, body: inlineBlob(r.body, store) };
    if (r.record === "WsMessage")
      return { ...r, data: inlineBlob(r.data, store) };
    return r;
  });
}

/** Load the recording at `file` (a `.ct` container or a bare stream). */
export function loadBoundaryLog(file: string): LoadedLog {
  const raw = fs.readFileSync(file);
  let records: BoundaryRecord[];
  let source: "ct" | "log";
  let recordingId: string | undefined;
  let checkpoints: CheckpointRow[];
  if (isBareLog(raw)) {
    const decoded = decodeLog(new Uint8Array(raw), { inlineBodies: "batch" });
    records = decoded.records;
    checkpoints = deriveCheckpointIndex(decoded);
    source = "log";
  } else {
    const log = readCtfsMember(file, "jsbound.log");
    const members = ctfs().listCtfsMembers(file);
    const store = members.includes("jsbound.blb")
      ? parseBlobStore(readCtfsMember(file, "jsbound.blb"))
      : new Map<string, Uint8Array>();
    const decoded = decodeLog(log);
    // A boundary recording has all four members (CTFS-Binary-Format.md
    // §4.8); an index that is missing or disagrees with the log is refused
    // (§5.5), never rebuilt in its place.
    if (!members.includes("jsbound.chk")) {
      throw new Error(`${file}: the container has no jsbound.chk member`);
    }
    checkpoints = verifyCheckpointIndex(
      decoded,
      readCtfsMember(file, "jsbound.chk"),
    );
    records = resolveBlobs(decoded.records, store);
    source = "ct";
    recordingId = metaRecordingId(readCtfsMember(file, "meta.dat"));
  }
  const header = records[0];
  const env = records[1];
  if (header?.record !== "Header" || env?.record !== "Env") {
    throw new Error(`${file}: the log does not start with Header and Env`);
  }
  return {
    records,
    header,
    env,
    stream: encodeLog(records),
    source,
    recordingId,
    checkpoints,
    lastSeq: lastSeqOf(records),
  };
}

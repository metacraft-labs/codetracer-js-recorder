/**
 * `@codetracer/boundary-format` against the shared byte vectors that the
 * Rust implementation (codetracer `libs/jsbound`) writes and is tested
 * against. The vectors are vendored in `tests/boundary/vectors/` by
 * `scripts/vendor-jsbound-vectors.sh`; this file reads them as committed.
 *
 * No mocks: the real decoder and encoder run over the real vector bytes.
 *
 * The expectations are the Rust side's (written from the records each
 * vector was built from), so this decoder agreeing with them is a
 * cross-implementation check, and this encoder is checked by encoding the
 * EXPECTED records (parsed from JSON), not the ones this decoder produced.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  BatchFormatError,
  BoundaryFormatError,
  DECODE_ERROR_CODES,
  ENUM_VALUE_SETS,
  HOLE_TOKEN,
  RECORD_SCHEMA,
  type BoundaryRecord,
  type Json,
  decodeLog,
  encodeBatch,
  encodeFrame,
  encodeLog,
  parseBatch,
  recordFromJson,
  recordToJson,
} from "../../packages/boundary-format/src/index.js";

const VECTORS = join(dirname(fileURLToPath(import.meta.url)), "vectors");

interface ManifestEntry {
  name: string;
  class: "valid" | "truncation" | "refusal";
  bytes: string;
  expected: string;
  base?: string;
}

interface Vector extends ManifestEntry {
  data: Uint8Array;
  want: { termination?: string; records?: Json[]; error?: string };
}

function loadVectors(): Vector[] {
  const manifest = JSON.parse(
    readFileSync(join(VECTORS, "manifest.json"), "utf8"),
  ) as { vectors: ManifestEntry[] };
  return manifest.vectors.map((entry) => ({
    ...entry,
    data: new Uint8Array(readFileSync(join(VECTORS, entry.bytes))),
    want: JSON.parse(readFileSync(join(VECTORS, entry.expected), "utf8")),
  }));
}

/** JSON with every object's keys sorted, for comparing values. */
function canonicalJson(v: unknown): string {
  const sort = (x: unknown): unknown =>
    Array.isArray(x)
      ? x.map(sort)
      : x !== null && typeof x === "object"
        ? Object.fromEntries(
            Object.keys(x)
              .sort()
              .map((k) => [k, sort((x as Record<string, unknown>)[k])]),
          )
        : x;
  return JSON.stringify(sort(v));
}

/** What decoding `v` gives, as the expectation files spell it. */
function observe(data: Uint8Array): Vector["want"] {
  try {
    const log = decodeLog(data);
    return {
      termination: log.termination,
      records: log.records.map(recordToJson),
    };
  } catch (e) {
    if (e instanceof BoundaryFormatError) return { error: e.code };
    throw e;
  }
}

describe("@codetracer/boundary-format", () => {
  it("jsbound_ts_codec_agrees_with_rust_vectors", () => {
    const vectors = loadVectors();
    const failures: string[] = [];
    const kindsSeen = new Set<string>();
    const errorsSeen = new Set<string>();

    for (const v of vectors) {
      const got = observe(v.data);
      try {
        expect(got).toEqual(v.want);
      } catch {
        failures.push(
          `${v.name}: decodes to ${JSON.stringify(got)}, expected ${JSON.stringify(v.want)}`,
        );
        continue;
      }
      if (v.class === "refusal") {
        errorsSeen.add(v.want.error!);
        // Negative control: the base, without the one edit, decodes.
        const base = vectors.find((b) => b.name === v.base);
        if (
          base === undefined ||
          observe(base.data).termination !== "Complete"
        ) {
          failures.push(
            `${v.name}: its base ${v.base} does not decode cleanly`,
          );
        }
        continue;
      }
      // The encoder, from the Rust side's expected records.
      const records = v.want.records!.map(recordFromJson);
      records.forEach((r) => kindsSeen.add(r.record));
      const encoded = encodeLog(records);
      const want =
        v.want.termination === "TruncatedMidRecord"
          ? v.data.subarray(0, encoded.length)
          : v.data;
      if (Buffer.compare(Buffer.from(encoded), Buffer.from(want)) !== 0) {
        failures.push(
          `${v.name}: encoding the expected records does not reproduce the vector`,
        );
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);

    // Vacuity guards: every record kind, every refusal and both truncation
    // classes were exercised, by a vector set of a plausible size.
    expect(new Set(vectors.map((v) => v.class))).toEqual(
      new Set(["valid", "truncation", "refusal"]),
    );
    expect(
      vectors.filter((v) => v.class === "valid").length,
    ).toBeGreaterThanOrEqual(RECORD_SCHEMA.length);
    expect([...kindsSeen].sort()).toEqual(
      RECORD_SCHEMA.map((d) => d.name).sort(),
    );
    expect([...errorsSeen].sort()).toEqual([...DECODE_ERROR_CODES].sort());
    expect(
      new Set(
        vectors
          .filter((v) => v.class === "truncation")
          .map((v) => v.want.termination),
      ),
    ).toEqual(new Set(["TruncatedUnterminated", "TruncatedMidRecord"]));
  });

  it("jsbound_declassify_vectors_decode_identically", () => {
    // The sensitive-input additions (spec §5.2 `Declassify`, §5.2.1 the
    // hole token, reserved tag 0x55), against the vectors the Rust side
    // wrote and decodes in its own half of this test
    // (`libs/jsbound/tests/vectors.rs`). Both decoders are compared with the
    // same committed expectation files, so agreeing with them is agreeing
    // with each other.
    const vectors = loadVectors();
    // Vacuity guard, before anything is decoded: by the `record` names of
    // the expectation files, the valid vectors carry every record kind of
    // the schema, `Declassify` included.
    const kinds = new Set(
      vectors
        .filter((v) => v.class === "valid")
        .flatMap((v) => v.want.records ?? [])
        .map((r) => (r as { record: string }).record),
    );
    for (const d of RECORD_SCHEMA) expect(kinds, d.name).toContain(d.name);
    expect(RECORD_SCHEMA.find((d) => d.tag === 0x54)?.name).toBe("Declassify");
    expect(RECORD_SCHEMA.some((d) => (d.tag as number) === 0x55)).toBe(false);

    const byName = (name: string): Vector => {
      const v = vectors.find((x) => x.name === name);
      expect(v, name).toBeDefined();
      return v!;
    };
    for (const name of [
      "declassify",
      "net_request_holed",
      "sensitive_session",
    ]) {
      const v = byName(name);
      expect(v.class).toBe("valid");
      // The decoder gives the Rust side's canonical JSON ...
      expect(observe(v.data), name).toEqual(v.want);
      // ... and the encoder, given the Rust side's records, its bytes.
      const encoded = encodeLog(v.want.records!.map(recordFromJson));
      expect(
        Buffer.compare(Buffer.from(encoded), Buffer.from(v.data)),
        `${name}: encoding the expected records reproduces the vector`,
      ).toBe(0);
    }
    // The wire order of Declassify: seq, fn_id, output.
    expect([
      ...encodeFrame({
        record: "Declassify",
        seq: 1n,
        fn_id: "f",
        output: "1",
      }),
    ]).toEqual([
      19, 0, 0, 0, 0x54, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0x66, 1, 0, 0, 0,
      0x31,
    ]);
    // The holed request carries the 13-byte token, and its digest is over
    // the holed body.
    expect([...new TextEncoder().encode(HOLE_TOKEN)]).toEqual([
      0xef, 0xb7, 0x90, 0x63, 0x74, 0x3a, 0x68, 0x6f, 0x6c, 0x65, 0xef, 0xb7,
      0x91,
    ]);
    const holed = decodeLog(byName("net_request_holed").data).records[2];
    expect(holed.record).toBe("NetRequest");
    if (holed.record !== "NetRequest") return;
    expect(holed.url).toContain(HOLE_TOKEN);
    expect(holed.body_digest).toBe(
      createHash("sha256")
        .update(`{"user":"ada","pass":"${HOLE_TOKEN}"}`)
        .digest("hex"),
    );
    // 0x55 is refused as UnknownTag, one byte from the Declassify vector,
    // which decodes (the negative control).
    const reserved = byName("reserved_tag_0x55");
    expect(reserved.base).toBe("declassify");
    expect(observe(reserved.data)).toEqual({ error: "UnknownTag" });
    const base = byName("declassify").data;
    expect(base.length).toBe(reserved.data.length);
    expect(base.filter((b, i) => b !== reserved.data[i]).length).toBe(1);
    expect(observe(base).termination).toBe("Complete");
  });

  it("every u8 field has exactly one value set", () => {
    // A field added to the schema without a value set, or a stale entry,
    // fails here rather than in the decoder.
    const u8Fields = RECORD_SCHEMA.flatMap((d) =>
      d.fields
        .filter(([, type]) => type === "u8")
        .map(([name]) => `${d.name}.${name}`),
    ).sort();
    const sets = Object.entries(ENUM_VALUE_SETS)
      .flatMap(([record, fields]) =>
        Object.keys(fields).map((f) => `${record}.${f}`),
      )
      .sort();
    expect(sets).toEqual(u8Fields);
    expect(u8Fields).toHaveLength(27);
    // The shared vectors step past both ends of every set: the refusal
    // vectors name each field.
    const refusals = loadVectors()
      .filter((v) => v.want.error === "UnknownEnumValue")
      .map((v) => v.name);
    for (const [record, fields] of Object.entries(ENUM_VALUE_SETS)) {
      const snake = record.replace(/(?<!^)([A-Z])/g, "_$1").toLowerCase();
      for (const [field, [lo, hi]] of Object.entries(fields)) {
        expect(refusals).toContain(`enum_${snake}_${field}_${hi + 1}`);
        if (lo > 0) {
          expect(refusals).toContain(`enum_${snake}_${field}_${lo - 1}`);
        }
      }
    }
  });

  it("the vendored vectors match their SHA256SUMS", () => {
    const sums = readFileSync(join(VECTORS, "SHA256SUMS"), "utf8")
      .trimEnd()
      .split("\n");
    const listed = new Set<string>();
    for (const line of sums) {
      const [hash, name] = line.split("  ");
      const actual = createHash("sha256")
        .update(readFileSync(join(VECTORS, name)))
        .digest("hex");
      expect(actual, name).toBe(hash);
      listed.add(name);
    }
    for (const name of readdirSync(VECTORS)) {
      if (name !== "SHA256SUMS") expect(listed.has(name), name).toBe(true);
    }
    expect(listed.size).toBeGreaterThan(40);
  });

  it("every cut of the session vector is classified, never complete", () => {
    const session = loadVectors().find((v) => v.name === "session")!;
    const full = decodeLog(session.data);
    expect(full.termination).toBe("Complete");
    const boundaries = new Set([5, ...full.offsets.slice(1)]);
    let unterminated = 0;
    for (let cut = 0; cut < session.data.length; cut++) {
      const log = decodeLog(session.data.subarray(0, cut));
      expect(log.termination, `cut ${cut}`).not.toBe("Complete");
      expect(log.termination === "TruncatedUnterminated", `cut ${cut}`).toBe(
        boundaries.has(cut),
      );
      if (log.termination === "TruncatedUnterminated") unterminated++;
    }
    expect(unterminated).toBe(full.records.length);
  });

  it("jsbound_ts_batch_codec_agrees_with_rust_vectors", () => {
    // The batch vectors (`batches.json`): uploaded batch bodies the Rust
    // `parse_batch` is held to, with expectations written from what each
    // was built from. Valid ones must parse to the same envelope and
    // records and, when canonical, `encodeBatch` must give the bytes back;
    // refusals must be refused with the same error name.
    const manifest = JSON.parse(
      readFileSync(join(VECTORS, "batches.json"), "utf8"),
    ) as { vectors: ManifestEntry[] };
    const failures: string[] = [];
    const errorsSeen = new Set<string>();
    let valid = 0;
    let nonCanonical = 0;
    for (const v of manifest.vectors) {
      const bytes = new Uint8Array(readFileSync(join(VECTORS, v.bytes)));
      const want = JSON.parse(
        readFileSync(join(VECTORS, v.expected), "utf8"),
      ) as {
        envelope?: Json;
        records?: Json[];
        canonical?: boolean;
        error?: string;
      };
      let got;
      try {
        got = parseBatch(bytes);
      } catch (e) {
        if (!(e instanceof BatchFormatError)) throw e;
        if (v.class !== "refusal")
          failures.push(`${v.name}: refused: ${e.message}`);
        else if (e.code !== want.error)
          failures.push(
            `${v.name}: refused with ${e.code}, expected ${want.error}`,
          );
        else errorsSeen.add(e.code);
        continue;
      }
      if (v.class === "refusal") {
        failures.push(`${v.name}: parses, expected ${want.error}`);
        continue;
      }
      valid += 1;
      const envelope = canonicalJson(got.envelope);
      if (envelope !== canonicalJson(want.envelope)) {
        failures.push(
          `${v.name}: envelope ${envelope}, expected ${canonicalJson(want.envelope)}`,
        );
      }
      const records = canonicalJson(got.records.map(recordToJson));
      if (records !== canonicalJson(want.records)) {
        failures.push(`${v.name}: records ${records}`);
      }
      const same =
        Buffer.compare(
          Buffer.from(encodeBatch(got.envelope, got.frames)),
          Buffer.from(bytes),
        ) === 0;
      if (same !== want.canonical) {
        failures.push(
          `${v.name}: encodeBatch ${same ? "gives" : "does not give"} the bytes back, canonical is ${want.canonical}`,
        );
      }
      if (!want.canonical) nonCanonical += 1;
    }
    expect(failures).toEqual([]);
    // Vacuity guard: the set is the batch vector set, not a stub of it.
    expect(valid).toBeGreaterThanOrEqual(4);
    expect(nonCanonical).toBeGreaterThanOrEqual(1);
    expect([...errorsSeen].sort()).toEqual([
      "BadEnvelope",
      "BadMagic",
      "EnvelopeTooLarge",
      "Frame",
      "Truncated",
      "UnsupportedVersion",
    ]);
  });

  it("the encoder refuses values that do not fit their wire type", () => {
    const clock = (over: Partial<Record<string, unknown>>) =>
      ({
        record: "Clock",
        seq: 1n,
        src: 1,
        bits: 0n,
        ...over,
      }) as BoundaryRecord;
    expect(() => encodeFrame(clock({}))).not.toThrow();
    expect(() => encodeFrame(clock({ src: 256 }))).toThrow(RangeError);
    expect(() => encodeFrame(clock({ src: 1.5 }))).toThrow(RangeError);
    expect(() => encodeFrame(clock({ seq: 1 }))).toThrow(RangeError);
    expect(() => encodeFrame(clock({ bits: 1n << 64n }))).toThrow(RangeError);
    expect(() =>
      encodeFrame({
        record: "WsMessage",
        seq: 1n,
        req_id: 1n,
        dir: 1,
        frame: 0,
        event: "",
        last_event_id: "",
        data: { kind: "ref", sha256: new Uint8Array(31), len: 1n },
      }),
    ).toThrow(TypeError);
  });
});

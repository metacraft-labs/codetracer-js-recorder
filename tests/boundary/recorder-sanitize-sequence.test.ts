/**
 * Actual Recorder/strict codec, with a public observing sink or real in-memory
 * stream. The sink collects delivered bytes and metadata, not HTTP acceptance.
 * Bounded ordinary nested writes occur only after the real Header/Env startup.
 */
import { describe, expect, it } from "vitest";
import {
  decodeLog,
  streamPrefix,
  type BoundaryRecord,
} from "../../packages/boundary-format/src/index.js";
import {
  Recorder,
  type RecorderOptions,
} from "../../packages/boundary-shim/src/browser/recorder.js";

const header = {
  vocab: 1,
  protocol_level: 1,
  recorder_id: "test",
  framework: "test/1",
  build_hash: "0".repeat(64),
  session_id: "1".repeat(32),
  prev_session: "",
  capabilities: "[]",
};
const env = {
  ua: "test",
  ua_major: 1,
  viewport_w: 1,
  viewport_h: 1,
  dpr: 1,
  locale: "en",
  tz: "UTC",
  fonts_digest: "",
  color_scheme: 1,
  reduced_motion: 1,
  arms: "{}",
  url: "http://localhost/",
  referrer_origin: "",
  traceparent: "",
};

function session(
  external: boolean,
  sanitize: (r: BoundaryRecord, recorder: Recorder) => BoundaryRecord,
) {
  const frames: Uint8Array[] = [];
  const metadata: (bigint | undefined)[] = [];
  const calls: string[] = [];
  let recorder: Recorder;
  const options: RecorderOptions = {
    checkpointScheme: "test-state-v1",
    checkpointHash: () => "0".repeat(64),
    sanitize(record) {
      calls.push(record.record);
      return sanitize(record, recorder);
    },
    sink: external
      ? {
          append(frame, seq) {
            frames.push(frame);
            metadata.push(seq);
          },
          end(_unloading, frame) {
            frames.push(frame);
            metadata.push(undefined);
          },
          halt() {},
        }
      : undefined,
  };
  recorder = new Recorder(options);
  recorder.start(header, env);
  const records = () => {
    const decoded = decodeLog(
      external ? Buffer.concat([streamPrefix(), ...frames]) : recorder.log(),
    ).records;
    if (external)
      expect(metadata).toEqual(
        decoded.map((r) => ("seq" in r ? r.seq : undefined)),
      );
    return decoded;
  };
  return { recorder, calls, records };
}

describe("Recorder sanitizer nested sequence ownership", () => {
  for (const external of [true, false]) {
    for (const count of [0, 1, 3]) {
      it(`orders ${count} nested ordinary writes before Clock with matching metadata (sink=${external})`, () => {
        let returned: BoundaryRecord | undefined;
        const s = session(external, (record, recorder) => {
          if (record.record !== "Clock") return record;
          for (let i = 0; i < count; i++)
            recorder.emit("Refusal", {
              feature: `nested-${i}`,
              detail: "original",
            });
          returned = Object.freeze({ ...record, bits: 7n });
          return returned;
        });
        s.recorder.emit("Clock", { src: 1, bits: 0n });
        s.recorder.end(2);
        const records = s.records();
        expect(records.map((r) => r.record)).toEqual([
          "Header",
          "Env",
          ...Array(count).fill("Refusal"),
          "Clock",
          "Checkpoint",
          "End",
        ]);
        expect(
          records.filter((r) => r.record === "Refusal").map((r) => r.seq),
        ).toEqual(Array.from({ length: count }, (_, i) => BigInt(i + 1)));
        expect(records.find((r) => r.record === "Clock")).toEqual({
          record: "Clock",
          seq: BigInt(count + 1),
          src: 1,
          bits: 7n,
        });
        expect(records.at(-1)).toEqual({
          record: "End",
          last_seq: BigInt(count + 2),
          reason: 2,
        });
        expect(returned).toMatchObject({ seq: 1n, bits: 7n });
        expect(s.calls.filter((k) => k === "Clock")).toHaveLength(1);
        expect(s.calls.filter((k) => k === "Refusal")).toHaveLength(count);
      });
    }
    for (const stage of ["Checkpoint", "End"] as const) {
      it(`${stage} includes nested ordinary writes and preserves immutable transforms (sink=${external})`, () => {
        let fired = false;
        let returned: BoundaryRecord | undefined;
        const s = session(external, (record, recorder) => {
          if (record.record !== stage || fired) return record;
          fired = true;
          recorder.emit("Refusal", { feature: "nested", detail: "safe" });
          returned = Object.freeze(
            record.record === "End"
              ? { ...record, reason: 3 }
              : { ...record, scheme: "scrubbed-v1" },
          );
          return returned;
        });
        s.recorder.emit("Clock", { src: 1, bits: 0n });
        s.recorder.end(2);
        const records = s.records();
        expect(records.at(-1)).toEqual({
          record: "End",
          last_seq: 3n,
          reason: stage === "End" ? 3 : 2,
        });
        expect(records.find((r) => r.record === "Checkpoint")).toMatchObject({
          seq: stage === "Checkpoint" ? 3n : 2n,
          scheme: stage === "Checkpoint" ? "scrubbed-v1" : "test-state-v1",
        });
        expect(records.find((r) => r.record === "Refusal")).toMatchObject({
          seq: stage === "Checkpoint" ? 2n : 3n,
          feature: "nested",
        });
        expect(returned).toMatchObject(
          stage === "End" ? { last_seq: 2n } : { seq: 2n },
        );
        expect(s.calls.filter((k) => k === stage)).toHaveLength(1);
      });
    }
    it(`orders bounded recursive ordinary sanitizers once each (sink=${external})`, () => {
      let count = 0;
      const s = session(external, (record, recorder) => {
        if (
          record.record === "Clock" ||
          (record.record === "Refusal" && count < 2)
        ) {
          count++;
          recorder.emit("Refusal", {
            feature: `nested-${count}`,
            detail: "original",
          });
        }
        return record.record === "Refusal"
          ? Object.freeze({ ...record, detail: "scrubbed" })
          : record;
      });
      s.recorder.emit("Clock", { src: 1, bits: 0n });
      s.recorder.end(2);
      expect(s.records().filter((r) => r.record === "Refusal")).toEqual([
        { record: "Refusal", seq: 1n, feature: "nested-2", detail: "scrubbed" },
        { record: "Refusal", seq: 2n, feature: "nested-1", detail: "scrubbed" },
      ]);
      expect(s.calls.filter((k) => k === "Clock")).toHaveLength(1);
      expect(s.calls.filter((k) => k === "Refusal")).toHaveLength(2);
    });
    it(`rejects invalid outer encoding after nested acceptance without a sequence hole (sink=${external})`, () => {
      const s = session(external, (record, recorder) => {
        if (record.record !== "Clock") return record;
        recorder.emit("Refusal", { feature: "nested", detail: "safe" });
        return {
          ...record,
          record: "invalid-control",
        } as unknown as BoundaryRecord;
      });
      s.recorder.guard(() => s.recorder.emit("Clock", { src: 1, bits: 0n }));
      expect(s.records().map((r) => r.record)).toEqual([
        "Header",
        "Env",
        "Refusal",
        "Refusal",
      ]);
      expect(s.records().at(-1)).toMatchObject({
        seq: 2n,
        feature: "recorder-fault",
        detail: "TypeError: unknown record kind invalid-control",
      });
      expect(s.calls.filter((k) => k === "Refusal")).toHaveLength(1);
      expect(s.recorder.recording).toBe(false);
    });
    for (const action of ["halt", "fault", "throw"] as const) {
      it(`preserves accepted nested bytes when outer sanitizer ${action}s (sink=${external})`, () => {
        const s = session(external, (record, recorder) => {
          if (record.record !== "Clock") return record;
          recorder.emit("Refusal", { feature: "nested", detail: "safe" });
          if (action === "halt") recorder.halt();
          else if (action === "fault")
            recorder.fault(new Error("nested control"));
          else throw new Error("nested control");
          return record;
        });
        s.recorder.guard(() => s.recorder.emit("Clock", { src: 1, bits: 0n }));
        expect(s.records().map((r) => r.record)).toEqual([
          "Header",
          "Env",
          "Refusal",
          ...(action === "halt" ? [] : ["Refusal"]),
        ]);
        expect(s.records()[2]).toMatchObject({ seq: 1n, feature: "nested" });
        if (action !== "halt")
          expect(s.records().at(-1)).toMatchObject({
            seq: 2n,
            feature: "recorder-fault",
          });
        const snapshot = [...s.calls];
        s.recorder.emit("Refusal", { feature: "late", detail: "" });
        s.recorder.end(2);
        expect(s.calls).toEqual(snapshot);
        expect(s.recorder.recording).toBe(false);
      });
    }
    it(`keeps recorder metadata authoritative over sanitizer metadata (sink=${external})`, () => {
      const s = session(external, (record) =>
        Object.freeze(
          record.record === "End"
            ? { ...record, last_seq: 99n }
            : "seq" in record
              ? { ...record, seq: 99n }
              : record,
        ),
      );
      s.recorder.emit("Clock", { src: 1, bits: 0n });
      s.recorder.end(2);
      expect(s.records().at(-1)).toEqual({
        record: "End",
        last_seq: 2n,
        reason: 2,
      });
      expect(s.records().find((r) => r.record === "Clock")).toMatchObject({
        seq: 1n,
      });
    });
  }
});

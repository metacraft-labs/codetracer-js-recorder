/**
 * Real Recorder and strict codec. The public collecting FrameSink only observes
 * callback delivery and bytes; it does not model HTTP acceptance or completion.
 * Sanitizers are actual public callbacks, not replacement encoders or recorders.
 */
import { describe, expect, it } from "vitest";
import {
  decodeLog,
  streamPrefix,
  type BoundaryRecord,
} from "../../packages/boundary-format/src/index.js";
import { Recorder } from "../../packages/boundary-shim/src/browser/recorder.js";

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
  stage: string,
  action: "halt" | "fault" | "throw" | "identity" | "change",
  external: boolean,
) {
  const frames: Uint8Array[] = [];
  const calls: string[] = [];
  let recorder: Recorder;
  recorder = new Recorder({
    checkpointScheme: "test-state-v1",
    checkpointHash() {
      calls.push("hash");
      return "0".repeat(64);
    },
    checkpointDomDigest() {
      calls.push("dom");
      return "1".repeat(64);
    },
    sanitize(record) {
      calls.push(`sanitize:${record.record}`);
      if (record.record === stage) {
        if (action === "halt") recorder.halt();
        if (action === "fault") recorder.fault(new Error("sanitize control"));
        if (action === "throw") throw new Error("sanitize control");
        if (action === "change" && record.record === "Clock")
          return { ...record, bits: 1n };
      }
      return record;
    },
    sink: external
      ? {
          append(frame) {
            calls.push("append");
            frames.push(frame);
          },
          end(_unloading, frame) {
            calls.push("end");
            frames.push(frame);
          },
          halt() {
            calls.push("halt");
          },
        }
      : undefined,
  });
  const records = () =>
    decodeLog(
      external ? Buffer.concat([streamPrefix(), ...frames]) : recorder.log(),
    ).records;
  const frameCount = () =>
    external ? frames.length : recorder.frameList.length;
  return {
    recorder,
    calls,
    records,
    frameCount,
    start: () => recorder.start(header, env),
  };
}

describe("Recorder sanitizer terminal boundaries", () => {
  for (const external of [true, false]) {
    it.each(["identity", "change"] as const)(
      `keeps valid sanitizer output (sink=${external}, %s)`,
      (action) => {
        const s = session("Clock", action, external);
        s.start();
        s.recorder.emit("Clock", { src: 1, bits: 0n });
        s.recorder.end(2);
        expect(s.records().map((r) => r.record)).toEqual([
          "Header",
          "Env",
          "Clock",
          "Checkpoint",
          "End",
        ]);
        expect(s.records()[2]).toEqual({
          record: "Clock",
          seq: 1n,
          src: 1,
          bits: action === "change" ? 1n : 0n,
        });
        expect(s.records().at(-1)).toEqual({
          record: "End",
          last_seq: 2n,
          reason: 2,
        });
      },
    );
    for (const stage of ["Header", "Env", "Clock", "Checkpoint", "End"]) {
      it.each(["halt", "fault", "throw"] as const)(
        `${stage} sanitizer %s prevents stale delivery (sink=${external})`,
        (action) => {
          const s = session(stage, action, external);
          s.start();
          if (s.recorder.recording && stage !== "End")
            s.recorder.guard(() =>
              s.recorder.emit("Clock", { src: 1, bits: 0n }),
            );
          s.recorder.end(2);
          expect(s.recorder.recording).toBe(false);
          expect(s.calls.filter((c) => c === "hash" || c === "dom")).toEqual(
            stage === "Checkpoint" ? ["hash", "dom"] : [],
          );
          expect(s.calls.filter((c) => c === "end")).toEqual([]);
          expect(s.calls.filter((c) => c === "sanitize:Refusal")).toEqual([]);
          expect(s.calls.filter((c) => c === "halt")).toHaveLength(
            external && action !== "halt" ? 1 : 0,
          );
          const before: BoundaryRecord["record"][] =
            stage === "Header"
              ? []
              : stage === "Env"
                ? ["Header"]
                : stage === "Clock" || stage === "End"
                  ? ["Header", "Env"]
                  : ["Header", "Env", "Clock"];
          const expected = [
            ...before,
            ...(action === "halt" ? [] : ["Refusal"]),
          ];
          expect(s.frameCount()).toBe(expected.length);
          if (stage !== "Header" && stage !== "Env") {
            expect(s.records().map((r) => r.record)).toEqual(expected);
            if (action !== "halt")
              expect(s.records().at(-1)).toMatchObject({
                record: "Refusal",
                feature: "recorder-fault",
                seq: stage === "Checkpoint" ? 2n : 1n,
              });
          }
          // Missing Header/Env is a truncated startup, never claimed as valid completion.
          if (stage === "Env" && action !== "halt")
            expect(s.records).toThrow(/EnvNotSecond/);
          const snapshot = [...s.calls];
          s.recorder.start(header, env);
          s.recorder.checkpoint();
          s.recorder.end(2);
          s.recorder.emit("Clock", { src: 1, bits: 0n });
          expect(s.calls).toEqual(snapshot);
          const state = s.recorder as unknown as {
            checkpointOrdinal: number;
            recordsSinceCheckpoint: number;
            wallNow?: number;
          };
          expect(state.checkpointOrdinal).toBe(0);
          expect(state.recordsSinceCheckpoint).toBe(
            stage === "Checkpoint" ? 1 : 0,
          );
          expect(state.wallNow).toBe(stage === "Checkpoint" ? 0 : undefined);
        },
      );
    }
  }
  for (const stage of ["Clock", "End"] as const) {
    it.each([true, false])(
      `${stage} invalid sanitizer replacement faults without a sequence hole (sink=%s)`,
      (external) => {
        const frames: Uint8Array[] = [];
        const recorder = new Recorder({
          checkpointScheme: "dom-v1",
          checkpointHash: () => "0".repeat(64),
          sanitize(record) {
            return record.record === stage
              ? ({
                  ...record,
                  record: "invalid-control",
                } as unknown as BoundaryRecord)
              : record;
          },
          sink: external
            ? {
                append(frame) {
                  frames.push(frame);
                },
                end(_unloading, frame) {
                  frames.push(frame);
                },
                halt() {},
              }
            : undefined,
        });
        recorder.start(header, env);
        if (stage === "Clock")
          recorder.guard(() => recorder.emit("Clock", { src: 1, bits: 0n }));
        else recorder.end(2);
        const records = decodeLog(
          external
            ? Buffer.concat([streamPrefix(), ...frames])
            : recorder.log(),
        ).records;
        expect(records.map((r) => r.record)).toEqual([
          "Header",
          "Env",
          "Refusal",
        ]);
        expect(records.at(-1)).toMatchObject({
          seq: 1n,
          feature: "recorder-fault",
          detail: "TypeError: unknown record kind invalid-control",
        });
        expect(recorder.recording).toBe(false);
      },
    );
  }
  it("bypasses a throwing sanitizer for the private fault Refusal only", () => {
    let armed = false;
    const calls: string[] = [];
    const recorder = new Recorder({
      checkpointScheme: "dom-v1",
      checkpointHash: () => "0".repeat(64),
      sanitize(record) {
        calls.push(record.record);
        if (armed) throw new Error("sanitize control");
        return record;
      },
    });
    recorder.start(header, env);
    armed = true;
    recorder.guard(() => recorder.emit("Clock", { src: 1, bits: 0n }));
    expect(calls).toEqual(["Header", "Env", "Clock"]);
    expect(decodeLog(recorder.log()).records.at(-1)).toMatchObject({
      record: "Refusal",
      seq: 1n,
      feature: "recorder-fault",
    });
  });
  it("still sanitizes an ordinary public Refusal", () => {
    const calls: string[] = [];
    const recorder = new Recorder({
      checkpointScheme: "dom-v1",
      checkpointHash: () => "0".repeat(64),
      sanitize(record) {
        calls.push(record.record);
        return record.record === "Refusal"
          ? { ...record, detail: "scrubbed" }
          : record;
      },
    });
    recorder.start(header, env);
    recorder.emit("Refusal", { feature: "test", detail: "original" });
    expect(calls).toEqual(["Header", "Env", "Refusal"]);
    expect(decodeLog(recorder.log()).records.at(-1)).toMatchObject({
      detail: "scrubbed",
    });
  });
  it("retains the real injected encoder failure on the private fault path", () => {
    const s = session("none", "identity", true);
    s.start();
    s.recorder.injectEncoderFault();
    s.recorder.fault(new Error("fault control"));
    expect(s.records().map((r) => r.record)).toEqual(["Header", "Env"]);
    expect(s.calls.filter((c) => c === "halt")).toHaveLength(1);
    expect(s.calls).not.toContain("sanitize:Refusal");
  });
});

/**
 * Real Recorder and strict wire decoder. The collecting FrameSink observes the
 * public callback/encoded-frame contract; it does not stand in for HTTP upload.
 * No clock, encoder, provider dispatcher or recorder is replaced.
 */
import { describe, expect, it } from "vitest";
import {
  decodeLog,
  streamPrefix,
} from "../../packages/boundary-format/src/index.js";
import {
  Recorder,
  type FrameSink,
} from "../../packages/boundary-shim/src/browser/recorder.js";

function session(
  stage: "hash" | "dom" | "sink" | "none",
  action: "halt" | "fault" | "throw" = "halt",
  external = true,
) {
  const calls: string[] = [];
  const frames: Uint8Array[] = [];
  let recorder: Recorder;
  const invalidate = () => {
    if (action === "halt") recorder.halt();
    else if (action === "fault") recorder.fault(new Error("provider control"));
    else throw new Error("provider control");
  };
  const sink: FrameSink = {
    append(frame) {
      if (
        stage === "sink" &&
        calls.includes("dom") &&
        !calls.includes("sink")
      ) {
        calls.push("sink");
        if (action !== "throw") {
          frames.push(frame);
          invalidate();
          return;
        }
        throw new Error("sink control");
      }
      frames.push(frame);
    },
    end(unloading, frame) {
      calls.push(`end:${unloading}`);
      frames.push(frame);
    },
    halt() {
      calls.push("sink-halt");
    },
  };
  recorder = new Recorder({
    checkpointScheme: "test-state-v1",
    checkpointHash() {
      calls.push("hash");
      if (stage === "hash") invalidate();
      return "0".repeat(64);
    },
    checkpointDomDigest() {
      calls.push("dom");
      if (stage === "dom") invalidate();
      return "1".repeat(64);
    },
    sink: external ? sink : undefined,
  });
  recorder.start(
    {
      vocab: 1,
      protocol_level: 1,
      recorder_id: "test",
      framework: "test/1",
      build_hash: "0".repeat(64),
      session_id: "1".repeat(32),
      prev_session: "",
      capabilities: "[]",
    },
    {
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
    },
  );
  recorder.emit("Clock", { src: 1, bits: 0n });
  const records = () =>
    decodeLog(
      external ? Buffer.concat([streamPrefix(), ...frames]) : recorder.log(),
    ).records;
  return { recorder, calls, records };
}

describe("Recorder checkpoint callback termination", () => {
  it.each([true, false])(
    "keeps ordinary provider order and final encoding (sink=%s)",
    (external) => {
      const { recorder, calls, records } = session("none", "halt", external);
      recorder.end(2, true);
      recorder.end(2);
      expect(calls).toEqual(
        external ? ["hash", "dom", "end:true"] : ["hash", "dom"],
      );
      expect(records()).toEqual(
        expect.arrayContaining([
          {
            record: "Checkpoint",
            seq: 2n,
            ordinal: 0,
            scheme: "test-state-v1",
            state_hash: "0".repeat(64),
            dom_digest: "1".repeat(64),
          },
          { record: "End", last_seq: 2n, reason: 2 },
        ]),
      );
      expect(records().map((r) => r.record)).toEqual([
        "Header",
        "Env",
        "Clock",
        "Checkpoint",
        "End",
      ]);
      expect(recorder.recording).toBe(false);
    },
  );
  for (const stage of ["hash", "dom"] as const) {
    for (const action of ["halt", "fault", "throw"] as const) {
      it.each([true, false])(
        `${stage} ${action} stops checkpoint and End (sink=%s)`,
        (external) => {
          const { recorder, calls, records } = session(stage, action, external);
          recorder.end(2);
          expect(recorder.recording).toBe(false);
          const providers = stage === "hash" ? ["hash"] : ["hash", "dom"];
          expect(calls).toEqual(
            action !== "halt" && external
              ? [...providers, "sink-halt"]
              : providers,
          );
          expect(records().map((r) => r.record)).toEqual(
            action === "halt"
              ? ["Header", "Env", "Clock"]
              : ["Header", "Env", "Clock", "Refusal"],
          );
          if (action !== "halt")
            expect(records().at(-1)).toMatchObject({
              record: "Refusal",
              feature: "recorder-fault",
              seq: 2n,
            });
        },
      );
    }
  }
  it("does not finish after a checkpoint sink faults", () => {
    const { recorder, calls, records } = session("sink", "throw");
    recorder.end(2);
    expect(recorder.recording).toBe(false);
    expect(calls).toEqual(["hash", "dom", "sink", "sink-halt"]);
    expect(records().at(-1)).toMatchObject({
      record: "Refusal",
      feature: "recorder-fault",
      seq: 2n,
    });
    expect(records().some((r) => r.record === "End")).toBe(false);
  });
  it("does not finish or advance checkpoint accounting after the sink halts", () => {
    const { recorder, calls, records } = session("sink", "halt");
    recorder.end(2);
    expect(calls).toEqual(["hash", "dom", "sink"]);
    expect(records().map((r) => r.record)).toEqual([
      "Header",
      "Env",
      "Clock",
      "Checkpoint",
    ]);
    expect(recorder.recording).toBe(false);
    // Internal cadence state must not be committed after session invalidation.
    expect(
      (recorder as unknown as { checkpointOrdinal: number }).checkpointOrdinal,
    ).toBe(0);
    expect(
      (recorder as unknown as { recordsSinceCheckpoint: number })
        .recordsSinceCheckpoint,
    ).toBe(1);
  });
  it("keeps accepted checkpoint and reentrant fault sequences distinct", () => {
    const { recorder, calls, records } = session("sink", "fault");
    recorder.end(2);
    expect(calls).toEqual(["hash", "dom", "sink", "sink-halt"]);
    expect(recorder.recording).toBe(false);
    expect(records().map((r) => r.record)).toEqual([
      "Header",
      "Env",
      "Clock",
      "Checkpoint",
      "Refusal",
    ]);
    expect(records().at(-1)).toMatchObject({
      record: "Refusal",
      feature: "recorder-fault",
      seq: 3n,
    });
  });
  it("leaves the failed checkpoint seq to the encoder-fault Refusal", () => {
    const { recorder, calls, records } = session("none");
    recorder.injectEncoderFault();
    recorder.end(2);
    expect(calls).toEqual(["hash", "dom", "sink-halt"]);
    expect(records().map((r) => r.record)).toEqual([
      "Header",
      "Env",
      "Clock",
      "Refusal",
    ]);
    expect(records().at(-1)).toMatchObject({
      record: "Refusal",
      feature: "recorder-fault",
      seq: 2n,
    });
    expect(recorder.recording).toBe(false);
  });
});

/** A public sink observer, including partial startup, never a replacement codec. */
function lifecycleSession(
  onAppend?: (recorder: Recorder, count: number) => void,
) {
  const frames: Uint8Array[] = [];
  const calls: string[] = [];
  let recorder: Recorder;
  recorder = new Recorder({
    checkpointScheme: "test-state-v1",
    checkpointHash: () => "0".repeat(64),
    sink: {
      append(frame) {
        frames.push(frame);
        onAppend?.(recorder, frames.length);
      },
      end(_unloading, frame) {
        calls.push("end");
        frames.push(frame);
      },
      halt() {
        calls.push("halt");
      },
    },
  });
  const start = () =>
    recorder.start(
      {
        vocab: 1,
        protocol_level: 1,
        recorder_id: "test",
        framework: "test/1",
        build_hash: "0".repeat(64),
        session_id: "1".repeat(32),
        prev_session: "",
        capabilities: "[]",
      },
      {
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
      },
    );
  const bytes = () => Buffer.concat([streamPrefix(), ...frames]);
  return {
    recorder,
    start,
    frames,
    calls,
    bytes,
    records: () => decodeLog(bytes()).records,
  };
}

describe("Recorder progress and startup invalidation", () => {
  it.each(["ordinary", "loading", "halt", "fault", "loading-halt"] as const)(
    "rechecks recording after progress: %s",
    (action) => {
      let haltOnLoading = false;
      const { recorder, start, records, calls } = lifecycleSession((rec) => {
        if (haltOnLoading) {
          haltOnLoading = false;
          rec.halt();
        }
      });
      start();
      const progressCalls: string[] = [];
      recorder.attachProgress({
        macrotask() {},
        checkpointsAllowed() {
          return true;
        },
        beforeRecord() {
          progressCalls.push("beforeRecord");
          if (action === "halt") recorder.halt();
          if (action === "fault") recorder.fault(new Error("progress control"));
          if (action === "loading" || action === "loading-halt") {
            haltOnLoading = action === "loading-halt";
            recorder.emit("Loading", {
              phase: 1,
              elements: 0,
              scripts: 0,
              text: 0,
            });
          }
        },
      });
      recorder.guard(() => recorder.emit("Clock", { src: 1, bits: 0n }));
      expect(progressCalls).toEqual(["beforeRecord"]);
      const ordinary = action === "ordinary" || action === "loading";
      expect(recorder.recording).toBe(ordinary);
      expect(calls).toEqual(action === "fault" ? ["halt"] : []);
      const tail =
        action === "ordinary"
          ? [{ record: "Clock", seq: 1n, src: 1, bits: 0n }]
          : action === "loading"
            ? [
                {
                  record: "Loading",
                  seq: 1n,
                  phase: 1,
                  elements: 0,
                  scripts: 0,
                  text: 0,
                },
                { record: "Clock", seq: 2n, src: 1, bits: 0n },
              ]
            : action === "loading-halt"
              ? [
                  {
                    record: "Loading",
                    seq: 1n,
                    phase: 1,
                    elements: 0,
                    scripts: 0,
                    text: 0,
                  },
                ]
              : action === "fault"
                ? [
                    {
                      record: "Refusal",
                      seq: 1n,
                      feature: "recorder-fault",
                      detail: "Error: progress control",
                    },
                  ]
                : [];
      expect(records().slice(2)).toEqual(tail);
      expect(
        records()
          .slice(0, 2)
          .map((r) => r.record),
      ).toEqual(["Header", "Env"]);
      if (!ordinary) {
        recorder.end(2);
        recorder.emit("Clock", { src: 1, bits: 0n });
        expect(records().slice(2)).toEqual(tail);
      }
    },
  );
  it("writes the ordinary complete Header and Env prefix", () => {
    const { recorder, start, frames, records, calls } = lifecycleSession();
    start();
    expect(frames).toHaveLength(2);
    expect(records().map((r) => r.record)).toEqual(["Header", "Env"]);
    expect(recorder.recording).toBe(true);
    expect(calls).toEqual([]);
  });
  it("does not append Env or End after its Header sink halts", () => {
    const { recorder, start, frames, calls } = lifecycleSession(
      (rec, count) => {
        if (count === 1) rec.halt();
      },
    );
    start();
    recorder.end(2);
    expect(recorder.recording).toBe(false);
    // A Header-only startup is partial; do not claim a valid full log.
    expect(frames).toHaveLength(1);
    expect(calls).toEqual([]);
  });
  it("stops Env after Header-time fault without claiming valid startup", () => {
    const { recorder, start, frames, calls, records } = lifecycleSession(
      (rec, count) => {
        if (count === 1) rec.fault(new Error("start control"));
      },
    );
    start();
    recorder.end(2);
    expect(recorder.recording).toBe(false);
    expect(frames).toHaveLength(2);
    expect(calls).toEqual(["halt"]);
    // Refusal before the mandatory Env is a separate startup-format defect.
    expect(records).toThrow(/EnvNotSecond/);
  });
});

describe("Recorder terminal state before startup", () => {
  it("writes no startup frames after halt", () => {
    const { recorder, start, frames, calls } = lifecycleSession();
    recorder.halt();
    start();
    recorder.end(2);
    expect(recorder.recording).toBe(false);
    expect(frames).toEqual([]);
    expect(calls).toEqual([]);
  });
  it("writes no additional startup frames after a pre-start fault", () => {
    const { recorder, start, frames, calls } = lifecycleSession();
    recorder.fault(new Error("pre-start control"));
    const partial = frames.map((frame) => Buffer.from(frame));
    expect(partial).toHaveLength(1);
    start();
    recorder.end(2);
    expect(recorder.recording).toBe(false);
    expect(frames.map((frame) => Buffer.from(frame))).toEqual(partial);
    expect(calls).toEqual(["halt"]);
    // This pre-start Refusal is partial, not a valid Header/Env stream.
  });
});

/** Terminal callbacks observe public sink boundaries and actual encoded frames. */
function terminalSession(
  external = true,
  callbacks: {
    append?: (recorder: Recorder) => void;
    end?: (recorder: Recorder) => void;
    beforeEnd?: (recorder: Recorder) => void;
    halt?: (recorder: Recorder) => void;
  } = {},
) {
  const fixture = lifecycleSession();
  fixture.start();
  const [header, env] = fixture.records();
  if (header.record !== "Header" || env.record !== "Env")
    throw new Error("invalid fixture prefix");
  const frames: Uint8Array[] = [];
  let recorder: Recorder;
  let started = false;
  recorder = new Recorder({
    checkpointScheme: "test-state-v1",
    checkpointHash: () => "0".repeat(64),
    sink: external
      ? {
          append(frame) {
            frames.push(frame);
            if (started) callbacks.append?.(recorder);
          },
          end(_unloading, frame) {
            callbacks.beforeEnd?.(recorder);
            frames.push(frame);
            callbacks.end?.(recorder);
          },
          halt() {
            callbacks.halt?.(recorder);
          },
        }
      : undefined,
  });
  recorder.start(header, env);
  started = true;
  return {
    recorder,
    records: () =>
      decodeLog(
        external ? Buffer.concat([streamPrefix(), ...frames]) : recorder.log(),
      ).records,
  };
}

describe("Recorder closes before terminal callbacks", () => {
  it.each([true, false])(
    "preserves ordinary End output (sink=%s)",
    (external) => {
      const { recorder, records } = terminalSession(external);
      recorder.end(2);
      expect(records().map((r) => r.record)).toEqual(["Header", "Env", "End"]);
      expect(records().at(-1)).toEqual({
        record: "End",
        last_seq: 0n,
        reason: 2,
      });
      expect(recorder.recording).toBe(false);
    },
  );
  it("blocks public emit during terminal Refusal delivery", () => {
    const callbackStates: boolean[] = [];
    const { recorder, records } = terminalSession(true, {
      append(rec) {
        callbackStates.push(rec.recording);
        rec.emit("Clock", { src: 1, bits: 0n });
      },
    });
    recorder.fault(new Error("terminal control"));
    expect(callbackStates).toEqual([false]);
    expect(records().map((r) => r.record)).toEqual([
      "Header",
      "Env",
      "Refusal",
    ]);
    expect(records().at(-1)).toEqual({
      record: "Refusal",
      seq: 1n,
      feature: "recorder-fault",
      detail: "Error: terminal control",
    });
  });
  it.each(["emit", "fault"] as const)(
    "blocks public %s during End delivery",
    (action) => {
      const callbackStates: boolean[] = [];
      const { recorder, records } = terminalSession(true, {
        end(rec) {
          callbackStates.push(rec.recording);
          if (action === "emit") rec.emit("Clock", { src: 1, bits: 0n });
          else rec.fault(new Error("terminal control"));
        },
      });
      recorder.end(2);
      expect(callbackStates).toEqual([false]);
      expect(records().map((r) => r.record)).toEqual(["Header", "Env", "End"]);
      expect(records().at(-1)).toEqual({
        record: "End",
        last_seq: 0n,
        reason: 2,
      });
      expect(recorder.recording).toBe(false);
    },
  );
  it.each([true, false])(
    "turns actual End encoding failure into terminal Refusal (sink=%s)",
    (external) => {
      const { recorder, records } = terminalSession(external);
      recorder.emit("Clock", { src: 1, bits: 0n });
      recorder.checkpoint();
      expect(records().map((r) => r.record)).toEqual([
        "Header",
        "Env",
        "Clock",
        "Checkpoint",
      ]);
      // No pending records: the injected failure is End encoding, not Checkpoint.
      recorder.injectEncoderFault();
      recorder.end(2);
      expect(recorder.recording).toBe(false);
      expect(records().map((r) => r.record)).toEqual([
        "Header",
        "Env",
        "Clock",
        "Checkpoint",
        "Refusal",
      ]);
      expect(records().at(-1)).toEqual({
        record: "Refusal",
        seq: 3n,
        feature: "recorder-fault",
        detail: "Error: injected encoder fault",
      });
    },
  );
  it("closes before describing an error through public object conversion", () => {
    const callbackStates: boolean[] = [];
    const { recorder, records } = terminalSession();
    recorder.fault({
      toString() {
        callbackStates.push(recorder.recording);
        recorder.emit("Clock", { src: 1, bits: 0n });
        return "description control";
      },
    });
    expect(callbackStates).toEqual([false]);
    expect(records().map((r) => r.record)).toEqual([
      "Header",
      "Env",
      "Refusal",
    ]);
    expect(records().at(-1)).toEqual({
      record: "Refusal",
      seq: 1n,
      feature: "recorder-fault",
      detail: "description control",
    });
  });
  it("keeps sink halt callbacks terminal", () => {
    const callbackStates: boolean[] = [];
    const { recorder, records } = terminalSession(true, {
      halt(rec) {
        callbackStates.push(rec.recording);
        rec.emit("Clock", { src: 1, bits: 0n });
        rec.fault(new Error("secondary fault"));
      },
    });
    recorder.fault(new Error("terminal control"));
    expect(callbackStates).toEqual([false]);
    expect(records().map((r) => r.record)).toEqual([
      "Header",
      "Env",
      "Refusal",
    ]);
    expect(records().at(-1)).toMatchObject({
      record: "Refusal",
      seq: 1n,
      detail: "Error: terminal control",
    });
  });
});

describe("Recorder synchronous End delivery failure", () => {
  it.each(["before", "after"] as const)(
    "stops and safely halts after throw %s End acceptance",
    (acceptance) => {
      const states: boolean[] = [];
      let cleanup = 0;
      const fail = (rec: Recorder) => {
        states.push(rec.recording);
        throw new Error("sink delivery control");
      };
      const { recorder, records } = terminalSession(true, {
        ...(acceptance === "before" ? { beforeEnd: fail } : { end: fail }),
        halt(rec) {
          cleanup++;
          states.push(rec.recording);
          rec.emit("Clock", { src: 1, bits: 0n });
          throw new Error("sink cleanup control");
        },
      });
      expect(() => recorder.end(2)).not.toThrow();
      expect(recorder.recording).toBe(false);
      expect(cleanup).toBe(1);
      expect(states).toEqual([false, false]);
      recorder.emit("Clock", { src: 1, bits: 0n });
      recorder.fault(new Error("late control"));
      expect(records().map((r) => r.record)).toEqual(
        acceptance === "before" ? ["Header", "Env"] : ["Header", "Env", "End"],
      );
      // Before acceptance only a prefix remains. After acceptance the observed
      // End bytes do not establish transport/network success or completion.
      if (acceptance === "after")
        expect(records().at(-1)).toEqual({
          record: "End",
          last_seq: 0n,
          reason: 2,
        });
    },
  );
});

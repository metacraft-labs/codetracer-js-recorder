/**
 * The record side of the boundary log: numbers records, encodes them with
 * the `@codetracer/boundary-format` encoder, keeps the frames, decides when
 * a checkpoint is due, and turns any failure of its own into one
 * `Refusal{feature: "recorder-fault"}` and silence (JS-Boundary-Recording.md
 * §10.1: the shim never throws into the page).
 *
 * The frames go to a {@link FrameSink} when one is given (the batched
 * upload transport, `HttpBatchTransport`, §11.1), which owns them from
 * then on; without one they are kept in memory for the life of the page
 * and read back through `log()` (§10.4).
 */

import {
  type BoundaryRecord,
  type RecordKind,
  type RecordOf,
  encodeFrame,
  streamPrefix,
} from "@codetracer/boundary-format";
import type { RecorderProgress } from "./document-progress.js";

/** A record of kind `K` without its `record` and `seq` fields. */
export type SeqFields<K extends RecordKind> = Omit<
  RecordOf<K>,
  "record" | "seq"
>;

/** The record kinds that carry a `seq`. */
export type SeqKind = Exclude<RecordKind, "Header" | "Env" | "Gap" | "End">;

/** `Task.kind` / `TaskReg.kind` (§5.2). */
export const TaskKind = {
  timeout: 1,
  interval: 2,
  animationFrame: 3,
  networkCompletion: 4,
  input: 5,
  message: 6,
  idle: 7,
  webSocket: 8,
  storageEvent: 9,
  observer: 10,
  hydrationStart: 11,
  navigation: 12,
} as const;

/** `Clock.src` (§5.2). */
export const ClockSrc = {
  dateNow: 1,
  performanceNow: 2,
  newDate: 3,
  animationFrame: 4,
  eventTimeStamp: 5,
} as const;

/**
 * §7.3: a checkpoint is due once this many records have been written since
 * the last one, or this much recorded time has passed, whichever is first.
 */
export const CHECKPOINT_RECORDS = 256;
export const CHECKPOINT_RECORDED_MS = 2000;

/** The feature name of the `Refusal` written when the shim itself fails. */
export const RECORDER_FAULT = "recorder-fault";

type State = "recording" | "faulted" | "ended";

/**
 * Where the frames go when they are not kept in memory: every frame, in
 * the order written, with its record's `seq` (`undefined` for `Header`,
 * `Env` and `End`). `HttpBatchTransport` is one.
 */
export interface FrameSink {
  append(frame: Uint8Array, seq: bigint | undefined): void;
  /**
   * The session ended; `endFrame` is its `End`, the last frame.
   * `unloading` when the page is going away (`pagehide`).
   */
  end(unloading: boolean, endFrame: Uint8Array): unknown;
  /** The recorder stopped without an `End` (a fault): take nothing more. */
  halt(): void;
}

export interface RecorderOptions {
  /** Computes the checkpoint's `state_hash` (the `dom-v1` scheme). */
  checkpointHash: () => string;
  /** The checkpoint scheme name. */
  checkpointScheme: string;
  /**
   * Computes the checkpoint's `dom_digest`. Absent for `dom-v1` (level 0),
   * whose hash is the `state_hash`; a cooperating framework's scheme
   * carries `dom-v1` here beside its own state hash (§7.3).
   */
  checkpointDomDigest?: () => string;
  /** Where the frames go; absent, they are kept in memory (§10.4). */
  sink?: FrameSink;
}

export class Recorder {
  private readonly frames: Uint8Array[] = [];
  private nextSeq = 1n;
  private nextTaskIdValue = 1n;
  private nextReqIdValue = 1n;
  private state: State = "recording";
  private faultArmed = false;
  private inFault = false;

  private checkpointOrdinal = 0;
  private recordsSinceCheckpoint = 0;
  /** The latest monotonic and wall-clock values this session logged. */
  private monoNow: number | undefined;
  private wallNow: number | undefined;
  private monoAtCheckpoint: number | undefined;
  private wallAtCheckpoint: number | undefined;
  /** The document's loading, once attached ({@link attachProgress}). */
  private progress: RecorderProgress | undefined;

  constructor(private readonly opts: RecorderOptions) {}

  /** Whether records are still being written. */
  get recording(): boolean {
    return this.state === "recording";
  }

  /**
   * Record the document's loading through this recorder (§6, "The
   * document's own tasks"; `recordDocumentProgress` attaches it): the
   * `Loading` at the start of each macrotask, the `DocTask` of a script
   * before its first record, and no checkpoint while the document parses.
   */
  attachProgress(progress: RecorderProgress): void {
    this.progress = progress;
  }

  /** A fresh `task_id` (§6: assigned at registration). */
  nextTaskId(): bigint {
    return this.nextTaskIdValue++;
  }

  /** A fresh `req_id`. */
  nextReqId(): bigint {
    return this.nextReqIdValue++;
  }

  /** Write `Header` and `Env`, the two records without a `seq`. */
  start(header: SeqFields<"Header">, env: SeqFields<"Env">): void {
    this.guard(() => {
      this.push({ record: "Header", ...header } as BoundaryRecord);
      this.push({ record: "Env", ...env } as BoundaryRecord);
    });
  }

  /**
   * Write one seq-bearing record. Throws only through `guard`: callers in
   * the seams wrap every call in {@link guard}.
   */
  emit<K extends SeqKind>(kind: K, fields: SeqFields<K>): void {
    if (this.state !== "recording") return;
    if (kind !== "Loading" && kind !== "DocTask") this.progress?.beforeRecord();
    const record = {
      record: kind,
      seq: this.nextSeq,
      ...fields,
    } as unknown as BoundaryRecord;
    // The seq is committed only once the frame is encoded, so a record that
    // fails to encode leaves no hole: the Refusal written by `fault` takes
    // its seq.
    this.push(record);
    this.nextSeq += 1n;
    if (kind === "Checkpoint") {
      this.recordsSinceCheckpoint = 0;
    } else {
      this.recordsSinceCheckpoint += 1;
    }
    if (kind === "Clock")
      this.noteClock(fields as unknown as SeqFields<"Clock">);
  }

  /**
   * Run `f`, turning anything it throws into a recorder fault. Returns
   * `f`'s result, or `undefined` if it threw.
   */
  guard<T>(f: () => T): T | undefined {
    try {
      return f();
    } catch (e) {
      this.fault(e);
      return undefined;
    }
  }

  /**
   * A macrotask is about to run its callback: the previous one and its
   * microtasks have drained, which is a quiescent point (§7.3). Writes a
   * checkpoint here if one is due, then the `Task` record.
   */
  task(taskId: bigint, kind: number): void {
    if (this.state !== "recording") return;
    this.macrotask();
    this.emit("Task", { task_id: taskId, kind });
  }

  /**
   * A macrotask starts (a quiescent point, §7.3): where the document is in
   * its loading (`Loading`, while it loads), then a checkpoint if one is
   * due. A recorder that writes a task's records itself (an input's
   * `DomEffect`s before its `Task`) calls this first.
   */
  macrotask(): void {
    if (this.state !== "recording") return;
    this.progress?.macrotask();
    if (this.checkpointDue()) this.checkpoint();
  }

  /** Whether §7.3's cadence calls for a checkpoint at this quiescent point. */
  checkpointDue(): boolean {
    if (this.recordsSinceCheckpoint === 0) return false;
    // Not while the document parses: its extent between two of the parser's
    // tokens is not in the log, so a replay could not compare the same
    // document (§7.3, as amended for §6 "The document's own tasks").
    if (this.progress?.checkpointsAllowed() === false) return false;
    if (this.recordsSinceCheckpoint >= CHECKPOINT_RECORDS) return true;
    return (
      elapsed(this.monoAtCheckpoint, this.monoNow) >= CHECKPOINT_RECORDED_MS ||
      elapsed(this.wallAtCheckpoint, this.wallNow) >= CHECKPOINT_RECORDED_MS
    );
  }

  /** Write a `Checkpoint` of the current state. */
  checkpoint(): void {
    if (this.state !== "recording") return;
    const stateHash = this.opts.checkpointHash();
    this.emit("Checkpoint", {
      ordinal: this.checkpointOrdinal,
      scheme: this.opts.checkpointScheme,
      state_hash: stateHash,
      dom_digest: this.opts.checkpointDomDigest?.() ?? "",
    });
    this.checkpointOrdinal += 1;
    this.monoAtCheckpoint = this.monoNow;
    this.wallAtCheckpoint = this.wallNow;
  }

  /**
   * End the session: a final checkpoint (if anything was written since the
   * last), then `End{reason}`. Nothing is written after it. `unloading`
   * tells the sink the page is going away (`pagehide`).
   */
  end(reason: number, unloading = false): void {
    if (this.state !== "recording") return;
    this.guard(() => {
      if (
        this.recordsSinceCheckpoint > 0 &&
        this.progress?.checkpointsAllowed() !== false
      ) {
        this.checkpoint();
      }
      const end = {
        record: "End",
        last_seq: this.nextSeq - 1n,
        reason,
      } as BoundaryRecord;
      const sink = this.opts.sink;
      if (sink === undefined) {
        this.push(end);
      } else {
        sink.end(unloading, this.encode(end));
      }
      this.state = "ended";
    });
  }

  /**
   * Stop recording without writing anything more, not even `End`: the
   * upload transport turned off (no consent, recording disabled by the
   * ingest), so the records would go nowhere.
   */
  halt(): void {
    if (this.state === "recording") this.state = "ended";
  }

  /**
   * The shim failed. Disable recording for the session and write
   * `Refusal{feature: "recorder-fault"}` (§10.1); nothing is written after
   * it, not even `End`, so the log's last record says why it stops.
   */
  fault(error: unknown): void {
    if (this.inFault || this.state !== "recording") return;
    this.inFault = true;
    try {
      const detail = describe(error);
      try {
        this.push({
          record: "Refusal",
          seq: this.nextSeq,
          feature: RECORDER_FAULT,
          detail,
        } as BoundaryRecord);
        this.nextSeq += 1n;
      } catch {
        // The encoder cannot write even the refusal: the log simply stops.
      }
    } finally {
      this.state = "faulted";
      this.inFault = false;
      try {
        this.opts.sink?.halt();
      } catch {
        // The sink's own failure is its own (it never throws).
      }
    }
  }

  /**
   * Test seam (`__ctBoundaryShim.injectEncoderFault()`): the next frame the
   * encoder is asked for throws, as a defect in the encoder would. Lets a
   * test drive the fault path through the shipped code.
   */
  injectEncoderFault(): void {
    this.faultArmed = true;
  }

  /**
   * The frames written so far, one per record, in order. A recorder that
   * uploads batches slices it; nothing may modify it.
   */
  get frameList(): readonly Uint8Array[] {
    return this.frames;
  }

  /** The frames written so far, as one batch body (no stream prefix). */
  frameRun(): Uint8Array {
    let len = 0;
    for (const f of this.frames) len += f.length;
    const out = new Uint8Array(len);
    let at = 0;
    for (const f of this.frames) {
      out.set(f, at);
      at += f.length;
    }
    return out;
  }

  /** The log so far as a `jsbound.log` stream: prefix and every frame. */
  log(): Uint8Array {
    const prefix = streamPrefix();
    const run = this.frameRun();
    const out = new Uint8Array(prefix.length + run.length);
    out.set(prefix);
    out.set(run, prefix.length);
    return out;
  }

  private push(record: BoundaryRecord): void {
    const frame = this.encode(record);
    const sink = this.opts.sink;
    if (sink === undefined) {
      this.frames.push(frame);
    } else {
      sink.append(frame, "seq" in record ? record.seq : undefined);
    }
  }

  private encode(record: BoundaryRecord): Uint8Array {
    if (this.faultArmed) {
      this.faultArmed = false;
      throw new Error("injected encoder fault");
    }
    return encodeFrame(record);
  }

  private noteClock(c: SeqFields<"Clock">): void {
    const value = bitsToNumber(c.bits);
    if (c.src === ClockSrc.dateNow || c.src === ClockSrc.newDate) {
      this.wallNow = value;
      this.wallAtCheckpoint ??= value;
    } else if (
      c.src === ClockSrc.performanceNow ||
      c.src === ClockSrc.animationFrame
    ) {
      this.monoNow = value;
      this.monoAtCheckpoint ??= value;
    }
  }
}

function elapsed(from: number | undefined, to: number | undefined): number {
  return from === undefined || to === undefined ? 0 : to - from;
}

const bitsView = new DataView(new ArrayBuffer(8));

/** The IEEE-754 bits of `v` as a u64 (`Clock.bits`, §5.2). */
export function numberToBits(v: number): bigint {
  bitsView.setFloat64(0, v, true);
  return bitsView.getBigUint64(0, true);
}

/** The inverse of {@link numberToBits}. */
export function bitsToNumber(bits: bigint): number {
  bitsView.setBigUint64(0, bits, true);
  return bitsView.getFloat64(0, true);
}

function describe(error: unknown): string {
  let s: string;
  try {
    s =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
  } catch {
    s = "unprintable error";
  }
  return s.length > 200 ? s.slice(0, 200) : s;
}

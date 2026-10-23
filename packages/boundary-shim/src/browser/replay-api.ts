/**
 * The replay runner's in-page interface, `globalThis.__ctReplay`
 * (CodeTracer's JS-Boundary-Recording specification §9.7), as its clients
 * see it: the generic shim's replay mode (level 0) and a cooperating
 * framework's replay backends (level 1). The runner
 * (`@codetracer/boundary-replay`) implements it; this module holds only
 * the names and types, so every client compiles against one definition.
 *
 * Kept free of DOM-only and Node-only APIs beyond types.
 */

import type {
  BoundaryRecord,
  RecordKind,
  RecordOf,
} from "@codetracer/boundary-format";

import type { ShimOriginals } from "./originals.js";

/** The global the runner installs before any page code runs (§9.7). */
export const REPLAY_GLOBAL = "__ctReplay";

/**
 * The global the runner's configuration is handed to the in-page runtime
 * through, by an init script that runs first. Its value is a
 * {@link ReplayConfig}.
 */
export const REPLAY_CONFIG_GLOBAL = "__ctReplayConfig";

/** What the runner hands the in-page runtime. */
export interface ReplayConfig {
  /**
   * The session's log as a `jsbound.log` stream, base64. Bodies are inline
   * whatever their size (the runner resolves `jsbound.blb` references), so
   * it is decoded with the batch rule for inline bodies (§5.2).
   */
  log: string;
  /**
   * The name of the function the runner exposed to the page to let the
   * document's own loading go on (a held gate, script, `DOMContentLoaded`
   * or `load`; §6, "The document's own tasks"). The runtime takes it and
   * removes the global before any page code runs. Absent when the runner
   * holds nothing.
   */
  binding?: string;
}

/** The divergence kinds of §7.2. */
export const DIVERGENCE_KINDS = [
  "ExtraRead",
  "MissingRead",
  "ArgumentMismatch",
  "TaskOrderMismatch",
  "CheckpointMismatch",
  "ErrorMismatch",
  "InjectionFailed",
  "BuildMismatch",
  "Gap",
  "NonReplayable",
] as const;

export type DivergenceKind = (typeof DIVERGENCE_KINDS)[number];

/**
 * A divergence (§7.2): `DivergenceError{kind, seq, recorded, actual,
 * detail, cause}`. `seq` is the decimal `seq` of the record the replay
 * diverged at (`"0"` for a divergence before any record, `BuildMismatch`).
 */
export interface DivergenceReport {
  kind: DivergenceKind;
  seq: string;
  recorded: string;
  actual: string;
  detail: string;
  /**
   * `substituted-sensitive` when a raw read of a sensitive value preceded
   * the divergence, `mismatch` otherwise (§7.2). This runner
   * version observes no sensitive reads, so it is always `mismatch`.
   */
  cause: "mismatch" | "substituted-sensitive";
}

/** The record at the cursor, as {@link CtReplay.peek} shows it. */
export interface RecordView {
  /** The record's kind, or `"end-of-log"` past the last record. */
  kind: RecordKind | "end-of-log";
  /** Its `seq` (decimal), or `undefined` for a record without one. */
  seq: string | undefined;
  /** The record itself; `undefined` past the last record. */
  record: BoundaryRecord | undefined;
}

/**
 * The fields of record kind `K` a replay checks (§5.2, "Replay" column):
 * any subset of the record's fields, compared for equality.
 */
export type CheckedFields<K extends RecordKind> = Partial<
  Omit<RecordOf<K>, "record" | "seq">
>;

/** What a task handler is called with: the `Task` record being released. */
export type TaskRecord = RecordOf<"Task">;

/**
 * `globalThis.__ctReplay` (§9.7). Every call goes through one cursor, so
 * divergence detection has one implementation. A call that diverges throws
 * an `Error` whose `divergence` property is the {@link DivergenceReport};
 * the first divergence is latched, and every later call throws it again,
 * so a page that catches it cannot carry on as if it had not happened.
 */
export interface CtReplay {
  readonly protocol: 1;
  /** `Header.protocol_level` of the session being replayed. */
  readonly level: 0 | 1;
  /** The session's `Header` and `Env`. */
  readonly header: RecordOf<"Header">;
  readonly env: RecordOf<"Env">;
  /**
   * Match the record at the cursor against a boundary read the page makes
   * now, then advance and return it (§7.1): its kind must be `kind` and
   * every field in `checked` must equal the record's. `Mark` records are
   * skipped. Reaching a `Gap` or a `Refusal` diverges as `Gap` or
   * `NonReplayable` whatever the read.
   */
  next<K extends RecordKind>(kind: K, checked?: CheckedFields<K>): RecordOf<K>;
  /** The record at the cursor (after `Mark`s), not consumed. */
  peek(): RecordView;
  /**
   * The record `offset` records past the cursor (0 is {@link peek}'s),
   * skipping `Mark`s, for a client whose next step depends on what the log
   * says comes later (an XMLHttpRequest that failed at DONE).
   */
  peekAt(offset: number): RecordView;
  /** The page registers task `taskId`: matches the `TaskReg` at the cursor. */
  registerTask(taskId: bigint, kind: number, delayMs: number): void;
  /**
   * Run `run` each time a `Task` of `taskId` comes due, until
   * {@link offTask}. A task registered with no handler, or whose handler
   * was removed, is one the page cancelled: its `Task` diverges. A handler
   * may return a promise: the task is then over (and the scheduler waits
   * for the page to be quiescent) only once it settles, for a task whose
   * page code waits on the platform (a whole-body read, §6).
   */
  onTask(
    taskId: bigint,
    run: (task: TaskRecord) => void | PromiseLike<void>,
  ): void;
  offTask(taskId: bigint): void;
  /**
   * Run `run` for every due `Task` of `kind` that no `TaskReg` registered:
   * the tasks the browser dispatches and the recorder mints an id for when
   * it runs (navigation, 12; a framework's hydration start, 11). Input
   * tasks (5) are not claimed this way: the runner injects their `Input`.
   */
  onUnregisteredTask(kind: number, run: (task: TaskRecord) => void): void;
  /** Whether the record at the cursor is a `Checkpoint`. */
  checkpointDue(): boolean;
  /**
   * Diverge now with `kind` at the record at the cursor (or `seq`), for a
   * mismatch only the client can see (a filled view's length, a task id
   * the page minted out of order). Never returns.
   */
  fail(
    kind: DivergenceKind,
    detail: string,
    recorded?: string,
    actual?: string,
    seq?: string,
  ): never;
  /** The latched divergence, if the replay has diverged. */
  readonly failed: DivergenceReport | undefined;
  /**
   * The runner's parser gates call this (§6, "The document's own tasks";
   * `packages/boundary-replay/src/gates.ts`): it removes the calling gate
   * script and, when the document is at the position of the `Loading`
   * record at the cursor, holds the parser there until the scheduler has
   * released the tasks recorded at it. Clients do not call it.
   */
  gate(): void;
  /** The platform functions as they were before anything patched them (§6). */
  readonly originals: ShimOriginals;
}

/**
 * What a cooperating framework installs as `__ctBoundaryProtocol.replay`
 * when it finds `__ctReplay` (§9.5, §9.6).
 */
export interface ReplayHooks {
  /**
   * Inject one `Input`: apply `effects` (the `DomEffect` records that
   * preceded it), resolve the target and call the registered handler
   * directly with an event built from the recorded properties. Returns
   * `"ok"`, or a reason, which the runner reports as `InjectionFailed`.
   */
  inject(input: RecordOf<"Input">, effects: RecordOf<"DomEffect">[]): string;
  /** The framework's state hash now (§9.6), for a `Checkpoint`. */
  checkpoint(): { scheme: string; state_hash: string };
}

/** The installed `__ctReplay`, if any. */
export function replayOf(g: object): CtReplay | undefined {
  return (g as Record<string, CtReplay | undefined>)[REPLAY_GLOBAL];
}

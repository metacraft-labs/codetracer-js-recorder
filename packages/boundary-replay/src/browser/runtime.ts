/**
 * The replay runner's in-page half (CodeTracer's JS-Boundary-Recording
 * specification §6, §7, §9.7): `globalThis.__ctReplay`, the one cursor
 * every boundary read of the page is matched against, and the scheduler
 * that owns the page's macrotasks.
 *
 * It is the first script in the page (an init script of the replay
 * context): it captures the platform functions before anything patches
 * them, decodes the log the runner handed it, installs `__ctReplay`, and
 * releases the log's tasks one at a time, from the start of the document.
 * Clients make the page's boundary reads go through it: the generic shim's
 * replay mode at level 0, a cooperating framework's replay backends at
 * level 1.
 *
 * - **The cursor** (§7.1). A read matches the record at the cursor before
 *   it commits: kind, then every checked field; only then does the cursor
 *   advance and the logged value return. `Mark` records are skipped.
 * - **The scheduler** (§6). A registered callback runs only when the log's
 *   next record is its `Task`. After each task the scheduler waits until
 *   the page is quiescent (its microtasks have drained) before looking at
 *   the log again. At a quiescent point it compares a due `Checkpoint`
 *   (§7.3), buffers `DomEffect`s for the next input, injects an input
 *   (`Task{kind 5}` then `Input`), releases a task, or finishes at `End`.
 *   Anything else at the cursor is a read the page did not make
 *   (`MissingRead`).
 * - **The document's own loading** (§6, "The document's own tasks"). A
 *   task recorded while the document loaded is preceded by a `Loading`
 *   record, the document's position then; the scheduler takes it only when
 *   the replayed document is at that position, and, while the document
 *   parses, only when the parser is held there (by a parser gate,
 *   `../gates.ts`, or by a script the runner holds). The document's own
 *   tasks (an external script's execution, `DOMContentLoaded`, `load`, a
 *   resource element's event) are `DocTask` records: the runner holds them
 *   until the scheduler lets them go, at that point of the log, and the
 *   platform's resource events that come at any other point are held back
 *   and dispatched from the log in their turn.
 * - **Divergence** (§7.2). The first divergence is latched: it is thrown
 *   into whatever made the call, every later call throws it again, and the
 *   scheduler stops. The runner then writes no trace.
 *
 * The runner reads the outcome through `__ctReplay.status()`.
 */

import {
  type BoundaryRecord,
  type RecordKind,
  type RecordOf,
  decodeLog,
  seqOf,
  toHex,
} from "@codetracer/boundary-format";
import {
  IMPORT_SEAM_CAPABILITY,
  IMPORT_SEAM_GLOBAL,
} from "@codetracer/boundary-shim/dist/browser/config.js";
import { domV1Hash } from "@codetracer/boundary-shim/dist/browser/dom-v1.js";
import {
  DocumentProgress,
  describePosition,
  listenForResourceEvents,
  samePosition,
} from "@codetracer/boundary-shim/dist/browser/document-progress.js";
import { resourceEventOf } from "@codetracer/boundary-shim/dist/browser/resource-events.js";
import {
  resolveTarget,
  targetOf,
} from "@codetracer/boundary-shim/dist/browser/targets.js";
import {
  type ShimOriginals,
  captureOriginals,
} from "@codetracer/boundary-shim/dist/browser/originals.js";
import {
  type CheckedFields,
  type CtReplay,
  type DivergenceKind,
  type DivergenceReport,
  type MatchedCheckpoint,
  type RecordView,
  REPLAY_CONFIG_GLOBAL,
  REPLAY_GLOBAL,
  type ReplayConfig,
  type ReplayHooks,
  type TaskRecord,
} from "@codetracer/boundary-shim/dist/browser/replay-api.js";
import { INPUT_EVENT_TYPES } from "@codetracer/boundary-shim/dist/browser/seams-dom.js";

import { GATE_MARKER, GATE_PATH } from "../gates.js";

/** `Task.kind` of an input event (§5.2). */
const INPUT_TASK = 5;

/** The global a cooperating framework declares itself on (§9.2). */
const PROTOCOL_GLOBAL = "__ctBoundaryProtocol";
/** The generic shim's control surface (§10.4), in replay mode. */
const SHIM_GLOBAL = "__ctBoundaryShim";

/** What the generic shim's replay mode publishes for the runner. */
interface ShimReplayControl {
  mode: "replay";
  inject(input: RecordOf<"Input">, effects: RecordOf<"DomEffect">[]): string;
}

/**
 * How much of the materialised trace the replay's `__ct` calls have emitted
 * (§12): trace steps (`step` and `write` calls; record-web writes one step
 * for each), calls entered and calls returned. Counted only while emission
 * is on, so a range materialisation's counts are its own trace's.
 */
export interface TracePosition {
  steps: number;
  calls: number;
  returns: number;
}

/** Where the trace was when the replay matched a checkpoint (§12). */
export interface CheckpointTrace extends TracePosition {
  ordinal: number;
  /** The checkpoint's `seq` (decimal). */
  seq: string;
  /**
   * The instrumented frames open there: entered (`__ct.enter`) and not yet
   * returned from (`__ct.ret`), counted whether emission is on or not. A
   * checkpoint has no page code on the stack (§7.3), so each is a frame
   * suspended across it (an `async` function at an `await`, a generator at
   * a `yield`) or one an exception left without its return. A range is
   * bounded only where this is 0 (§12): a bound inside such a frame would
   * cut it, and the range would not equal the same range of a full trace.
   */
  open: number;
}

/** The replay's state as `__ctReplay.status()` reports it. */
export interface ReplayStatus {
  state: "loading" | "running" | "done" | "diverged";
  divergence?: DivergenceReport;
  /** `Checkpoint` records compared (and matched, unless diverged). */
  checkpoints: number;
  /** `Input` records injected. */
  injections: number;
  /**
   * At level 1: DOM events of an injected input's type that reached the
   * window while the framework's `inject` ran. A framework that calls the
   * registered handler directly (§9.5) dispatches none.
   */
  dispatchedDuringInject: string[];
  /** Tasks released by the scheduler. */
  tasks: number;
  /** The `seq` of the record at the cursor. */
  cursor: string;
  /**
   * The record at the cursor and where the replayed document is in its
   * loading, for the report of a replay that did not finish.
   */
  waiting?: string;
  /** Errors a page callback threw while the scheduler ran it. */
  pageErrors: string[];
  /** Whether `__ct` emission is on (§12, range materialisation). */
  emitting: boolean;
  /**
   * What the trace has emitted so far, once the runner attached the `__ct`
   * runtime ({@link CtReplayRunner.gateTrace}); zeros otherwise.
   */
  trace: TracePosition;
  /**
   * For every checkpoint matched so far, where the trace was then: the
   * positions a full materialisation's trace can be cut at (§12, a range of
   * a full materialisation).
   */
  checkpointTrace: CheckpointTrace[];
  /**
   * The `seq` of the checkpoint a range replay stopped at: the first at or
   * after `emit.to` with no instrumented frame open (§12); absent for a
   * replay that went on to `End`.
   */
  stoppedAt?: string;
  /**
   * Set when instrumented frames were open at the `emit.from` checkpoint
   * (§12): a range cannot start inside a frame, so emission stayed off, and
   * the runner replays again from an earlier checkpoint where none was.
   */
  fromNotQuiescent?: boolean;
}

/** The `__ct` methods the instrumented build calls (§12). */
type CtRuntime = Record<string, unknown>;

/**
 * What the in-page runtime offers its runner beyond the protocol's
 * `__ctReplay` (§9.7): read by the runner, never by the page's clients.
 */
export interface CtReplayRunner {
  status(): ReplayStatus;
  pendingScriptElement(url: string): boolean;
  /**
   * Put `__ct` emission under the replay's control (§12): the runner calls
   * it from an init script right after the instrumented build's `__ct`
   * runtime is installed. Each emitting method of `ct` is wrapped so that it
   * emits only while emission is on, and counts what it emits; `ret` always
   * returns its value, which the instrumented code passes on. `enter` and
   * `ret` also count the frames open, whether emission is on or not
   * ({@link CheckpointTrace.open}).
   */
  gateTrace(ct: CtRuntime): void;
}

/** A latched divergence, thrown into whatever made the diverging call. */
class Divergence extends Error {
  constructor(readonly divergence: DivergenceReport) {
    super(
      `replay divergence ${divergence.kind} at seq ${divergence.seq}: ${divergence.detail}`,
    );
    this.name = "ReplayDivergence";
  }
}

/** A short, stable description of a record for a report. */
export function describeRecord(r: BoundaryRecord | undefined): string {
  if (r === undefined) return "end of log";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(r)) {
    if (k === "record" || k === "seq") continue;
    parts.push(`${k}=${describeValue(v)}`);
  }
  return `${r.record}{${parts.join(", ")}}`;
}

function describeValue(v: unknown): string {
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Uint8Array) return `0x${toHex(v.subarray(0, 32))}`;
  if (typeof v === "object" && v !== null && "kind" in v) {
    const b = v as { kind: string; bytes?: Uint8Array };
    return b.kind === "inline" && b.bytes !== undefined
      ? `inline(${b.bytes.length} bytes)`
      : "ref";
  }
  const s = JSON.stringify(v);
  return s.length > 120 ? s.slice(0, 117) + "..." : s;
}

/** Whether a checked field's actual value equals the recorded one. */
function sameValue(recorded: unknown, actual: unknown): boolean {
  if (typeof recorded === "bigint") {
    try {
      return recorded === BigInt(actual as bigint | number | string);
    } catch {
      return false;
    }
  }
  if (recorded instanceof Uint8Array) {
    return actual instanceof Uint8Array && toHex(recorded) === toHex(actual);
  }
  if (
    typeof recorded === "number" &&
    typeof actual === "number" &&
    Number.isNaN(recorded)
  ) {
    return Number.isNaN(actual);
  }
  return recorded === actual;
}

function base64Bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Install `__ctReplay` on `w` from `config`, and start the scheduler. */
export function installReplayRuntime(
  w: Window & typeof globalThis,
  config: ReplayConfig,
): CtReplay & CtReplayRunner {
  const orig: ShimOriginals = captureOriginals(w);
  const OrigPromise = orig.Promise;
  const decoded = decodeLog(base64Bytes(config.log), { inlineBodies: "batch" });
  const records = decoded.records;
  if (records[0]?.record !== "Header" || records[1]?.record !== "Env") {
    throw new Error("the replay log does not start with Header and Env");
  }
  const header = records[0] as RecordOf<"Header">;
  const env = records[1] as RecordOf<"Env">;
  const level = header.protocol_level === 1 ? 1 : 0;

  let at = 2;
  let failed: DivergenceReport | undefined;
  /** The last seq-bearing record's seq, for a read past the end. */
  let lastSeq = 0n;
  for (const r of records) {
    const s = seqOf(r);
    if (s !== undefined) lastSeq = s;
    if (r.record === "Gap") lastSeq = r.last_seq;
  }

  const registered = new Map<bigint, number>();
  const handlers = new Map<
    bigint,
    (task: TaskRecord) => void | PromiseLike<void>
  >();
  /**
   * A task whose handler returned a promise (§9.7): the next record waits
   * until it settles.
   */
  let taskUnderway: PromiseLike<void> | undefined;
  const unregistered = new Map<
    number,
    (task: TaskRecord) => void | PromiseLike<void>
  >();
  /**
   * Tasks whose platform work the page's replay does not start by itself
   * (a dynamic `import()`, whose module is fetched and evaluated only when
   * the scheduler says so, §6): the function that starts it, and whether
   * it was started.
   */
  const starters = new Map<bigint, () => PromiseLike<void>>();
  const started = new Set<bigint>();
  /**
   * The values a client delivers when they come due at a quiescent point
   * (a `MutationObserver`'s records, by the observer's task id, §6).
   */
  const valueDue = new Map<bigint, () => void>();
  /**
   * The stand-in dispatcher of the client (the generic shim's, whose
   * listeners see the event as trusted, §10.5); a plain `dispatchEvent`
   * otherwise.
   */
  let standIn: (target: EventTarget, ev: Event) => void = (target, ev) => {
    w.EventTarget.prototype.dispatchEvent.call(target, ev);
  };
  let pendingEffects: RecordOf<"DomEffect">[] = [];

  // Range materialisation (§12): emission is off until the `from`
  // checkpoint has matched, and the replay stops at the first checkpoint at
  // or after `to` where no instrumented frame is open.
  const emitFrom =
    config.emit?.from === undefined ? undefined : BigInt(config.emit.from);
  const emitTo =
    config.emit?.to === undefined ? undefined : BigInt(config.emit.to);
  /** The last checkpoint compared and matched, for a divergence report. */
  let lastCheckpoint: MatchedCheckpoint | null = null;
  /**
   * Instrumented frames entered and not yet returned from, counted by
   * `gateTrace` whether emission is on or not (see
   * {@link CheckpointTrace.open}).
   */
  let openFrames = 0;

  const status: ReplayStatus = {
    state: "loading",
    checkpoints: 0,
    injections: 0,
    dispatchedDuringInject: [],
    tasks: 0,
    cursor: "",
    pageErrors: [],
    emitting: emitFrom === undefined,
    trace: { steps: 0, calls: 0, returns: 0 },
    checkpointTrace: [],
  };

  /** The index of the first non-`Mark` record at or after `i`. */
  const skipMarks = (i: number): number => {
    while (records[i]?.record === "Mark") i++;
    return i;
  };
  const current = (): BoundaryRecord | undefined => {
    at = skipMarks(at);
    return records[at];
  };
  const seqText = (r: BoundaryRecord | undefined): string => {
    if (r === undefined) return (lastSeq + 1n).toString();
    if (r.record === "Gap") return r.first_seq.toString();
    if (r.record === "End") return (r.last_seq + 1n).toString();
    return (seqOf(r) ?? 0n).toString();
  };

  /**
   * Whether an inline parser gate the parser has gone past never ran: it is
   * still in the document (a gate that runs takes every gate out first,
   * `removeGates`) and an element follows it, so the parser went on past its
   * end tag without running it. With scripting on, only the page's
   * Content-Security-Policy skips a parser-inserted inline script (CSP,
   * "Should element's inline type behavior be blocked by Content Security
   * Policy?", https://w3c.github.io/webappsec-csp/#should-block-inline).
   * The `securitypolicyviolation` event says the same, but in a task of its
   * own (CSP, "report a violation"), which the scheduler may not have seen
   * when it finds the document past a position the gate was to hold; this
   * reads it from the document, at once.
   */
  const gateBlocked = (): boolean => {
    try {
      const d = w.document;
      const all = d.getElementsByTagName("*");
      const last = all[all.length - 1];
      const scripts = d.getElementsByTagName("script");
      for (let i = 0; i < scripts.length; i++) {
        const s = scripts[i];
        if (
          s.hasAttribute(GATE_MARKER) &&
          !s.hasAttribute("src") &&
          s !== last
        ) {
          return true;
        }
      }
    } catch {
      // No document to read yet: no gate either.
    }
    return false;
  };

  const fail = (
    kind: DivergenceKind,
    detail: string,
    recorded?: string,
    actual?: string,
    seq?: string,
  ): never => {
    if (failed === undefined && kind !== "NonReplayable" && gateBlocked()) {
      // Nothing held the parser where the log needed it: that, not the
      // position the document then reached, is why the replay cannot go on.
      kind = "NonReplayable";
      detail =
        "the page's Content-Security-Policy blocks the replay's gate (an inline gate the parser went past did not run): the replay cannot hold the document's loading";
    }
    if (failed === undefined) {
      const r = current();
      failed = {
        kind,
        seq: seq ?? seqText(r),
        recorded: recorded ?? describeRecord(r),
        actual: actual ?? "",
        detail,
        cause: "mismatch",
        lastCheckpoint,
      };
      status.state = "diverged";
      status.divergence = failed;
    }
    throw new Divergence(failed);
  };

  /** A `Gap` or `Refusal` at the cursor ends the replay whatever was asked. */
  const terminal = (r: BoundaryRecord | undefined): void => {
    if (r?.record === "Gap") {
      fail(
        "Gap",
        `the log has a gap over seq ${r.first_seq}..${r.last_seq} (reason ${r.reason})`,
      );
    }
    if (r?.record === "Refusal") {
      fail(
        "NonReplayable",
        `the session is non-replayable from here: the recorder refused ${JSON.stringify(r.feature)} (${r.detail})`,
      );
    }
  };

  // ── The dynamic import() seam, by default (§6 "Dynamic `import()`") ──
  //
  // The runner serves every script and page with each dynamic `import()`
  // rewritten into a call of `__ctBoundaryImport` (`rewriteDynamicImports`),
  // whether or not the deployed bundle carried the seam. Only a session
  // whose recorder declared the seam (`Header.capabilities` holding
  // `import-seam`, the generic shim installed with `--import-seam`) has its
  // imports in the log, and the shim's replay mode then puts its own seam
  // in place of this one. For any other session the log does not say where
  // the module evaluated or when the import settled, so the first call ends
  // the replay as non-replayable from here (JBR-AREQ4), never a replay that
  // runs the module wherever the replay browser's network decides.
  Object.defineProperty(w, IMPORT_SEAM_GLOBAL, {
    value: function refuseDynamicImport(
      _load: unknown,
      specifier: unknown,
    ): never {
      // The specifier is named only when it is a string: converting
      // anything else would run page code.
      const named =
        typeof specifier === "string" ? ` of ${JSON.stringify(specifier)}` : "";
      return fail(
        "NonReplayable",
        `the session is non-replayable from here: the page makes a dynamic import()${named} ("dynamic-import"), which the log does not order, since the session's recorder did not declare the ${JSON.stringify(IMPORT_SEAM_CAPABILITY)} capability (the generic shim records dynamic imports only when installed with boundary-shim --import-seam)`,
      );
    },
    enumerable: false,
    // The generic shim's replay mode replaces it for a session that has
    // the seam.
    configurable: true,
    writable: false,
  });

  const guard = () => {
    if (failed !== undefined) throw new Divergence(failed);
  };

  const next = <K extends RecordKind>(
    kind: K,
    checked: CheckedFields<K> = {},
  ): RecordOf<K> => {
    guard();
    const r = current();
    const actual = `${kind}{${Object.entries(checked)
      .map(([k, v]) => `${k}=${describeValue(v)}`)
      .join(", ")}}`;
    if (r === undefined || r.record === "End") {
      fail(
        "ExtraRead",
        `the page made a read after the log ended`,
        undefined,
        actual,
      );
    }
    terminal(r);
    if (r!.record !== kind) {
      fail(
        "ExtraRead",
        `the page read ${kind} where the log has ${r!.record}`,
        undefined,
        actual,
      );
    }
    for (const [field, value] of Object.entries(checked)) {
      const recorded = (r as unknown as Record<string, unknown>)[field];
      if (!sameValue(recorded, value)) {
        fail(
          "ArgumentMismatch",
          `${kind}.${field} differs: recorded ${describeValue(recorded)}, the page's ${describeValue(value)}`,
          undefined,
          actual,
        );
      }
    }
    at++;
    return r as RecordOf<K>;
  };

  const view = (i: number): RecordView => {
    const r = records[i];
    if (r === undefined) {
      return { kind: "end-of-log", seq: undefined, record: undefined };
    }
    const s = seqOf(r);
    return { kind: r.record, seq: s?.toString(), record: r };
  };

  const peekAt = (offset: number): RecordView => {
    let i = skipMarks(at);
    for (let n = 0; n < offset; n++) i = skipMarks(i + 1);
    return view(i);
  };

  // ── The document's own loading (§6, "The document's own tasks") ──────

  const progress = new DocumentProgress(w);
  const doc = w.document;
  const documentWrite = w.Document.prototype.write;
  const removeElement = w.Element.prototype.remove;
  /**
   * The runner's function that lets a held gate, script, `DOMContentLoaded`
   * or `load` go (`ReplayConfig.binding`), taken off the window before any
   * page code runs.
   */
  let runnerOpen: ((key: string) => unknown) | undefined;
  if (config.binding !== undefined) {
    const g = w as unknown as Record<string, unknown>;
    const f = g[config.binding];
    if (typeof f === "function") {
      runnerOpen = f as (key: string) => unknown;
      try {
        delete g[config.binding];
      } catch {
        // Not configurable: the page could call it, and would only let a
        // held resource go early, which the cursor then reports.
      }
    }
  }
  const letGo = (key: string): void => {
    if (runnerOpen === undefined) {
      fail(
        "MissingRead",
        `the replay must let the document's ${key} go, but the runner exposed no way to`,
      );
    }
    try {
      void (runnerOpen!(key) as Promise<unknown> | undefined)?.catch?.(
        () => undefined,
      );
    } catch {
      // The page is going away.
    }
  };

  /** How many of each script's executions the log has (its `DocTask`s). */
  const heldScripts = new Map<string, number>();
  for (const r of records) {
    if (r.record === "DocTask" && (r.kind === 1 || r.kind === 4)) {
      heldScripts.set(r.src, (heldScripts.get(r.src) ?? 0) + 1);
    }
  }
  /** Whether the log records the document's loading at all. */
  const recordsLoading = records.some(
    (r) => r.record === "Loading" || r.record === "DocTask",
  );
  const hasDocTask = (kind: number) =>
    records.some((r) => r.record === "DocTask" && r.kind === kind);
  /** Whether the runner holds `DOMContentLoaded` and `load` (`gates.ts`). */
  let dclHeld = hasDocTask(2);
  let loadHeld = hasDocTask(3);

  /** The parser gate the parser waits for, while one is held. */
  let gateHeld: number | undefined;
  let gates = 0;
  /**
   * The document task the scheduler let go and waits for: a script (and
   * whether its `DocTask` is still to be taken when it settles), or one of
   * the two events.
   */
  let awaiting:
    | { kind: "script"; src: string; takeAtSettle: boolean }
    | { kind: "domContentLoaded" | "load" }
    | { kind: "resource"; target: string; event: string }
    | undefined;

  /** Wake the scheduler: the document moved on. */
  let wake: (() => void) | undefined;
  const kick = () => {
    const f = wake;
    wake = undefined;
    f?.();
  };

  /**
   * At a document task the log has, take `[Loading][DocTask]` at the cursor
   * if they are this task's: the position must be the replayed document's
   * (measured before the task counts as done, as the recorder measured it).
   */
  const takeDocTask = (kind: number, src: string): boolean => {
    let i = skipMarks(at);
    const first = records[i];
    let loading: RecordOf<"Loading"> | undefined;
    if (first?.record === "Loading") {
      loading = first;
      i = skipMarks(i + 1);
    }
    const task = records[i];
    if (task?.record !== "DocTask" || task.kind !== kind || task.src !== src) {
      return false;
    }
    if (loading !== undefined) {
      const q = progress.position();
      if (q === undefined || !samePosition(q, loading)) {
        fail(
          "TaskOrderMismatch",
          `the document's task (${describeRecord(task)}) ran at a position other than the recorded one`,
          describePosition(loading),
          describePosition(q),
          loading.seq.toString(),
        );
      }
    }
    at = i + 1;
    return true;
  };

  progress.listen(orig.addEventListener, {
    scriptSettled(script) {
      const src = progress.srcOf(script);
      if (
        failed === undefined &&
        awaiting?.kind === "script" &&
        awaiting.src === src
      ) {
        if (awaiting.takeAtSettle) {
          try {
            if (!takeDocTask(4, src)) {
              fail(
                "TaskOrderMismatch",
                `the script ${src} ran, but the log's next document task is not its execution`,
              );
            }
          } catch (e) {
            if (!(e instanceof Divergence)) throw e;
          }
        }
        awaiting = undefined;
      }
      const flying = inFlight.get(src) ?? 0;
      if (flying > 0) inFlight.set(src, flying - 1);
      progress.markScriptSettled(script);
      kick();
    },
    domContentLoaded() {
      if (awaiting?.kind === "domContentLoaded") awaiting = undefined;
      progress.markDomContentLoaded();
      kick();
    },
    load() {
      if (awaiting?.kind === "load") awaiting = undefined;
      progress.markLoad();
      kick();
    },
  });
  orig.addEventListener.call(doc, "readystatechange", () => kick());

  // ── Resource elements' events (§6, `DocTask` kind 5) ─────────────────
  //
  // The browser dispatches an image's, a style sheet's, a frame's (…) `load`
  // and `error`, and a media element's events, when the network or the
  // media pipeline delivers something. The runner holds the requests the
  // log has such an event for (`gates.ts`, `resource:<url>`); the
  // scheduler lets one go when its `DocTask` comes due and lets the
  // platform's event through then. Any other such event of the platform's is
  // held back before a listener of the page sees it: one that arrived early
  // (a resource with no request of its own: cached, a `data:` URL) is
  // dispatched as a stand-in when its `DocTask` comes due, and a media
  // element's always is, since the media pipeline cannot be held.

  /** Platform events of resource elements held back until their `DocTask`. */
  const earlyEvents: { target: string; event: string }[] = [];
  /**
   * Elements the page listens at for a resource event that are not in the
   * document (`new Image()`), which a target string cannot reach.
   */
  const watchedElements: Element[] = [];
  const seenResourceEvents = new WeakSet<Event>();
  listenForResourceEvents(
    w,
    orig.addEventListener,
    (ev) => {
      if (seenResourceEvents.has(ev)) return;
      seenResourceEvents.add(ev);
      const r = resourceEventOf(w, ev);
      if (r === undefined) return;
      if (
        !r.media &&
        awaiting?.kind === "resource" &&
        awaiting.target === r.target
      ) {
        if (awaiting.event === r.event) {
          // The event the log has next: the page's listeners see the
          // platform's own.
          awaiting = undefined;
          kick();
          return;
        }
        try {
          fail(
            "TaskOrderMismatch",
            `the replayed element ${r.target} dispatched ${r.event} where the log has it dispatch ${awaiting.event}`,
          );
        } catch {
          // Latched; the scheduler reports it.
        }
      }
      ev.stopImmediatePropagation();
      if (!r.media) earlyEvents.push({ target: r.target, event: r.event });
      kick();
    },
    (el) => {
      watchedElements.push(el);
    },
  );

  /** The element a resource event's target names (§10.2). */
  const resourceElement = (target: string): Element | undefined => {
    const r = resolveTarget(target, doc);
    if (r instanceof w.Element) return r;
    const detached = watchedElements.filter(
      (e) => !e.isConnected && targetOf(e) === target,
    );
    return detached.length === 1 ? detached[0] : undefined;
  };
  // A gate the page's Content-Security-Policy blocks (an inline gate under
  // a `script-src` without 'unsafe-inline', or a written gate's URL the
  // policy does not allow) neither runs nor holds anything: the replay
  // cannot hold the document's loading, and says so rather than replay it
  // at another position. The violation's target is the element when it is
  // in the document (CSP, "report a violation").
  orig.addEventListener.call(
    w,
    "securitypolicyviolation",
    (ev: Event) => {
      const v = ev as SecurityPolicyViolationEvent;
      if (v.disposition === "report") return;
      const t = v.target as Element | null;
      const isGate =
        (t !== null &&
          typeof t.hasAttribute === "function" &&
          t.hasAttribute(GATE_MARKER)) ||
        String(v.blockedURI ?? "").includes(GATE_PATH);
      if (!isGate || failed !== undefined) return;
      try {
        fail(
          "NonReplayable",
          `the page's Content-Security-Policy blocks the replay's gate (${v.effectiveDirective}): the replay cannot hold the document's loading`,
        );
      } catch {
        // Latched; the scheduler reports it.
      }
      kick();
    },
    { capture: true },
  );

  /**
   * Whether the parser is held where the scheduler can act: at a parser gate,
   * or at a script the runner holds and the scheduler has not let go.
   */
  const parserHeld = (): boolean => {
    if (gateHeld !== undefined) return true;
    if (progress.state !== "loading") return false;
    return progress.pendingScripts().some((s) => {
      if (
        s.hasAttribute("async") ||
        s.hasAttribute("defer") ||
        (s.getAttribute("type") ?? "").trim().toLowerCase() === "module"
      ) {
        return false;
      }
      return heldByRunner(s);
    });
  };

  /** Scripts the scheduler let go that have not settled yet, by URL. */
  const inFlight = new Map<string, number>();

  /**
   * Whether the runner holds the pending script `s` (`runner.ts`): one the
   * log has an execution of, not let go yet; at level 0 also every script
   * the parser inserts from the document (the shim logged every execution,
   * so one the log does not have never ran), unless the scheduler let it
   * go. A script the parser inserted is told from one the page inserted
   * by its `async`: only the page's is "forced async" (HTML, "the script
   * element"), and so `async` without the attribute.
   */
  const heldByRunner = (s: HTMLScriptElement): boolean => {
    const src = progress.srcOf(s);
    if ((inFlight.get(src) ?? 0) > 0) return false;
    if ((heldScripts.get(src) ?? 0) > 0) return true;
    return level === 0 && recordsLoading && s.async === s.hasAttribute("async");
  };

  /** Let the parser go on past the gate it waits at. */
  const openGate = () => {
    const n = gateHeld;
    if (n === undefined) return;
    gateHeld = undefined;
    letGo(`gate/${n}`);
  };

  /** Let one execution of the script `src` go. */
  const openScript = (src: string) => {
    const left = heldScripts.get(src) ?? 0;
    if (left > 0) heldScripts.set(src, left - 1);
    inFlight.set(src, (inFlight.get(src) ?? 0) + 1);
    letGo(`script:${src}`);
  };

  // ── Level 1: whether `inject` dispatches DOM events ───────────────────

  let injecting: string | undefined;
  for (const type of INPUT_EVENT_TYPES) {
    orig.addEventListener.call(
      w,
      type,
      (ev: Event) => {
        if (injecting !== undefined && ev.type === injecting) {
          status.dispatchedDuringInject.push(ev.type);
        }
      },
      { capture: true, passive: true },
    );
  }

  // ── Errors the page raises (`Error` records, §7.2 ErrorMismatch) ──────

  const onPageError = (kind: number, message: string) => {
    const r = current();
    if (r?.record === "Error" && r.kind === kind && r.message === message) {
      at++;
    }
  };
  orig.addEventListener.call(w, "error", (ev: Event) =>
    onPageError(1, String((ev as ErrorEvent).message ?? "")),
  );
  orig.addEventListener.call(w, "unhandledrejection", (ev: Event) => {
    const reason = (ev as PromiseRejectionEvent).reason as unknown;
    onPageError(
      2,
      reason instanceof Error ? reason.message : String(reason ?? ""),
    );
  });

  // ── The scheduler ────────────────────────────────────────────────────

  /** Run page code (a task callback), reporting what it throws as uncaught. */
  const runPage = (f: () => unknown): void => {
    try {
      const r = f();
      if (
        r !== undefined &&
        r !== null &&
        typeof (r as PromiseLike<void>).then === "function"
      ) {
        taskUnderway = r as PromiseLike<void>;
      }
    } catch (e) {
      if (e instanceof Divergence) return;
      status.pageErrors.push(e instanceof Error ? e.message : String(e));
      try {
        (w as unknown as { reportError?: (e: unknown) => void }).reportError?.(
          e,
        );
      } catch {
        // Reporting is best effort; the divergence machinery is not.
      }
    }
  };

  const compareCheckpoint = (r: RecordOf<"Checkpoint">): void => {
    let scheme: string;
    let stateHash: string;
    if (level === 0) {
      scheme = "dom-v1";
      stateHash = domV1Hash(w.document);
    } else {
      const hooks = (
        w as unknown as Record<string, { replay?: Partial<ReplayHooks> }>
      )[PROTOCOL_GLOBAL]?.replay;
      if (typeof hooks?.checkpoint !== "function") {
        fail(
          "CheckpointMismatch",
          "the framework installed no __ctBoundaryProtocol.replay.checkpoint",
        );
      }
      const c = hooks!.checkpoint!();
      scheme = String(c?.scheme);
      stateHash = String(c?.state_hash);
    }
    if (r.scheme !== scheme) {
      fail(
        "CheckpointMismatch",
        `checkpoint ${r.ordinal} uses scheme ${JSON.stringify(r.scheme)}; the replay computes ${JSON.stringify(scheme)}`,
        undefined,
        scheme,
      );
    }
    if (r.state_hash !== stateHash) {
      fail(
        "CheckpointMismatch",
        `checkpoint ${r.ordinal} (${r.scheme}) state hash differs`,
        r.state_hash,
        stateHash,
      );
    }
    if (r.dom_digest !== "") {
      const dom = domV1Hash(w.document);
      if (dom !== r.dom_digest) {
        fail(
          "CheckpointMismatch",
          `checkpoint ${r.ordinal} dom-v1 digest differs`,
          r.dom_digest,
          dom,
        );
      }
    }
    status.checkpoints++;
    lastCheckpoint = {
      ordinal: r.ordinal,
      seq: r.seq.toString(),
      scheme: r.scheme,
      stateHash: r.state_hash,
    };
    status.checkpointTrace.push({
      ordinal: r.ordinal,
      seq: r.seq.toString(),
      ...status.trace,
      open: openFrames,
    });
    // A checkpoint is a quiescent point (§7.3): no page code is on the stack
    // and the macrotask's microtasks have drained. A range starts here only
    // when no instrumented frame is suspended across it either (§12); when
    // one is, emission stays off and the runner widens the range to an
    // earlier checkpoint where none was.
    if (emitFrom !== undefined && r.seq === emitFrom) {
      if (openFrames === 0) status.emitting = true;
      else status.fromNotQuiescent = true;
    }
    at++;
  };

  const inject = (
    input: RecordOf<"Input">,
    effects: RecordOf<"DomEffect">[],
  ) => {
    let injector:
      | ((i: RecordOf<"Input">, e: RecordOf<"DomEffect">[]) => string)
      | undefined;
    if (level === 1) {
      const hooks = (
        w as unknown as Record<string, { replay?: Partial<ReplayHooks> }>
      )[PROTOCOL_GLOBAL]?.replay;
      if (typeof hooks?.inject === "function") {
        injector = (i, e) => hooks.inject!(i, e);
      }
    } else {
      const shim = (w as unknown as Record<string, ShimReplayControl>)[
        SHIM_GLOBAL
      ];
      if (shim?.mode === "replay" && typeof shim.inject === "function") {
        injector = (i, e) => shim.inject(i, e);
      }
    }
    if (injector === undefined) {
      fail(
        "InjectionFailed",
        level === 1
          ? "the framework installed no __ctBoundaryProtocol.replay.inject"
          : "the generic shim is not installed in replay mode",
        describeRecord(input),
        "",
        input.seq.toString(),
      );
    }
    let result = "ok";
    injecting = level === 1 ? input.type : undefined;
    try {
      runPage(() => {
        result = injector!(input, effects);
      });
    } finally {
      injecting = undefined;
    }
    guard();
    if (result !== "ok") {
      fail(
        "InjectionFailed",
        `the input could not be injected: ${result}`,
        describeRecord(input),
        "",
        input.seq.toString(),
      );
    }
    status.injections++;
  };

  /**
   * What one scheduler step did at a quiescent point: the replay `ended`;
   * it `ran` page code (wait for the page to be quiescent again); it took a
   * record that runs none (`next`: take the next one now); or the document
   * has to move on first (`wait` for it).
   */
  type Step = "ended" | "ran" | "next" | "wait";

  const step = (): Step => {
    const r = current();
    status.cursor = seqText(r);
    if (r === undefined || r.record === "End") return "ended";
    terminal(r);
    switch (r.record) {
      case "Loading":
        return atLoading(r);
      case "DocTask":
        return letDocTaskGo(r);
      case "Checkpoint":
        compareCheckpoint(r);
        if (emitTo !== undefined && r.seq >= emitTo && openFrames === 0) {
          // The range's end (§12): the first checkpoint at or after `to`
          // with no instrumented frame open, so every call the trace entered
          // has returned; the trace stops here, and the replay with it.
          status.emitting = false;
          status.stoppedAt = r.seq.toString();
          return "ended";
        }
        return "next";
      case "DomEffect":
        pendingEffects.push(r);
        at++;
        return "next";
      case "Navigation":
        if (r.kind === 5) {
          // The document unloaded (pagehide); the session ends here.
          at++;
          return "next";
        }
        break;
      case "Error":
        fail(
          "ErrorMismatch",
          `the log has the page raise ${JSON.stringify(r.message)} here; the replay raised no such error`,
        );
        break;
      case "Scrubbed":
        fail(
          "NonReplayable",
          "a Scrubbed record (a sensitive value replaced in the browser) is not replayed by this runner version",
        );
        break;
      case "Task":
        runTask(r);
        return "ran";
      case "PlatformValue": {
        // A MutationObserver's records whose microtask the replay's own
        // loading did not reach where the visitor's did (the elements the
        // parser inserted are delivered at whatever microtask checkpoint
        // comes next): delivered now, at the position the log has.
        const deliver =
          r.src === 3 && r.query === "callback"
            ? valueDue.get(r.task_id)
            : undefined;
        if (deliver !== undefined) {
          status.tasks++;
          runPage(deliver);
          return "ran";
        }
        break;
      }
      default:
        break;
    }
    // A read the page has not made while it is quiescent: page code the
    // document has yet to run makes it (a parser-inserted script, a script
    // the runner holds), or nobody does.
    return moveDocumentOn(undefined);
  };

  /**
   * The `Loading` record at the cursor: the records after it ran when the
   * document was at this position. Take it once the replayed document is
   * there; while it parses, only when the parser is held there, so that it
   * stays there while those records are replayed.
   */
  const atLoading = (r: RecordOf<"Loading">): Step => {
    const q = progress.position();
    if (q === undefined) {
      fail(
        "TaskOrderMismatch",
        "the log has the document still loading here, but the replayed document has loaded",
        describePosition(r),
        describePosition(q),
      );
    }
    if (samePosition(q!, r)) {
      if (r.phase === 1 && !parserHeld()) return "wait";
      at++;
      return "next";
    }
    if (q!.phase > r.phase) {
      fail(
        "TaskOrderMismatch",
        "the replayed document is past the point of its loading where the log has the next task run",
        describePosition(r),
        describePosition(q),
      );
    }
    return moveDocumentOn(r);
  };

  /** Start task `id`'s platform work now; `false` if it has none to start. */
  const startTask = (id: bigint): boolean => {
    const start = starters.get(id);
    if (start === undefined || started.has(id)) return false;
    started.add(id);
    status.tasks++;
    runPage(() => start());
    return true;
  };

  /**
   * The page work the scheduler holds back that the records at the cursor
   * belong to (§6): the reads (or the position, `atLoading`) of the script
   * whose `DocTask` 4 follows them, or of the task whose `Task` follows them
   * and whose platform work the scheduler starts (a dynamic `import()`, whose
   * module evaluates, making its reads and changing the document, before the
   * import settles).
   */
  type HeldWork = { script: string } | { task: bigint } | undefined;
  const workAfter = (from: number): HeldWork => {
    const after = (r: BoundaryRecord | undefined): HeldWork => {
      if (r?.record === "DocTask") {
        return r.kind === 4 ? { script: r.src } : undefined;
      }
      if (r?.record === "Task") {
        return starters.has(r.task_id) && !started.has(r.task_id)
          ? { task: r.task_id }
          : undefined;
      }
      return undefined;
    };
    for (let i = skipMarks(from); i < records.length; i = skipMarks(i + 1)) {
      const r = records[i];
      switch (r.record) {
        case "Loading":
          return after(records[skipMarks(i + 1)]);
        case "DocTask":
        case "Task":
          return after(r);
        case "Input":
        case "DomEffect":
        case "Checkpoint":
        case "Navigation":
        case "End":
        case "Gap":
        case "Refusal":
        case "Error":
        case "Scrubbed":
          return undefined;
        default:
          break;
      }
    }
    return undefined;
  };

  /** The `DocTask` at the cursor: let the document run that task. */
  const letDocTaskGo = (r: RecordOf<"DocTask">): Step => {
    at++;
    if (r.kind === 5) {
      const early = earlyEvents.findIndex(
        (e) => e.target === r.target && e.event === r.event,
      );
      if (r.src === "" || early >= 0) {
        // A media element's event, or one the platform dispatched early:
        // a stand-in, now.
        if (early >= 0) earlyEvents.splice(early, 1);
        const el = resourceElement(r.target);
        if (el === undefined) {
          fail(
            "TaskOrderMismatch",
            `the log has ${r.target} dispatch ${r.event} here, but the replayed page has no such element`,
          );
        }
        status.tasks++;
        runPage(() => standIn(el!, new w.Event(r.event)));
        return "ran";
      }
      awaiting = { kind: "resource", target: r.target, event: r.event };
      letGo(`resource:${r.src}`);
      return "wait";
    }
    if (r.kind === 1 || r.kind === 4) {
      awaiting = { kind: "script", src: r.src, takeAtSettle: false };
      openScript(r.src);
      // A parser-inserted script the parser has not reached yet: the parser
      // must get to it, past the gate it waits at.
      const inDocument = progress
        .pendingScripts()
        .some((s) => progress.srcOf(s) === r.src);
      if (!inDocument) openGate();
      return "wait";
    }
    // An event the replayed document already dispatched cannot come again.
    if (r.kind === 2 ? progress.domContentLoadedFired : progress.complete) {
      fail(
        "TaskOrderMismatch",
        `the log has the document dispatch ${r.kind === 2 ? "DOMContentLoaded" : "load"} here; the replayed document already did`,
      );
    }
    if (r.kind === 2) {
      awaiting = { kind: "domContentLoaded" };
      if (dclHeld) letGo("dcl");
      dclHeld = false;
      return "wait";
    }
    awaiting = { kind: "load" };
    if (loadHeld) letGo("load");
    loadHeld = false;
    return "wait";
  };

  /**
   * The page is quiescent and the record at the cursor (a read, or the
   * `Loading` `target`) needs the document to move on: let the parser past
   * its gate, or let the script go whose reads these are. While the
   * document can move on by itself (the parser runs, a script arrives),
   * wait; when nothing the scheduler holds back can make it, diverge.
   */
  const moveDocumentOn = (target: RecordOf<"Loading"> | undefined): Step => {
    // The reads at the cursor (or the position the `Loading` there names)
    // are those of held page work: a task whose platform work the scheduler
    // starts runs without the parser, so it goes first.
    const work = workAfter(target === undefined ? at : at + 1);
    if (work !== undefined && "task" in work && startTask(work.task)) {
      return "ran";
    }
    if (gateHeld !== undefined) {
      openGate();
      return "wait";
    }
    // The parser moves on by itself: what it runs next (an inline script)
    // may be what makes the read.
    if (progress.state === "loading" && !parserHeld()) return "wait";
    // Everything else is held: the reads, or the position, are those of
    // the script whose `DocTask` (kind 4) follows them, if one does. Its
    // `Loading` was measured when it settled, so it counts what the
    // script inserted: let it go, and take the `Loading` with its `DocTask`
    // when it settles (`takeDocTask` checks the position then).
    if (
      work !== undefined &&
      "script" in work &&
      (heldScripts.get(work.script) ?? 0) > 0
    ) {
      awaiting = { kind: "script", src: work.script, takeAtSettle: true };
      openScript(work.script);
      return "wait";
    }
    const stuck = (why: string): never =>
      target === undefined
        ? fail(
            "MissingRead",
            `the page is quiescent but the log's next record is a read the replay did not make: ${why}`,
            undefined,
            "the page is quiescent",
          )
        : fail(
            "TaskOrderMismatch",
            `the replayed document cannot reach the position where the log has the next task run: ${why}`,
            describePosition(target),
            describePosition(progress.position()),
          );
    if (progress.complete) return stuck("the document has loaded");
    if (progress.state === "loading") {
      return stuck("the parser waits for a script the log runs later");
    }
    const unheld = progress.pendingScripts().some((s) => !heldByRunner(s));
    if (!unheld && (!progress.domContentLoadedFired ? dclHeld : loadHeld)) {
      return stuck(
        `the document waits for ${progress.domContentLoadedFired ? "load" : "DOMContentLoaded"}, which the log has later`,
      );
    }
    return "wait";
  };

  const runTask = (task: RecordOf<"Task">): void => {
    const id = task.task_id;
    if (task.kind === INPUT_TASK) {
      at++;
      const effects = pendingEffects;
      pendingEffects = [];
      const r = current();
      if (r?.record !== "Input" || r.task_id !== id) {
        terminal(r);
        fail("MissingRead", `input task ${id} is not followed by its Input`);
      }
      at++;
      status.tasks++;
      inject(r as RecordOf<"Input">, effects);
      return;
    }
    const kind = registered.get(id);
    if (kind === undefined) {
      const claim = unregistered.get(task.kind);
      if (claim === undefined) {
        fail(
          "TaskOrderMismatch",
          `task ${id} (kind ${task.kind}) comes due, but the page never registered it`,
        );
      }
      at++;
      status.tasks++;
      runPage(() => claim!(task));
      return;
    }
    if (kind !== task.kind) {
      fail(
        "TaskOrderMismatch",
        `task ${id} comes due as kind ${task.kind}, but the page registered it as kind ${kind}`,
      );
    }
    const run = handlers.get(id);
    if (run === undefined) {
      fail(
        "TaskOrderMismatch",
        `task ${id} (kind ${task.kind}) comes due, but the page cancelled it or nothing waits for it`,
      );
    }
    at++;
    status.tasks++;
    runPage(() => run!(task));
  };

  /**
   * Resolve once the page is quiescent: every microtask queued so far has
   * run. Two message-channel turns rather than timers, which Chromium
   * clamps when nested.
   */
  const channel = new w.MessageChannel();
  const waiting: (() => void)[] = [];
  channel.port1.onmessage = () => waiting.shift()?.();
  const turn = () =>
    new OrigPromise<void>((resolve) => {
      waiting.push(resolve);
      channel.port2.postMessage(0);
    });
  const quiesce = async () => {
    await turn();
    await turn();
  };

  /**
   * Resolve when the document moves on (a gate is reached, a script
   * settles, `DOMContentLoaded`, `load`, a `readyState` change), or after a
   * short while, since the parser also moves on with no event to say so.
   * Waking early is harmless: the scheduler looks again and decides from
   * the document's state, never from how long it waited.
   */
  const documentMoved = () =>
    new OrigPromise<void>((resolve) => {
      wake = resolve;
      orig.setTimeout.call(w, kick, 10);
    });

  const schedule = async () => {
    if (failed === undefined) status.state = "running";
    for (;;) {
      await quiesce();
      if (failed !== undefined) return;
      if (awaiting !== undefined) {
        // A document task the scheduler let go has not run yet.
        await documentMoved();
        continue;
      }
      // Records that run no page code (checkpoints, effects, positions) are
      // taken in a row; the page is waited for again only after it ran.
      let outcome: Step;
      for (;;) {
        try {
          outcome = step();
        } catch (e) {
          if (!(e instanceof Divergence)) {
            fail("MissingRead", `the scheduler failed: ${String(e)}`);
          }
          return;
        }
        if (failed !== undefined) return;
        if (outcome !== "next") break;
      }
      if (outcome === "ended") {
        status.state = "done";
        return;
      }
      if (outcome === "wait") await documentMoved();
      const underway = taskUnderway;
      if (underway !== undefined) {
        // The task's page code waits on the platform: it is over when that
        // settles (a handler that returned a promise, §9.7).
        taskUnderway = undefined;
        await new OrigPromise<void>((resolve) =>
          underway.then(resolve, () => resolve()),
        );
      }
    }
  };

  /** A parser gate (see {@link CtReplay.gate}). */
  const gate = (): void => {
    removeGates();
    kick();
    if (failed !== undefined || gateHeld !== undefined) return;
    if (progress.state !== "loading") return;
    const r = current();
    if (r?.record !== "Loading" || r.phase !== 1) return;
    const q = progress.position();
    if (q === undefined || !samePosition(q, r)) return;
    // Hold the parser here: a parser-blocking script the runner answers
    // only when the scheduler lets it (HTML, "document.write()": a script
    // written by a parser-inserted script is parser-inserted, and blocks).
    const n = gates + 1;
    try {
      documentWrite.call(
        doc,
        `<script ${GATE_MARKER} src="${w.location.origin}${GATE_PATH}gate/${n}"></script>`,
      );
    } catch (e) {
      // The page's Trusted Types policy (`require-trusted-types-for`)
      // refuses a string to `document.write`: the replay cannot hold the
      // document here. A typed divergence, never an exception into the
      // page (the gate is a script of the document).
      removeGates();
      try {
        fail(
          "NonReplayable",
          `the replay cannot hold the document's loading where the log has the next task run: document.write refused the gate (${String(e)})`,
        );
      } catch {
        // Latched; the scheduler reports it.
      }
      kick();
      return;
    }
    gates = n;
    gateHeld = n;
    // The written script is in the document now, and the parser waits for
    // it whether it stays there or not (HTML, "the pending parsing-blocking
    // script"); out of the document, the page's code cannot see it.
    removeGates();
  };

  /**
   * Take every gate script out of the document: the inline gate running
   * now, a gate it wrote, the `DOMContentLoaded` and `load` gates (which
   * still run, and still hold their events, out of the document). So the
   * page's own code never meets one.
   */
  const removeGates = (): void => {
    const scripts = doc.getElementsByTagName("script");
    for (let i = scripts.length - 1; i >= 0; i--) {
      const s = scripts[i];
      if (s.hasAttribute(GATE_MARKER)) removeElement.call(s);
    }
  };

  /** See {@link CtReplayRunner.gateTrace}. */
  const gateTrace = (ct: CtRuntime): void => {
    const counted: [string, keyof TracePosition | undefined][] = [
      ["step", "steps"],
      ["write", "steps"],
      ["enter", "calls"],
      ["ret", "returns"],
      ["value", undefined],
      ["markCorrelation", undefined],
    ];
    for (const [name, counter] of counted) {
      const f = ct[name];
      if (typeof f !== "function") continue;
      const passThrough = name === "ret";
      // The frames open, tracked whether emission is on or not: they decide
      // where a range may be bounded (§12).
      const frames = name === "enter" ? 1 : name === "ret" ? -1 : 0;
      ct[name] = function gated(this: unknown, ...args: unknown[]): unknown {
        openFrames += frames;
        if (!status.emitting) return passThrough ? args[1] : undefined;
        if (counter !== undefined) status.trace[counter]++;
        return (f as (...a: unknown[]) => unknown).apply(ct, args);
      };
    }
  };

  const replay: CtReplay & CtReplayRunner = {
    protocol: 1,
    level,
    header,
    env,
    next,
    peek: () => peekAt(0),
    peekAt,
    registerTask(taskId, kind, delayMs) {
      const id = BigInt(taskId);
      next("TaskReg", { task_id: id, kind, delay_ms: delayMs });
      registered.set(id, kind);
    },
    onTask(taskId, run) {
      handlers.set(BigInt(taskId), run);
    },
    offTask(taskId) {
      handlers.delete(BigInt(taskId));
    },
    onUnregisteredTask(kind, run) {
      unregistered.set(kind, run);
    },
    onTaskStart(taskId, start) {
      starters.set(BigInt(taskId), start);
    },
    onValueDue(taskId, run) {
      valueDue.set(BigInt(taskId), run);
    },
    takePosition() {
      guard();
      const r = current();
      if (r?.record !== "Loading") return true;
      const q = progress.position();
      if (q === undefined || !samePosition(q, r)) return false;
      at++;
      return true;
    },
    useStandIns(dispatch) {
      standIn = dispatch;
    },
    takeDueTask(taskId) {
      if (failed !== undefined) return false;
      const i = skipMarks(at);
      const loading = records[i];
      if (loading?.record !== "Loading") return false;
      const q = progress.position();
      if (q === undefined || !samePosition(q, loading)) return false;
      const j = skipMarks(i + 1);
      const task = records[j];
      const id = BigInt(taskId);
      if (task?.record !== "Task" || task.task_id !== id) return false;
      if (registered.get(id) !== task.kind) return false;
      at = j + 1;
      status.tasks++;
      return true;
    },
    /**
     * Whether a script element of the document that has not settled was
     * fetched from `url` (no fragment): the runner asks it of a script
     * request the log has no execution of, to tell a script the page
     * inserted (which never ran during the session, so it is held) from a
     * module's dependency or a dynamic import's module (answered).
     */
    pendingScriptElement(url) {
      return progress.pendingScripts().some((s) => progress.srcOf(s) === url);
    },
    checkpointDue: () => current()?.record === "Checkpoint",
    gateTrace,
    gate,
    fail,
    get failed() {
      return failed;
    },
    originals: orig,
    status: () => ({
      ...status,
      state: failed !== undefined ? "diverged" : status.state,
      cursor: seqText(current()),
      waiting:
        `at ${describeRecord(current())}; the document at ${describePosition(progress.position())}` +
        (gateHeld === undefined ? "" : `, held at gate ${gateHeld}`) +
        (awaiting === undefined
          ? ""
          : `, waiting for ${JSON.stringify(awaiting)}`),
      dispatchedDuringInject: status.dispatchedDuringInject.slice(),
      pageErrors: status.pageErrors.slice(),
      trace: { ...status.trace },
      checkpointTrace: status.checkpointTrace.slice(),
    }),
  };
  Object.defineProperty(w, REPLAY_GLOBAL, {
    value: replay,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  void schedule();
  return replay;
}

/** The entry point of the in-page bundle: read the config and install. */
export function installFromConfig(): void {
  const w = globalThis as unknown as Window & typeof globalThis;
  const config = (w as unknown as Record<string, ReplayConfig | undefined>)[
    REPLAY_CONFIG_GLOBAL
  ];
  if (config === undefined) {
    throw new Error(`${REPLAY_CONFIG_GLOBAL} is not set`);
  }
  installReplayRuntime(w, config);
}

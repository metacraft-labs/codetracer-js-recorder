/**
 * Replay of clocks, random sources, timers, animation frames, idle
 * callbacks and observers (CodeTracer's JS-Boundary-Recording
 * specification §5.2 `Clock`, `Random`, `TaskReg`, `Task`; §6; §10.1).
 *
 * Every value comes from the log through `__ctReplay.next`; no platform
 * clock or random source is read. Timers never reach the platform: a
 * registration is matched against the log's `TaskReg` and its callback
 * runs when the runner's scheduler releases its `Task` (§6, "Time": a
 * delay has no effect except through its `Task` record).
 */

import { REPLAY_GATE_MARKER } from "../document-progress.js";
import { asConstructor, replaceAccessor, replaceValue } from "../context.js";
import { ClockSrc, TaskKind } from "../recorder.js";
import { UNRECORDABLE_TIMER_HANDLER } from "../seams-time.js";
import { type ReplayContext, bitsToNumber, utf8Text } from "./context.js";

/** Replace every seam this module owns. */
export function replayTimeSeams(ctx: ReplayContext): void {
  replayClocks(ctx);
  replayRandom(ctx);
  replayTimers(ctx);
  replayObservers(ctx);
}

function replayClocks({ w, replay, orig }: ReplayContext): void {
  const OrigDate = orig.Date;
  const clock = (src: number): number =>
    bitsToNumber(replay.next("Clock", { src }).bits);

  const now = function now(): number {
    return clock(ClockSrc.dateNow);
  };
  // `new Date()` and `Date()` read the clock (src 3); `new Date(x)` does not.
  const PatchedDate = function Date(
    this: unknown,
    ...args: unknown[]
  ): unknown {
    if (new.target === undefined) {
      return new OrigDate(clock(ClockSrc.newDate)).toString();
    }
    if (args.length === 0) {
      return Reflect.construct(OrigDate, [clock(ClockSrc.newDate)], new.target);
    }
    return Reflect.construct(OrigDate, args, new.target);
  };
  asConstructor(PatchedDate, OrigDate);
  replaceValue(PatchedDate, "now", now);
  replaceValue(OrigDate.prototype, "constructor", PatchedDate);
  replaceValue(w, "Date", PatchedDate);

  replaceValue(w.performance, "now", function now(): number {
    return clock(ClockSrc.performanceNow);
  });

  const stamp = orig.eventTimeStamp;
  if (stamp !== undefined) {
    replaceAccessor(
      stamp.owner,
      "timeStamp",
      function timeStamp() {
        return clock(ClockSrc.eventTimeStamp);
      },
      stamp.descriptor.set,
    );
  }
}

function replayRandom({ w, replay, orig }: ReplayContext): void {
  replaceValue(w.Math, "random", function random(): number {
    const r = replay.next("Random", { src: 1 });
    if (r.bytes.length !== 8) {
      replay.fail(
        "ArgumentMismatch",
        `Math.random's Random record holds ${r.bytes.length} bytes, not 8`,
      );
    }
    return new DataView(
      r.bytes.buffer,
      r.bytes.byteOffset,
      r.bytes.byteLength,
    ).getFloat64(0, true);
  });

  const origGrv = orig.getRandomValues;
  replaceValue(w.Crypto.prototype, "getRandomValues", function getRandomValues<
    T extends ArrayBufferView | null,
  >(this: Crypto, array: T): T {
    // The platform validates the view (type, quota) and throws as before;
    // what it fills is then overwritten with the logged bytes.
    const out = origGrv.call(this, array as never) as T;
    const view = array as unknown as ArrayBufferView;
    const r = replay.next("Random", { src: 2 });
    if (r.bytes.length !== view.byteLength) {
      replay.fail(
        "ArgumentMismatch",
        `crypto.getRandomValues filled ${r.bytes.length} bytes on record and is asked for ${view.byteLength}`,
      );
    }
    new Uint8Array(view.buffer, view.byteOffset, view.byteLength).set(r.bytes);
    return out;
  });

  if (orig.randomUUID !== undefined) {
    replaceValue(w.Crypto.prototype, "randomUUID", function randomUUID() {
      return utf8Text(replay.next("Random", { src: 3 }).bytes);
    });
  }
}

function delayOf(timeout: unknown): number {
  const d = Number(timeout);
  return Number.isFinite(d) ? d : 0;
}

function replayTimers(ctx: ReplayContext): void {
  const { w, replay } = ctx;
  /** The page's handle of each live task, and back. */
  const taskOf = new Map<number, bigint>();

  const cancel = (handle: unknown): void => {
    const id = taskOf.get(Number(handle));
    if (id === undefined) return;
    taskOf.delete(Number(handle));
    replay.offTask(id);
  };

  const timer = (kind: number, name: string): Function => {
    const patched = function (
      this: unknown,
      handler: unknown,
      timeout?: unknown,
      ...args: unknown[]
    ): number {
      if (typeof handler !== "function") {
        // Recorded as non-replayable when the platform scheduled it (§7.5):
        // the log's Refusal is reached here.
        if (replay.peek().kind === "Refusal") {
          replay.next("Refusal", { feature: UNRECORDABLE_TIMER_HANDLER });
        }
        return 0;
      }
      const id = ctx.nextTaskId();
      replay.registerTask(id, kind, delayOf(timeout));
      const handle = Number(id);
      taskOf.set(handle, id);
      replay.onTask(id, () => {
        if (kind === TaskKind.timeout) cancel(handle);
        (handler as Function).apply(w, args);
      });
      return handle;
    };
    Object.defineProperty(patched, "name", { value: name });
    return patched;
  };
  replaceValue(w, "setTimeout", timer(TaskKind.timeout, "setTimeout"));
  replaceValue(w, "setInterval", timer(TaskKind.interval, "setInterval"));
  replaceValue(w, "clearTimeout", function clearTimeout(h?: number) {
    cancel(h);
  });
  replaceValue(w, "clearInterval", function clearInterval(h?: number) {
    cancel(h);
  });

  if (ctx.orig.requestAnimationFrame !== undefined) {
    replaceValue(
      w,
      "requestAnimationFrame",
      function requestAnimationFrame(cb: FrameRequestCallback): number {
        const id = ctx.nextTaskId();
        replay.registerTask(id, TaskKind.animationFrame, 0);
        const handle = Number(id);
        taskOf.set(handle, id);
        replay.onTask(id, () => {
          cancel(handle);
          const ts = bitsToNumber(
            replay.next("Clock", { src: ClockSrc.animationFrame }).bits,
          );
          cb.call(w, ts);
        });
        return handle;
      },
    );
    replaceValue(
      w,
      "cancelAnimationFrame",
      function cancelAnimationFrame(h: number) {
        cancel(h);
      },
    );
  }

  if (ctx.orig.requestIdleCallback !== undefined) {
    replaceValue(
      w,
      "requestIdleCallback",
      function requestIdleCallback(
        cb: IdleRequestCallback,
        options?: IdleRequestOptions,
      ): number {
        const id = ctx.nextTaskId();
        replay.registerTask(id, TaskKind.idle, delayOf(options?.timeout));
        const handle = Number(id);
        taskOf.set(handle, id);
        replay.onTask(id, () => {
          cancel(handle);
          // The deadline is not logged (§10.1 lists no read of it): an idle
          // period of zero is the value no recording contradicts.
          cb.call(w, { didTimeout: false, timeRemaining: () => 0 });
        });
        return handle;
      },
    );
    replaceValue(
      w,
      "cancelIdleCallback",
      function cancelIdleCallback(h: number) {
        cancel(h);
      },
    );
  }
  // queueMicrotask is not logged (§6): microtasks are deterministic once the
  // macrotask order is fixed, so it stays the platform's.
}

/**
 * `entries` (`MutationRecord`s) without the replay runner's own gate
 * scripts (`REPLAY_GATE_MARKER`, §6 "The document's own tasks"): the parser
 * inserting one, its text, its removal. The recorded page had none.
 */
function withoutGates(entries: unknown[]): unknown[] {
  const isGate = (n: Node | null): boolean =>
    n !== null &&
    n.nodeType === 1 &&
    (n as Element).hasAttribute(REPLAY_GATE_MARKER);
  return entries.filter((e) => {
    const r = e as MutationRecord;
    if (r.type !== "childList") return !isGate(r.target);
    if (isGate(r.target)) return false;
    const nodes = [...Array.from(r.addedNodes), ...Array.from(r.removedNodes)];
    return nodes.length === 0 || !nodes.every(isGate);
  });
}

/**
 * Observer callbacks are tasks (`TaskReg{kind 10}` at construction, a
 * `Task` per callback, §10.1). The platform observer is real, so
 * `observe` and `takeRecords` behave as they do; its own callback only
 * collects entries, and the page's runs when the scheduler releases its
 * `Task`, with what was collected (the entries' values are not logged).
 */
function replayObservers(ctx: ReplayContext): void {
  const { w, replay, orig } = ctx;
  const observer = (name: string, Orig: Function | undefined): void => {
    if (Orig === undefined) return;
    const Patched = function (
      this: unknown,
      callback: Function,
      ...rest: unknown[]
    ): object {
      if (new.target === undefined) {
        return (Orig as unknown as (...a: unknown[]) => object)(
          callback,
          ...rest,
        );
      }
      if (typeof callback !== "function") {
        return Reflect.construct(Orig, [callback, ...rest], new.target);
      }
      const id = ctx.nextTaskId();
      const collected: unknown[] = [];
      const o = Reflect.construct(
        Orig,
        [(entries: unknown[]) => collected.push(...entries), ...rest],
        new.target,
      ) as { takeRecords?: () => unknown[] };
      replay.registerTask(id, 10, 0);
      replay.onTask(id, () => {
        const entries = collected.splice(0);
        if (name === "MutationObserver") {
          entries.push(
            ...(orig.MutationObserver!.prototype.takeRecords.call(
              o as MutationObserver,
            ) as unknown[]),
          );
        }
        callback.call(
          o,
          name === "MutationObserver" ? withoutGates(entries) : entries,
          o,
        );
      });
      return o;
    };
    asConstructor(Patched, Orig);
    replaceValue(w, name, Patched);
  };
  observer("IntersectionObserver", orig.IntersectionObserver);
  observer("ResizeObserver", orig.ResizeObserver);
  observer("MutationObserver", orig.MutationObserver);
}

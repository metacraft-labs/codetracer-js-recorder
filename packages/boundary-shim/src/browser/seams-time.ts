/**
 * Clocks, random sources, timers, animation frames, idle callbacks and
 * observers (JS-Boundary-Recording.md §5.2 `Clock`, `Random`, `TaskReg`,
 * `Task`; §6; §10.1).
 *
 * Every patched function performs exactly one call of the original it
 * replaces, so the page's reads reach the platform exactly as often as
 * without the shim, and logs after the call: a read the platform refuses
 * throws to the page as before and logs nothing.
 */

import {
  type SeamContext,
  asConstructor,
  copyBytes,
  replaceValue,
  utf8Bytes,
} from "./context.js";
import { ClockSrc, TaskKind, numberToBits } from "./recorder.js";

/** Patch every seam this module owns. */
export function patchTimeSeams(ctx: SeamContext): void {
  patchClocks(ctx);
  patchRandom(ctx);
  patchTimers(ctx);
  patchObservers(ctx);
}

function patchClocks({ w, rec, orig }: SeamContext): void {
  const OrigDate = orig.Date;
  const origNow = orig.dateNow;
  const logClock = (src: number, v: number) =>
    rec.guard(() => rec.emit("Clock", { src, bits: numberToBits(v) }));

  const now = function now(): number {
    const v = origNow.call(OrigDate);
    logClock(ClockSrc.dateNow, v);
    return v;
  };

  // `new Date()` and `Date()` read the clock; `new Date(x)` does not. The
  // clock value is taken from the constructed object rather than from
  // `Date.now`, so the read reaches the platform the way the page made it.
  const PatchedDate = function Date(
    this: unknown,
    ...args: unknown[]
  ): unknown {
    if (new.target === undefined) {
      const d = new OrigDate();
      logClock(ClockSrc.newDate, d.getTime());
      return d.toString();
    }
    if (args.length === 0) {
      const d = Reflect.construct(OrigDate, [], new.target) as Date;
      logClock(ClockSrc.newDate, d.getTime());
      return d;
    }
    return Reflect.construct(OrigDate, args, new.target);
  };
  asConstructor(PatchedDate, OrigDate);
  replaceValue(PatchedDate, "now", now);
  replaceValue(OrigDate.prototype, "constructor", PatchedDate);
  replaceValue(w, "Date", PatchedDate);

  const perf = w.performance;
  const origPerfNow = orig.performanceNow;
  replaceValue(perf, "now", function now(this: Performance): number {
    const v = origPerfNow.call(this);
    logClock(ClockSrc.performanceNow, v);
    return v;
  });
}

function patchRandom({ w, rec, orig }: SeamContext): void {
  const origRandom = orig.mathRandom;
  replaceValue(w.Math, "random", function random(): number {
    const v = origRandom.call(Math);
    // The value's eight IEEE-754 bytes, little-endian.
    rec.guard(() => {
      const b = new Uint8Array(8);
      new DataView(b.buffer).setFloat64(0, v, true);
      rec.emit("Random", { src: 1, bytes: b });
    });
    return v;
  });

  const origGrv = orig.getRandomValues;
  replaceValue(w.Crypto.prototype, "getRandomValues", function getRandomValues<
    T extends ArrayBufferView | null,
  >(this: Crypto, array: T): T {
    const r = origGrv.call(this, array as never) as T;
    rec.guard(() =>
      rec.emit("Random", {
        src: 2,
        bytes: copyBytes(array as ArrayBufferView),
      }),
    );
    return r;
  });

  const origUuid = orig.randomUUID;
  if (origUuid !== undefined) {
    replaceValue(
      w.Crypto.prototype,
      "randomUUID",
      function randomUUID(this: Crypto) {
        const v = origUuid.call(this);
        // The UUID's 36 characters as UTF-8.
        rec.guard(() => rec.emit("Random", { src: 3, bytes: utf8Bytes(v) }));
        return v;
      },
    );
  }
}

/** A timer handler as the page passed it; a string is evaluated globally. */
function callable(w: SeamContext["w"], handler: unknown): Function {
  if (typeof handler === "function") return handler;
  const code = String(handler);
  // Indirect eval runs in the global scope, as a string timer handler does.
  return () => (0, w.eval)(code);
}

function delayOf(timeout: unknown): number {
  const d = Number(timeout);
  return Number.isFinite(d) ? d : 0;
}

function patchTimers(ctx: SeamContext): void {
  const { w, rec, orig } = ctx;

  // setTimeout / setInterval: TaskReg at the call, Task before each run.
  const timer = (
    original: (...a: unknown[]) => unknown,
    kind: number,
    name: string,
  ): Function => {
    const patched = function (
      this: unknown,
      handler: unknown,
      timeout?: unknown,
      ...args: unknown[]
    ): unknown {
      if (!rec.recording) {
        return original.call(w, handler, timeout, ...args);
      }
      const taskId = rec.nextTaskId();
      const cb = callable(w, handler);
      const run = function (this: unknown, ...a: unknown[]): unknown {
        rec.guard(() => rec.task(taskId, kind));
        return cb.apply(this, a);
      };
      const handle = original.call(w, run, timeout, ...args);
      rec.guard(() =>
        rec.emit("TaskReg", {
          task_id: taskId,
          kind,
          delay_ms: delayOf(timeout),
        }),
      );
      return handle;
    };
    Object.defineProperty(patched, "name", { value: name });
    return patched;
  };
  replaceValue(
    w,
    "setTimeout",
    timer(
      orig.setTimeout as (...a: unknown[]) => unknown,
      TaskKind.timeout,
      "setTimeout",
    ),
  );
  replaceValue(
    w,
    "setInterval",
    timer(
      orig.setInterval as (...a: unknown[]) => unknown,
      TaskKind.interval,
      "setInterval",
    ),
  );

  // requestAnimationFrame: the frame timestamp is a clock read (Clock src 4).
  const origRaf = orig.requestAnimationFrame;
  if (origRaf !== undefined) {
    replaceValue(
      w,
      "requestAnimationFrame",
      function requestAnimationFrame(cb: FrameRequestCallback): number {
        if (!rec.recording) return origRaf.call(w, cb);
        const taskId = rec.nextTaskId();
        const run = function (this: unknown, ts: number): void {
          rec.guard(() => {
            rec.task(taskId, TaskKind.animationFrame);
            rec.emit("Clock", {
              src: ClockSrc.animationFrame,
              bits: numberToBits(ts),
            });
          });
          return cb.call(this, ts);
        };
        const handle = origRaf.call(w, run);
        rec.guard(() =>
          rec.emit("TaskReg", {
            task_id: taskId,
            kind: TaskKind.animationFrame,
            delay_ms: 0,
          }),
        );
        return handle;
      },
    );
  }

  const origIdle = orig.requestIdleCallback;
  if (origIdle !== undefined) {
    replaceValue(
      w,
      "requestIdleCallback",
      function requestIdleCallback(
        cb: IdleRequestCallback,
        options?: IdleRequestOptions,
      ): number {
        if (!rec.recording) return origIdle.call(w, cb, options);
        const taskId = rec.nextTaskId();
        const run = function (this: unknown, deadline: IdleDeadline): void {
          rec.guard(() => rec.task(taskId, TaskKind.idle));
          return cb.call(this, deadline);
        };
        const handle = origIdle.call(w, run, options);
        rec.guard(() =>
          rec.emit("TaskReg", {
            task_id: taskId,
            kind: TaskKind.idle,
            delay_ms: delayOf(options?.timeout),
          }),
        );
        return handle;
      },
    );
  }
  // clearTimeout, clearInterval, cancelAnimationFrame and queueMicrotask
  // are not patched in record mode: a cancelled task simply never has a
  // Task record, and microtasks are deterministic once the macrotask order
  // is fixed (§6). Replay mode owns them.
}

function patchObservers({ w, rec, orig }: SeamContext): void {
  const observer = (name: string, Orig: Function | undefined): void => {
    if (Orig === undefined) return;
    const Patched = function (
      this: unknown,
      callback: Function,
      ...rest: unknown[]
    ): object {
      if (new.target === undefined) {
        // Calling an observer constructor without `new` throws; keep that.
        return (Orig as unknown as (...a: unknown[]) => object)(
          callback,
          ...rest,
        );
      }
      if (!rec.recording || typeof callback !== "function") {
        return Reflect.construct(Orig, [callback, ...rest], new.target);
      }
      const taskId = rec.nextTaskId();
      const run = function (this: unknown, ...a: unknown[]): unknown {
        rec.guard(() => rec.task(taskId, TaskKind.observer));
        return callback.apply(this, a);
      };
      const o = Reflect.construct(Orig, [run, ...rest], new.target);
      rec.guard(() =>
        rec.emit("TaskReg", {
          task_id: taskId,
          kind: TaskKind.observer,
          delay_ms: 0,
        }),
      );
      return o;
    };
    asConstructor(Patched, Orig);
    replaceValue(w, name, Patched);
  };
  observer("IntersectionObserver", orig.IntersectionObserver);
  observer("ResizeObserver", orig.ResizeObserver);
  observer("MutationObserver", orig.MutationObserver);
}

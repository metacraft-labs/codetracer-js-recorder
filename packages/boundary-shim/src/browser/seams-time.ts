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
  replaceAccessor,
  replaceValue,
  utf8Bytes,
} from "./context.js";
import { PLATFORM_VALUE_SRC } from "@codetracer/boundary-format";

import {
  intersectionEntryJson,
  mutationRecordJson,
  performanceEntriesJson,
  resizeEntryJson,
} from "./entries.js";
import { ClockSrc, TaskKind, numberToBits } from "./recorder.js";

/**
 * The `Refusal.feature` of a timer handler that is not a function
 * (JS-Boundary-Recording.md §7.5).
 */
export const UNRECORDABLE_TIMER_HANDLER = "unrecordable-timer-handler";

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

  // An event's timeStamp is a monotonic clock read the page makes, of an
  // event the browser dispatched or of one the page constructed (§5.2
  // `Clock` src 5). The shim itself never reads it.
  const stamp = orig.eventTimeStamp;
  if (stamp !== undefined) {
    const get = stamp.descriptor.get!;
    replaceAccessor(
      stamp.owner,
      "timeStamp",
      function timeStamp(this: unknown) {
        const v = get.call(this) as number;
        logClock(ClockSrc.eventTimeStamp, v);
        return v;
      },
      stamp.descriptor.set,
    );
  }
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

/**
 * An idle callback's deadline (HTML, "IdleDeadline"): `timeRemaining()` is a
 * clock read (`Clock` src 6), each call, and `didTimeout` a
 * `PlatformValue` (src 6, the callback's task id): both depend on how busy
 * the machine was.
 */
function patchIdleDeadline(
  { w, rec }: SeamContext,
  deadlines: WeakMap<object, bigint>,
): void {
  const proto = (
    w as unknown as { IdleDeadline?: { prototype: Record<string, unknown> } }
  ).IdleDeadline?.prototype;
  if (proto === undefined) return;
  const origRemaining = proto.timeRemaining as (() => number) | undefined;
  if (typeof origRemaining === "function") {
    replaceValue(proto, "timeRemaining", function timeRemaining(this: object) {
      const v = origRemaining.call(this);
      rec.guard(() =>
        rec.emit("Clock", {
          src: ClockSrc.idleTimeRemaining,
          bits: numberToBits(v),
        }),
      );
      return v;
    });
  }
  const d = Object.getOwnPropertyDescriptor(proto, "didTimeout");
  if (d?.get !== undefined) {
    const get = d.get;
    replaceAccessor(
      proto,
      "didTimeout",
      function (this: unknown) {
        const v = get.call(this) as boolean;
        rec.guard(() =>
          rec.emit("PlatformValue", {
            src: PLATFORM_VALUE_SRC.idleDeadline,
            task_id: deadlines.get(this as object) ?? 0n,
            query: "didTimeout",
            value: JSON.stringify(v),
          }),
        );
        return v;
      },
      d.set,
    );
  }
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
      if (typeof handler !== "function") {
        // A string (or a value the platform converts to one, or a
        // TrustedScript) is compiled by the platform as a classic script in
        // the global scope when the timer fires, under the document's CSP
        // (HTML §8.6 "timer initialization steps"). Only the platform does
        // exactly that, so the handler goes to it unchanged; the shim then
        // has no code of its own that runs first and cannot write the
        // Task, so a timer that was scheduled makes the session
        // non-replayable from here (§7.5). A handle of 0 is a timer the
        // platform refused to create (Chromium, when the CSP forbids
        // compiling strings): nothing will run.
        const handle = original.call(w, handler, timeout, ...args);
        if (handle !== 0) {
          ctx.refuseOnce(
            UNRECORDABLE_TIMER_HANDLER,
            `${name} ${typeof handler}`,
          );
        }
        return handle;
      }
      const taskId = rec.nextTaskId();
      const cb = handler;
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
  // Each idle callback's deadline -> the callback's task id (§5.2:
  // `PlatformValue` src 6 names the task whose deadline was read).
  const deadlines = new WeakMap<object, bigint>();
  patchIdleDeadline(ctx, deadlines);
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
          deadlines.set(deadline, taskId);
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

/**
 * How each observer's callback arguments are written (§5.2
 * `PlatformValue`): its `src`, the JSON of the list it hands the page, and
 * whether it has a `takeRecords()` that hands the page the same kind of
 * list.
 */
export const OBSERVERS: readonly {
  name:
    | "IntersectionObserver"
    | "ResizeObserver"
    | "MutationObserver"
    | "PerformanceObserver";
  src: number;
  takeRecords: boolean;
}[] = [
  {
    name: "IntersectionObserver",
    src: PLATFORM_VALUE_SRC.intersectionObserver,
    takeRecords: true,
  },
  {
    name: "ResizeObserver",
    src: PLATFORM_VALUE_SRC.resizeObserver,
    takeRecords: false,
  },
  {
    name: "MutationObserver",
    src: PLATFORM_VALUE_SRC.mutationObserver,
    takeRecords: true,
  },
  {
    name: "PerformanceObserver",
    src: PLATFORM_VALUE_SRC.performanceObserver,
    takeRecords: true,
  },
];

/**
 * The JSON of what observer `name` hands the page: its callback's
 * arguments (`args`) or the list `takeRecords()` returned (`list`).
 * A `PerformanceObserver` callback's value also carries the
 * `droppedEntriesCount` of its third argument, when it has one.
 */
export function observedJson(name: string, list: unknown, third?: unknown) {
  if (name === "PerformanceObserver") {
    const entries = Array.isArray(list)
      ? (list as PerformanceEntry[])
      : (list as PerformanceObserverEntryList).getEntries();
    const out: Record<string, unknown> = {
      entries: performanceEntriesJson(entries),
    };
    const dropped = (third as { droppedEntriesCount?: unknown } | undefined)
      ?.droppedEntriesCount;
    if (typeof dropped === "number") out.droppedEntriesCount = dropped;
    return JSON.stringify(out);
  }
  const items = Array.from(list as ArrayLike<unknown>);
  const json =
    name === "IntersectionObserver"
      ? items.map((e) => intersectionEntryJson(e as IntersectionObserverEntry))
      : name === "ResizeObserver"
        ? items.map((e) => resizeEntryJson(e as ResizeObserverEntry))
        : items.map((e) => mutationRecordJson(e as MutationRecord));
  return JSON.stringify(json);
}

/**
 * Observer callbacks are tasks (`TaskReg{kind 10}` at construction, a
 * `Task` per callback, §10.1), but for a `MutationObserver`'s, which are
 * microtasks of the platform's: its `TaskReg` names it, and each callback
 * writes the document's position while it loads (`Recorder.microtask`)
 * and no `Task`. What each hands the page is a `PlatformValue` (after its
 * `Task`, if it has one): the entries of an
 * `IntersectionObserver`, a `ResizeObserver` or a `PerformanceObserver`
 * (their layout and timing values depend on the machine), the records of a
 * `MutationObserver` (which replay compares with its own). A
 * `takeRecords()` call is a `PlatformValue` of its own (query
 * `takeRecords`).
 */
function patchObservers({ w, rec, orig }: SeamContext): void {
  for (const { name, src, takeRecords } of OBSERVERS) {
    const Orig = orig[name] as Function | undefined;
    if (Orig === undefined) continue;
    const tasks = new WeakMap<object, bigint>();
    const value = (taskId: bigint, query: string, json: string) =>
      rec.emit("PlatformValue", { src, task_id: taskId, query, value: json });
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
      // A MutationObserver's callback is a microtask of the platform's,
      // not a task (DOM, "notify mutation observers"): its value is
      // written where it runs, after the document's position, and replay
      // runs it as the platform's microtask too (§6, §10.1).
      const microtask = name === "MutationObserver";
      const run = function (this: unknown, ...a: unknown[]): unknown {
        rec.guard(() => {
          if (microtask) rec.microtask();
          else rec.task(taskId, TaskKind.observer);
          value(taskId, "callback", observedJson(name, a[0], a[2]));
        });
        return callback.apply(this, a);
      };
      const o = Reflect.construct(Orig, [run, ...rest], new.target) as object;
      tasks.set(o, taskId);
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
    if (!takeRecords) continue;
    const proto = (Orig as { prototype: Record<string, unknown> }).prototype;
    const origTake = proto.takeRecords as (() => unknown[]) | undefined;
    if (typeof origTake !== "function") continue;
    replaceValue(proto, "takeRecords", function takeRecords(this: object) {
      const list = origTake.call(this);
      const taskId = tasks.get(this);
      if (taskId !== undefined) {
        rec.guard(() => value(taskId, "takeRecords", observedJson(name, list)));
      }
      return list;
    });
  }
}

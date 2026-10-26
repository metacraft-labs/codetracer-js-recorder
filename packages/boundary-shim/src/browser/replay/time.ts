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

import { PLATFORM_VALUE_SRC } from "@codetracer/boundary-format";

import { REPLAY_GATE_MARKER } from "../document-progress.js";
import { asConstructor, replaceAccessor, replaceValue } from "../context.js";
import { ClockSrc, TaskKind } from "../recorder.js";
import {
  OBSERVERS,
  UNRECORDABLE_TIMER_HANDLER,
  observedJson,
} from "../seams-time.js";
import { inSensitiveField } from "../sensitive.js";
import { resolveTarget, targetOf } from "../targets.js";
import { performanceEntriesOf } from "./platform.js";
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

  // Each replayed deadline -> its idle callback's task id. `timeRemaining()`
  // is a clock read (`Clock` src 6) and `didTimeout` a `PlatformValue`
  // (src 6) of that task, as on record (seams-time.ts).
  const deadlines = new WeakMap<object, bigint>();
  const IdleDeadlineProto = (
    w as unknown as { IdleDeadline?: { prototype: Record<string, unknown> } }
  ).IdleDeadline?.prototype;
  if (IdleDeadlineProto !== undefined) {
    replaceValue(IdleDeadlineProto, "timeRemaining", function timeRemaining() {
      return bitsToNumber(
        replay.next("Clock", { src: ClockSrc.idleTimeRemaining }).bits,
      );
    });
    const d = Object.getOwnPropertyDescriptor(IdleDeadlineProto, "didTimeout");
    if (d?.get !== undefined) {
      replaceAccessor(
        IdleDeadlineProto,
        "didTimeout",
        function (this: unknown) {
          return JSON.parse(
            replay.next("PlatformValue", {
              src: PLATFORM_VALUE_SRC.idleDeadline,
              task_id: deadlines.get(this as object) ?? 0n,
              query: "didTimeout",
            }).value,
          ) as boolean;
        },
        d.set,
      );
    }
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
          // An IdleDeadline whose reads answer from the log (below).
          const deadline = Object.create(
            IdleDeadlineProto ?? Object.prototype,
          ) as IdleDeadline;
          deadlines.set(deadline, id);
          cb.call(w, deadline);
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
 * `Task` per callback, §10.1), and what each hands the page is the
 * `PlatformValue` after its `Task` (seams-time.ts). The platform observer
 * is real, so `observe` checks its arguments and the observed elements are
 * known; its own callback only collects. The page's runs when the scheduler
 * releases its `Task`, with the logged entries of an
 * `IntersectionObserver`, a `ResizeObserver` or a `PerformanceObserver`
 * rebuilt as objects of their interfaces. `takeRecords()` likewise.
 *
 * A `MutationObserver`'s callback is a microtask of the platform's (DOM,
 * "notify mutation observers"), with no `Task`: the page's DOM changes are
 * replayed, so the platform queues the same microtask at the same point, and
 * the page's callback runs in it, with the replay browser's own records once
 * they are shown to equal the logged ones (an `ArgumentMismatch`
 * otherwise), when the log's next value is that callback's, at the document
 * position before it (`takePosition`). The records of the elements the
 * parser inserts are delivered at whatever microtask checkpoint comes next,
 * which the replay's gates make come sooner: those are collected, and handed
 * to the page when the log's value comes due at a quiescent point
 * (`onValueDue`), at its position. The runner's gates are left out of
 * every record.
 */
function replayObservers(ctx: ReplayContext): void {
  const { w, replay, orig } = ctx;
  // The replay's own mutation records, holed as the recorder holed the
  // visitor's (`mutationRecordsJson`), so the two compare.
  const sensitive = (n: Node) => inSensitiveField(ctx.sensitive, n);
  for (const { name, src, takeRecords } of OBSERVERS) {
    const Orig = orig[name] as Function | undefined;
    if (Orig === undefined) continue;
    const proto = (Orig as { prototype: Record<string, unknown> }).prototype;
    const origTake = proto.takeRecords as
      | ((this: object) => unknown[])
      | undefined;
    const origObserve = proto.observe as (
      this: object,
      ...a: unknown[]
    ) => unknown;
    const tasks = new WeakMap<object, bigint>();
    /**
     * A MutationObserver's records the platform delivered that the page
     * has not been handed yet.
     */
    const pendingOf = new WeakMap<object, unknown[]>();
    // The elements each observer was asked to observe: what a logged
    // entry's target names.
    const observed = new WeakMap<object, Set<Element>>();
    /** The logged value of the observer's callback or `takeRecords()`. */
    const logged = (id: bigint, query: string, actual?: string) =>
      replay.next("PlatformValue", {
        src,
        task_id: id,
        query,
        ...(actual === undefined ? {} : { value: actual }),
      });
    /** The real records of a MutationObserver, without the runner's gates. */
    const realRecords = (o: object, collected: unknown[]) => {
      const all = [...collected, ...(origTake?.call(o) ?? [])];
      return withoutGates(all);
    };
    /** Rebuild logged entries of an IntersectionObserver or a ResizeObserver. */
    const entriesOf = (o: object, json: unknown): unknown[] =>
      (Array.isArray(json) ? json : []).map((j) =>
        observerEntryOf(ctx, name, j as Record<string, unknown>, (t) =>
          targetElement(ctx, observed.get(o), t),
        ),
      );

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
      /** A MutationObserver's records handed to the page, compared first. */
      const deliver = () => {
        const records = realRecords(o, collected.splice(0));
        logged(
          id,
          "callback",
          observedJson(name, records, undefined, sensitive),
        );
        callback.call(o, records, o);
      };
      /** Whether the log's next value is this observer's callback, now. */
      const dueNow = (): boolean => {
        try {
          const v = replay.peek();
          const next = v.kind === "Loading" ? replay.peekAt(1) : v;
          const r = next.record;
          return (
            r?.record === "PlatformValue" &&
            r.src === src &&
            r.query === "callback" &&
            r.task_id === id &&
            replay.takePosition()
          );
        } catch {
          // The replay has diverged; it is reported already.
          return false;
        }
      };
      const o = Reflect.construct(
        Orig,
        [
          (entries: unknown) => {
            if (name !== "MutationObserver") return;
            collected.push(...withoutGates(entries as unknown[]));
            if (collected.length > 0 && dueNow()) deliver();
          },
          ...rest,
        ],
        new.target,
      ) as object;
      tasks.set(o, id);
      observed.set(o, new Set());
      replay.registerTask(id, TaskKind.observer, 0);
      if (name === "MutationObserver") {
        pendingOf.set(o, collected);
        replay.onValueDue(id, deliver);
        return o;
      }
      replay.onTask(id, () => {
        const v = JSON.parse(logged(id, "callback").value) as unknown;
        if (name === "PerformanceObserver") {
          const pv = v as { entries?: unknown; droppedEntriesCount?: number };
          const list = performanceListOf(
            ctx,
            performanceEntriesOf(ctx, pv.entries),
          );
          if (pv.droppedEntriesCount === undefined) callback.call(o, list, o);
          else
            callback.call(o, list, o, {
              droppedEntriesCount: pv.droppedEntriesCount,
            });
          return;
        }
        callback.call(o, entriesOf(o, v), o);
      });
      return o;
    };
    asConstructor(Patched, Orig);
    replaceValue(w, name, Patched);
    if (typeof origObserve === "function" && name !== "PerformanceObserver") {
      replaceValue(
        proto,
        "observe",
        function observe(this: object, ...args: unknown[]) {
          const r = origObserve.apply(this, args);
          if (args[0] instanceof w.Element) observed.get(this)?.add(args[0]);
          return r;
        },
      );
    }
    const origDisconnect = proto.disconnect as
      | ((this: object) => unknown)
      | undefined;
    if (name === "MutationObserver" && typeof origDisconnect === "function") {
      // The platform drops the records it has not delivered; so are those it
      // delivered early to the replay that the page was not handed yet.
      replaceValue(proto, "disconnect", function disconnect(this: object) {
        pendingOf.get(this)?.splice(0);
        return origDisconnect.call(this);
      });
    }
    if (!takeRecords || typeof origTake !== "function") continue;
    replaceValue(proto, "takeRecords", function takeRecords(this: object) {
      const id = tasks.get(this);
      if (id === undefined) return origTake.call(this);
      if (name === "MutationObserver") {
        const records = realRecords(this, pendingOf.get(this)?.splice(0) ?? []);
        logged(
          id,
          "takeRecords",
          observedJson(name, records, undefined, sensitive),
        );
        return records;
      }
      origTake.call(this);
      const v = JSON.parse(logged(id, "takeRecords").value) as unknown;
      if (name === "PerformanceObserver") {
        return performanceEntriesOf(ctx, (v as { entries?: unknown }).entries);
      }
      return entriesOf(this, v);
    });
  }
}

/**
 * The element a logged entry's target names: among the elements the observer
 * observes (an element removed from the document is still observed there),
 * the one whose target string it is; else the document's (§10.2).
 */
function targetElement(
  ctx: ReplayContext,
  observed: Set<Element> | undefined,
  target: string,
): Element | null {
  const matches = [...(observed ?? [])].filter((e) => targetOf(e) === target);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    ctx.replay.fail(
      "ArgumentMismatch",
      `an observer entry's target ${target} names ${matches.length} observed elements`,
    );
  }
  const r = resolveTarget(target, ctx.w.document);
  return r instanceof ctx.w.Element ? r : null;
}

/** A logged IntersectionObserver or ResizeObserver entry, rebuilt. */
function observerEntryOf(
  ctx: ReplayContext,
  name: string,
  j: Record<string, unknown>,
  element: (target: string) => Element | null,
): object {
  const { w } = ctx;
  const g = w as unknown as Record<string, { prototype?: object } | undefined>;
  const rect = (r: unknown) => {
    if (r === null || r === undefined) return null;
    const v = r as { x: number; y: number; width: number; height: number };
    return w.DOMRectReadOnly.fromRect(v);
  };
  const sizes = (list: unknown) =>
    Object.freeze(
      (Array.isArray(list) ? list : []).map((s: Record<string, unknown>) => {
        const o = Object.create(
          g.ResizeObserverSize?.prototype ?? Object.prototype,
        ) as object;
        Object.defineProperties(o, {
          inlineSize: { value: s.inlineSize, enumerable: true },
          blockSize: { value: s.blockSize, enumerable: true },
        });
        return o;
      }),
    );
  const iface =
    name === "IntersectionObserver"
      ? "IntersectionObserverEntry"
      : "ResizeObserverEntry";
  const e = Object.create(g[iface]?.prototype ?? Object.prototype) as object;
  const props: Record<string, unknown> =
    name === "IntersectionObserver"
      ? {
          target: element(String(j.target)),
          time: j.time,
          rootBounds: rect(j.rootBounds),
          boundingClientRect: rect(j.boundingClientRect),
          intersectionRect: rect(j.intersectionRect),
          isIntersecting: j.isIntersecting,
          intersectionRatio: j.intersectionRatio,
          ...("isVisible" in j ? { isVisible: j.isVisible } : {}),
        }
      : {
          target: element(String(j.target)),
          contentRect: rect(j.contentRect),
          borderBoxSize: sizes(j.borderBoxSize),
          contentBoxSize: sizes(j.contentBoxSize),
          devicePixelContentBoxSize: sizes(j.devicePixelContentBoxSize),
        };
  for (const [k, v] of Object.entries(props)) {
    Object.defineProperty(e, k, { value: v, enumerable: true });
  }
  return e;
}

/**
 * A `PerformanceObserverEntryList` of `entries` (Performance Timeline,
 * "PerformanceObserverEntryList interface"): its three methods, filtering
 * as the platform's do, as own methods of an object of that interface.
 */
function performanceListOf(ctx: ReplayContext, entries: object[]): object {
  const g = ctx.w as unknown as Record<
    string,
    { prototype?: object } | undefined
  >;
  const list = Object.create(
    g.PerformanceObserverEntryList?.prototype ?? Object.prototype,
  ) as object;
  const field = (e: object, k: string) => (e as Record<string, unknown>)[k];
  Object.defineProperties(list, {
    getEntries: { value: () => [...entries] },
    getEntriesByType: {
      value: (type: unknown) =>
        entries.filter((e) => field(e, "entryType") === String(type)),
    },
    getEntriesByName: {
      value: (name: unknown, type?: unknown) =>
        entries.filter(
          (e) =>
            field(e, "name") === String(name) &&
            (type === undefined || field(e, "entryType") === String(type)),
        ),
    },
  });
  return list;
}

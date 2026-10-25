/**
 * Replay of platform tasks and of the performance timeline (CodeTracer's
 * JS-Boundary-Recording specification §5.2 `TaskReg`/`Task` kind 13,
 * `PlatformValue` src 5, `Clock` src 7; §6; §10.1; §10.5).
 *
 * A platform task (a whole-body read of a `Blob`, a `Request` or a
 * `Response` the page made, `crypto.subtle.digest`) runs on the replay
 * browser as on the visitor's, since its input is the page's own data; what
 * the log decides is when the page's continuation runs: the call is matched
 * against its `TaskReg`, and the promise the page holds settles only when the
 * scheduler releases the `Task`, after the platform's own result arrived
 * (the scheduler waits for it).
 *
 * The performance timeline is answered from the log entirely: the replay
 * browser's own entries are of another run (and list the runner's own
 * requests). Each entry is rebuilt as an object of its interface whose
 * attributes are own properties, with a `toJSON()` that returns what the
 * visitor's returned.
 */

import { PLATFORM_VALUE_SRC } from "@codetracer/boundary-format";

import { replaceAccessor, replaceValue } from "../context.js";
import { ENTRY_INTERFACES } from "../entries.js";
import { ClockSrc, TaskKind } from "../recorder.js";
import {
  PERFORMANCE_ATTRIBUTES,
  PERFORMANCE_METHODS,
  performanceQuery,
} from "../seams-perf.js";
import { BLOB_READS, BODY_READS, wrapMethod } from "../seams-platform.js";
import { resolveTarget } from "../targets.js";
import { type ReplayContext, bitsToNumber } from "./context.js";

/**
 * The page's promise for a platform task (§6, kind 13): registered now,
 * settled when the scheduler releases its `Task` and the platform's own
 * `settled` has settled, whichever is later.
 */
export function replayPlatformTask<T>(
  ctx: ReplayContext,
  settled: Promise<T>,
): Promise<T> {
  const { replay, orig } = ctx;
  const id = ctx.nextTaskId();
  replay.registerTask(id, TaskKind.platform, 0);
  return new orig.Promise<T>((resolve, reject) => {
    let outcome: (() => void) | undefined;
    let released = false;
    let done: (() => void) | undefined;
    const arrived = (go: () => void) => {
      outcome = go;
      if (!released && replay.takeDueTask(id)) {
        // Settled where the log has it, while the document loads (§6).
        replay.offTask(id);
        released = true;
        go();
        return;
      }
      if (released) {
        go();
        done?.();
      }
    };
    (orig.promiseThen as Promise<T>["then"]).call(
      settled,
      (v) => arrived(() => resolve(v)),
      (e: unknown) => arrived(() => reject(e)),
    );
    replay.onTask(id, () => {
      replay.offTask(id);
      released = true;
      if (outcome !== undefined) {
        outcome();
        return;
      }
      // The scheduler takes the next record once the page's continuation
      // has been let go (§9.7: a handler may return a promise).
      return new orig.Promise<void>((d) => {
        done = d;
      });
    });
  });
}

/** Replace every seam this module owns. */
export function replayPlatformSeams(ctx: ReplayContext): void {
  const { w } = ctx;
  const proto = (name: string) =>
    (w as unknown as Record<string, { prototype?: Record<string, unknown> }>)[
      name
    ]?.prototype;
  const task = (owner: Record<string, unknown> | undefined, name: string) =>
    wrapMethod(
      owner,
      name,
      (original) =>
        function (this: unknown, ...args: unknown[]) {
          return replayPlatformTask(
            ctx,
            original.apply(this, args) as Promise<unknown>,
          );
        },
    );
  for (const name of BLOB_READS) task(proto("Blob"), name);
  for (const name of BODY_READS) task(proto("Request"), name);
  task(proto("SubtleCrypto"), "digest");
  replayPerformance(ctx);
}

type Json = Record<string, unknown>;

/**
 * A performance entry rebuilt from its logged JSON (`entries.ts`): an object
 * of the entry type's interface whose attributes are own properties; the
 * nodes `toJSON()` leaves out resolved from their targets.
 */
export function performanceEntryOf(ctx: ReplayContext, json: Json): object {
  const { w } = ctx;
  const g = w as unknown as Record<string, { prototype?: object } | undefined>;
  const iface = ENTRY_INTERFACES[String(json.entryType)];
  const proto =
    (iface === undefined ? undefined : g[iface]?.prototype) ??
    g.PerformanceEntry?.prototype ??
    Object.prototype;
  const e = Object.create(proto) as Record<string, unknown>;
  const own = (k: string, v: unknown) =>
    Object.defineProperty(e, k, { value: v, enumerable: true });
  const visible: Json = {};
  for (const [k, v] of Object.entries(json)) {
    if (k.startsWith("ct:")) continue;
    visible[k] = v;
  }
  for (const [k, v] of Object.entries(visible)) {
    if (k === "sources" && Array.isArray(v)) {
      const nodes = (json["ct:sourceNodes"] as (string | null)[]) ?? [];
      own(
        k,
        Object.freeze(
          v.map((s: Json, i) => {
            const a = Object.create(
              g.LayoutShiftAttribution?.prototype ?? Object.prototype,
            ) as object;
            Object.defineProperties(a, {
              node: { value: nodeOf(ctx, nodes[i] ?? null), enumerable: true },
              previousRect: {
                value: rectOf(ctx, s.previousRect as Json),
                enumerable: true,
              },
              currentRect: {
                value: rectOf(ctx, s.currentRect as Json),
                enumerable: true,
              },
              toJSON: { value: () => s },
            });
            return a;
          }),
        ),
      );
    } else if (k === "serverTiming" && Array.isArray(v)) {
      own(
        k,
        Object.freeze(
          v.map((t: Json) => {
            const o = Object.create(
              g.PerformanceServerTiming?.prototype ?? Object.prototype,
            ) as object;
            for (const [tk, tv] of Object.entries(t)) {
              Object.defineProperty(o, tk, { value: tv, enumerable: true });
            }
            Object.defineProperty(o, "toJSON", { value: () => t });
            return o;
          }),
        ),
      );
    } else {
      own(k, v);
    }
  }
  if ("ct:element" in json) {
    own("element", nodeOf(ctx, json["ct:element"] as string | null));
  }
  Object.defineProperty(e, "toJSON", { value: () => ({ ...visible }) });
  return e;
}

function nodeOf(ctx: ReplayContext, target: string | null): unknown {
  return target === null ? null : resolveTarget(target, ctx.w.document);
}

function rectOf(ctx: ReplayContext, r: Json | null | undefined): unknown {
  if (r === null || r === undefined) return null;
  return ctx.w.DOMRectReadOnly.fromRect({
    x: Number(r.x),
    y: Number(r.y),
    width: Number(r.width),
    height: Number(r.height),
  });
}

/** A list of performance entries, rebuilt. */
export function performanceEntriesOf(
  ctx: ReplayContext,
  list: unknown,
): object[] {
  return Array.isArray(list)
    ? list.map((j) => performanceEntryOf(ctx, j as Json))
    : [];
}

function replayPerformance(ctx: ReplayContext): void {
  const { w, replay } = ctx;
  const Perf = (
    w as unknown as { Performance?: { prototype: Record<string, unknown> } }
  ).Performance;
  if (Perf === undefined) return;
  const proto = Perf.prototype;
  const value = (query: string): unknown =>
    JSON.parse(
      replay.next("PlatformValue", {
        src: PLATFORM_VALUE_SRC.performance,
        task_id: 0n,
        query,
      }).value,
    ) as unknown;

  for (const [name, how] of PERFORMANCE_METHODS) {
    const original = proto[name];
    if (typeof original !== "function") continue;
    const patched = function (this: unknown, ...args: unknown[]): unknown {
      // The platform checks the call as it did on record (a measure of an
      // unknown mark throws there too); what it returns is not the page's.
      (original as (...a: unknown[]) => unknown).apply(this, args);
      const v = value(performanceQuery(name, args));
      if (how === "list") return performanceEntriesOf(ctx, v);
      if (how === "entry") {
        return v === null ? undefined : performanceEntryOf(ctx, v as Json);
      }
      return v;
    };
    Object.defineProperty(patched, "name", { value: name });
    Object.defineProperty(patched, "length", { value: original.length });
    replaceValue(proto, name, patched);
  }

  const g = w as unknown as Record<string, { prototype?: object } | undefined>;
  for (const name of PERFORMANCE_ATTRIBUTES) {
    const d = Object.getOwnPropertyDescriptor(proto, name);
    if (d?.get === undefined) continue;
    const iface =
      name === "timing" ? "PerformanceTiming" : "PerformanceNavigation";
    replaceAccessor(
      proto,
      name,
      function () {
        const json = value(name) as Json;
        const o = Object.create(
          g[iface]?.prototype ?? Object.prototype,
        ) as object;
        for (const [k, v] of Object.entries(json)) {
          Object.defineProperty(o, k, { value: v, enumerable: true });
        }
        Object.defineProperty(o, "toJSON", { value: () => ({ ...json }) });
        return o;
      },
      d.set,
    );
  }

  const origin = Object.getOwnPropertyDescriptor(proto, "timeOrigin");
  if (origin?.get !== undefined) {
    replaceAccessor(
      proto,
      "timeOrigin",
      function () {
        return bitsToNumber(
          replay.next("Clock", { src: ClockSrc.timeOrigin }).bits,
        );
      },
      origin.set,
    );
  }
}

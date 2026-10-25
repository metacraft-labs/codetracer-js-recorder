/**
 * The performance timeline (JS-Boundary-Recording.md §5.2 `PlatformValue`
 * src 5 and `Clock` src 7, §10.1; Performance Timeline,
 * https://w3c.github.io/performance-timeline/; High Resolution Time,
 * https://w3c.github.io/hr-time/).
 *
 * Every entry of the timeline is a measurement of this machine and this
 * network (resource and navigation timing, paint, layout shifts, long
 * tasks), and a mark or measure the page makes is stamped with a clock read.
 * So each read of it is a boundary read: `getEntries()`,
 * `getEntriesByType()`, `getEntriesByName()`, the entry `mark()` and
 * `measure()` return, the legacy `timing` and `navigation` objects and
 * `toJSON()` are a `PlatformValue{src 5}` whose `query` names the call and
 * whose `value` is the JSON of what it returned (`entries.ts`), and
 * `timeOrigin` is a clock read (`Clock{src 7}`). Replay answers each from
 * the log, so it never shows the page its own timeline, which also lists the
 * replay runner's requests. `PerformanceObserver` is an observer
 * (seams-time.ts).
 */

import { PLATFORM_VALUE_SRC } from "@codetracer/boundary-format";

import { type SeamContext, replaceAccessor, replaceValue } from "./context.js";
import { performanceEntriesJson, performanceEntryJson } from "./entries.js";
import { ClockSrc, numberToBits } from "./recorder.js";

/** The timeline methods that return entries, and how each one's value is written. */
export const PERFORMANCE_METHODS: readonly (readonly [
  string,
  "list" | "entry" | "json",
])[] = [
  ["getEntries", "list"],
  ["getEntriesByType", "list"],
  ["getEntriesByName", "list"],
  ["mark", "entry"],
  ["measure", "entry"],
  ["toJSON", "json"],
];
/** The legacy Navigation Timing attributes, written by their `toJSON()`. */
export const PERFORMANCE_ATTRIBUTES: readonly string[] = [
  "timing",
  "navigation",
];

/**
 * The `query` of a call of timeline method `name` with `args` (§10.4): the
 * name, then a JSON array of the arguments that are strings (an entry type,
 * a name, a measure's named start and end marks), which are what select the
 * value. An attribute's query is its name alone.
 */
export function performanceQuery(
  name: string,
  args: readonly unknown[],
): string {
  return name + JSON.stringify(args.filter((a) => typeof a === "string"));
}

/** The JSON of what timeline method `name` returned. */
export function performanceValueJson(
  how: "list" | "entry" | "json",
  v: unknown,
): string {
  if (how === "list")
    return JSON.stringify(performanceEntriesJson(v as PerformanceEntry[]));
  if (how === "entry") {
    return JSON.stringify(
      v === undefined || v === null
        ? null
        : performanceEntryJson(v as PerformanceEntry),
    );
  }
  return JSON.stringify(v);
}

/** Patch every seam this module owns. */
export function patchPerformance({ w, rec }: SeamContext): void {
  const Perf = (
    w as unknown as { Performance?: { prototype: Record<string, unknown> } }
  ).Performance;
  if (Perf === undefined) return;
  const proto = Perf.prototype;
  const log = (query: string, value: string) =>
    rec.guard(() =>
      rec.emit("PlatformValue", {
        src: PLATFORM_VALUE_SRC.performance,
        task_id: 0n,
        query,
        value,
      }),
    );

  for (const [name, how] of PERFORMANCE_METHODS) {
    const original = proto[name];
    if (typeof original !== "function") continue;
    const patched = function (this: unknown, ...args: unknown[]): unknown {
      const v = (original as (...a: unknown[]) => unknown).apply(this, args);
      if (rec.recording) {
        const json = rec.guard(() => performanceValueJson(how, v));
        if (json !== undefined) log(performanceQuery(name, args), json);
      }
      return v;
    };
    Object.defineProperty(patched, "name", { value: name });
    Object.defineProperty(patched, "length", { value: original.length });
    replaceValue(proto, name, patched);
  }

  for (const name of PERFORMANCE_ATTRIBUTES) {
    const d = Object.getOwnPropertyDescriptor(proto, name);
    if (d?.get === undefined) continue;
    const get = d.get;
    replaceAccessor(
      proto,
      name,
      function (this: unknown) {
        const v = get.call(this) as { toJSON(): unknown };
        if (rec.recording) {
          const json = rec.guard(() => JSON.stringify(v.toJSON()));
          if (json !== undefined) log(name, json);
        }
        return v;
      },
      d.set,
    );
  }

  const origin = Object.getOwnPropertyDescriptor(proto, "timeOrigin");
  if (origin?.get !== undefined) {
    const get = origin.get;
    replaceAccessor(
      proto,
      "timeOrigin",
      function (this: unknown) {
        const v = get.call(this) as number;
        rec.guard(() =>
          rec.emit("Clock", {
            src: ClockSrc.timeOrigin,
            bits: numberToBits(v),
          }),
        );
        return v;
      },
      origin.set,
    );
  }
}

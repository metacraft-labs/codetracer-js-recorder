/**
 * Replay of the platform's own state and of the platform promises that
 * report on it (CodeTracer's JS-Boundary-Recording specification §5.2
 * `PlatformValue` src 8 and 9, §6 "Platform tasks", §7.5, §10.5; the record
 * side is `../seams-environment.ts`).
 *
 * Every state read is answered from the log: the platform's getter still
 * runs (it checks its receiver, and throws for a wrong one, as on record),
 * but what the page gets is the logged value.
 *
 * A platform promise still reaches the platform (its arguments are
 * converted and checked as on record, and its effect on the replay browser
 * is the platform's business), but the promise the page holds settles when
 * the scheduler releases the platform task's `Task`, with the logged
 * outcome. `createImageBitmap()` is the exception: the page draws the
 * bitmap, so it gets the replay browser's own, which settles when both the
 * `Task` is released and the platform's bitmap arrived; its logged size is
 * compared with the bitmap's, and a difference diverges (`ArgumentMismatch`).
 *
 * A call the recorder refused ends the replay there (`NonReplayable`); an
 * event the platform dispatches at `navigator.connection`,
 * `screen.orientation`, `screen` or `document.fonts` never reaches the page
 * from the replay browser: the log has where the visitor's did, refused.
 */

import { PLATFORM_VALUE_SRC } from "@codetracer/boundary-format";

import { replaceAccessor } from "../context.js";
import { TaskKind } from "../recorder.js";
import {
  CANVAS_READBACKS,
  EVENT_COUNTS_ITERATORS,
  PLATFORM_EVENTS,
  fontQuery,
  interfaceProto,
  measureQuery,
  stateGetters,
  stateQuery,
  stateValue,
} from "../seams-environment.js";
import { wrapMethod } from "../seams-platform.js";
import { targetOf } from "../targets.js";
import type { ReplayContext } from "./context.js";
import { replayPlatformTask } from "./platform.js";

type Proto = Record<string, unknown>;

const protoOf = interfaceProto;

/** A logged platform promise outcome (`seams-environment.ts` `outcomeJson`). */
interface Outcome {
  resolved?: unknown;
  rejected?: { name?: unknown; message?: unknown; type?: unknown };
}

/**
 * The error a logged rejection names: a `DOMException` of its name, or the
 * page realm's error constructor of its type (`TypeError`, `RangeError`, …),
 * else an `Error`.
 */
export function errorOf(
  w: ReplayContext["w"],
  rejected: NonNullable<Outcome["rejected"]>,
): unknown {
  const name = String(rejected.name ?? "Error");
  const message = String(rejected.message ?? "");
  const type = String(rejected.type ?? "DOMException");
  if (type === "DOMException") return new w.DOMException(message, name);
  const Ctor = (w as unknown as Record<string, unknown>)[type];
  if (
    typeof Ctor === "function" &&
    (Ctor === w.Error ||
      (Ctor as { prototype?: unknown }).prototype instanceof w.Error)
  ) {
    return new (Ctor as ErrorConstructor)(message);
  }
  const e = new w.Error(message);
  e.name = name;
  return e;
}

/** Do nothing with `p`'s outcome (and leave no unhandled rejection). */
function ignore(ctx: ReplayContext, p: unknown): void {
  if (p === null || typeof p !== "object") return;
  if (typeof (p as { then?: unknown }).then !== "function") return;
  (ctx.orig.promiseThen as Promise<unknown>["then"]).call(
    p as Promise<unknown>,
    () => undefined,
    () => undefined,
  );
}

/**
 * The page's promise for a platform promise whose outcome the log carries
 * (src 7 or 9): registered now; when the scheduler releases its `Task`, the
 * logged `PlatformValue` of `src` and `query` is read and the promise
 * settles with it, `resolved` turning a resolution into the page's value
 * (given the record's `seq`, for a divergence it finds there).
 */
export function replayPlatformOutcome<T>(
  ctx: ReplayContext,
  src: number,
  query: string,
  resolved: (v: unknown, seq: string) => T,
): Promise<T> {
  const { w, replay, orig } = ctx;
  const id = ctx.nextTaskId();
  replay.registerTask(id, TaskKind.platform, 0);
  return new orig.Promise<T>((resolve, reject) => {
    replay.onTask(id, () => {
      replay.offTask(id);
      const record = replay.next("PlatformValue", { src, task_id: id, query });
      const outcome = JSON.parse(record.value) as Outcome;
      if (outcome.rejected !== undefined) {
        reject(errorOf(w, outcome.rejected));
        return;
      }
      resolve(resolved(outcome.resolved, String(record.seq)));
    });
  });
}

/** Replace every seam this module owns. */
export function replayEnvironmentSeams(ctx: ReplayContext): void {
  replayStateReads(ctx);
  replayPlatformOutcomes(ctx);
  replayEnvironmentRefusals(ctx);
}

function replayStateReads(ctx: ReplayContext): void {
  const { w, replay } = ctx;
  // The platform hands the page the same frozen array for as long as its
  // value is the same (`navigator.languages`, `userAgentData.brands`), so
  // the same logged JSON of a query answers with the same object.
  const objects = new Map<string, { json: string; value: unknown }>();
  const logged = (query: string): unknown => {
    const json = replay.next("PlatformValue", {
      src: PLATFORM_VALUE_SRC.platformState,
      task_id: 0n,
      query,
    }).value;
    const last = objects.get(query);
    if (last?.json === json) return last.value;
    const value = stateValue(json);
    if (value !== null && typeof value === "object") {
      objects.set(query, { json, value });
    }
    return value;
  };
  const getter = (
    proto: Proto,
    name: string,
    query: (self: unknown) => string,
  ) => {
    const d = Object.getOwnPropertyDescriptor(proto, name);
    if (d?.get === undefined) return;
    const get = d.get;
    replaceAccessor(
      proto,
      name,
      function (this: unknown) {
        get.call(this);
        return logged(query(this));
      },
      d.set,
    );
  };

  for (const { proto, name, query } of stateGetters(w)) {
    getter(proto, name, () => query);
  }
  const face = protoOf(w, "FontFace");
  if (face !== undefined)
    getter(face, "status", (self) => fontQuery("status", self));

  wrapMethod(
    protoOf(w, "FontFaceSet"),
    "check",
    (original) =>
      function (this: unknown, ...args: unknown[]) {
        if (args.length === 0) return original.apply(this, args);
        const font = `${args[0] as string}`;
        const text = args[1] === undefined ? " " : `${args[1] as string}`;
        original.call(this, font, text);
        return logged(stateQuery("document.fonts.check", [font, text]));
      },
  );

  const metricsProto = protoOf(w, "TextMetrics") ?? Object.prototype;
  for (const iface of [
    "CanvasRenderingContext2D",
    "OffscreenCanvasRenderingContext2D",
  ]) {
    wrapMethod(
      protoOf(w, iface),
      "measureText",
      (original) =>
        function (this: unknown, ...args: unknown[]) {
          if (args.length === 0) return original.apply(this, args);
          const text = `${args[0] as string}`;
          original.call(this, text);
          const json = logged(measureQuery(this, text)) as Record<
            string,
            unknown
          >;
          // A `TextMetrics` whose attributes are own values: the logged ones.
          const m = Object.create(metricsProto) as object;
          for (const [k, v] of Object.entries(json ?? {})) {
            Object.defineProperty(m, k, { value: Number(v), enumerable: true });
          }
          return m;
        },
    );
  }

  replayEventCounts(ctx, logged);
}

function replayEventCounts(
  ctx: ReplayContext,
  logged: (query: string) => unknown,
): void {
  const proto = protoOf(ctx.w, "EventCounts");
  if (proto === undefined || typeof proto.entries !== "function") return;
  const entriesOf = (query: string) =>
    (logged(query) as readonly (readonly [string, number])[]).map(
      ([k, v]) => [k, v] as [string, number],
    );
  for (const name of ["get", "has"]) {
    wrapMethod(
      proto,
      name,
      (original) =>
        function (this: unknown, ...args: unknown[]) {
          if (args.length === 0) return original.apply(this, args);
          const key = `${args[0] as string}`;
          original.call(this, key);
          return logged(stateQuery(`performance.eventCounts.${name}`, [key]));
        },
    );
  }
  const size = Object.getOwnPropertyDescriptor(proto, "size");
  if (size?.get !== undefined) {
    const get = size.get;
    replaceAccessor(
      proto,
      "size",
      function (this: unknown) {
        get.call(this);
        return logged("performance.eventCounts.size");
      },
      size.set,
    );
  }
  for (const name of EVENT_COUNTS_ITERATORS) {
    wrapMethod(
      proto,
      name,
      (original) =>
        function (this: unknown) {
          original.call(this);
          return new Map(entriesOf(`performance.eventCounts.${name}`))[
            name as "entries"
          ]();
        },
    );
  }
  const iter = Object.getOwnPropertyDescriptor(proto, Symbol.iterator);
  Object.defineProperty(proto, Symbol.iterator, {
    value: proto.entries,
    writable: iter?.writable ?? true,
    enumerable: iter?.enumerable ?? false,
    configurable: iter?.configurable ?? true,
  });
  wrapMethod(
    proto,
    "forEach",
    (original) =>
      function (this: unknown, ...args: unknown[]) {
        if (typeof args[0] !== "function") return original.apply(this, args);
        const cb = args[0] as (v: number, k: string, m: unknown) => void;
        for (const [k, v] of entriesOf("performance.eventCounts.forEach")) {
          cb.call(args[1], v, k, this);
        }
        return undefined;
      },
  );
}

function replayPlatformOutcomes(ctx: ReplayContext): void {
  const { w, replay } = ctx;
  const src = PLATFORM_VALUE_SRC.platformOutcome;
  const outcome = (
    owner: Proto | undefined,
    name: string,
    query: (self: unknown, args: unknown[]) => string,
    resolved: (v: unknown, self: unknown, seq: string) => unknown,
  ) =>
    wrapMethod(
      owner,
      name,
      (original) =>
        function (this: unknown, ...args: unknown[]) {
          ignore(ctx, original.apply(this, args));
          return replayPlatformOutcome(ctx, src, query(this, args), (v, seq) =>
            resolved(v, this, seq),
          );
        },
    );
  const asIs = (v: unknown) => v;
  const nothing = () => undefined;

  const storage = protoOf(w, "StorageManager");
  outcome(storage, "estimate", () => "navigator.storage.estimate", asIs);
  outcome(storage, "persisted", () => "navigator.storage.persisted", asIs);
  outcome(storage, "persist", () => "navigator.storage.persist", asIs);

  const clipboard = protoOf(w, "Clipboard");
  outcome(
    clipboard,
    "writeText",
    () => "navigator.clipboard.writeText",
    nothing,
  );
  outcome(clipboard, "write", () => "navigator.clipboard.write", nothing);

  outcome(
    protoOf(w, "NavigatorUAData"),
    "getHighEntropyValues",
    () => "navigator.userAgentData.getHighEntropyValues",
    asIs,
  );

  outcome(
    protoOf(w, "HTMLImageElement"),
    "decode",
    (self) => stateQuery("HTMLImageElement.decode", [targetOf(self)]),
    nothing,
  );

  const fontSet = protoOf(w, "FontFaceSet");
  const values = fontSet?.values as
    | ((this: unknown) => IterableIterator<unknown>)
    | undefined;
  outcome(
    fontSet,
    "load",
    () => "document.fonts.load",
    (v, self, seq) => {
      const all =
        typeof values === "function" ? Array.from(values.call(self)) : [];
      return (Array.isArray(v) ? v : []).map((i: unknown) => {
        const face = typeof i === "number" ? all[i] : undefined;
        if (face === undefined) {
          replay.fail(
            "ArgumentMismatch",
            `document.fonts.load resolved with face ${JSON.stringify(i)} of the set; the replayed set has ${all.length}`,
            undefined,
            undefined,
            seq,
          );
        }
        return face;
      });
    },
  );
  outcome(
    protoOf(w, "FontFace"),
    "load",
    (self) => fontQuery("load", self),
    (_v, self) => self,
  );

  for (const [iface, name, query] of [
    ["FontFaceSet", "ready", () => "document.fonts.ready"],
    ["FontFace", "loaded", (self: unknown) => fontQuery("loaded", self)],
  ] as const) {
    const proto = protoOf(w, iface);
    const d = proto && Object.getOwnPropertyDescriptor(proto, name);
    if (proto === undefined || d?.get === undefined) continue;
    const get = d.get;
    replaceAccessor(
      proto,
      name,
      function (this: unknown) {
        ignore(ctx, get.call(this));
        // Both settle with the object they belong to.
        return replayPlatformOutcome(ctx, src, query(this), () => this);
      },
      d.set,
    );
  }

  const g = w as unknown as Proto;
  wrapMethod(
    g,
    "createImageBitmap",
    (original) =>
      function (this: unknown, ...args: unknown[]) {
        const settled = original.apply(this, args) as Promise<ImageBitmap>;
        return replayPlatformTask(ctx, settled, (id, result) => {
          const record = replay.next("PlatformValue", {
            src,
            task_id: id,
            query: "createImageBitmap",
          });
          const logged = JSON.parse(record.value) as Outcome;
          const actual: Outcome = result.ok
            ? {
                resolved: {
                  width: (result.value as ImageBitmap).width,
                  height: (result.value as ImageBitmap).height,
                },
              }
            : {
                rejected: {
                  name: String(
                    (result.value as { name?: unknown } | null)?.name ??
                      "Error",
                  ),
                },
              };
          const shape = (o: Outcome) =>
            JSON.stringify(
              o.rejected === undefined
                ? o
                : { rejected: { name: String(o.rejected.name) } },
            );
          if (shape(logged) !== shape(actual)) {
            replay.fail(
              "ArgumentMismatch",
              `createImageBitmap settled ${shape(actual)} on replay; the log has ${shape(logged)}`,
              shape(logged),
              shape(actual),
              String(record.seq),
            );
          }
        });
      },
  );
}

function replayEnvironmentRefusals(ctx: ReplayContext): void {
  const { w, replay } = ctx;
  // Refused on record: the replay ends at the call, before the replay
  // browser answers it.
  const refused = (owner: Proto | undefined, name: string) =>
    wrapMethod(
      owner,
      name,
      (original) =>
        function (this: unknown, ...args: unknown[]) {
          if (replay.peek().kind === "Refusal") replay.next("Refusal");
          return original.apply(this, args);
        },
    );
  for (const [iface, names] of CANVAS_READBACKS) {
    for (const name of names) refused(protoOf(w, iface), name);
  }
  for (const name of ["read", "readText"])
    refused(protoOf(w, "Clipboard"), name);
  for (const name of ["delete", "has", "keys", "match", "open"]) {
    refused(protoOf(w, "CacheStorage"), name);
  }
  refused(protoOf(w, "Permissions"), "query");
  refused(protoOf(w, "StorageManager"), "getDirectory");

  // The replay browser's own events at these objects are not the
  // visitor's: they never reach the page. Where the visitor's reached a
  // listener, the log has its refusal, which ends the replay there.
  for (const { target, types } of PLATFORM_EVENTS) {
    let t: unknown;
    try {
      t = target(w);
    } catch {
      t = undefined;
    }
    if (t === undefined || t === null) continue;
    for (const type of types) {
      ctx.orig.addEventListener.call(t as EventTarget, type, (ev: Event) => {
        if (ev.isTrusted) ev.stopImmediatePropagation();
      });
    }
  }
}

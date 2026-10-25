/**
 * The platform's own state and the platform promises that report on it
 * (CodeTracer's JS-Boundary-Recording specification §5.2 `PlatformValue`
 * src 8 and 9, §6 "Platform tasks", §7.5, §10.1, §10.4).
 *
 * **State a page reads** (`PlatformValue` src 8). The platform answers some
 * reads from the visitor's machine, network or browser rather than from the
 * page: where the visitor came from (`document.referrer`), the browser and
 * the device (`navigator.userAgent`, `hardwareConcurrency`, the screen), the
 * network (`navigator.onLine`, `navigator.connection`), the engine's own
 * counters (`performance.memory`, `performance.eventCounts`), how much a
 * socket still has to send (`WebSocket.bufferedAmount`, seams-net.ts), which
 * fonts loaded (`FontFace.status`, `document.fonts.status` and `check()`) and
 * how a canvas measures text with them (`measureText()`). The replay browser
 * runs on another machine, so each such read is logged where the page makes
 * it, with a query naming it ({@link stateQuery}) and its value as
 * {@link stateJson} writes it, and replay answers it from the log.
 *
 * **Promises that settle in a task of their own** (`TaskReg`/`Task` kind 13
 * and `PlatformValue` src 9). `navigator.storage.estimate()`, `persisted()`
 * and `persist()`, the clipboard's writes, `document.fonts.ready` and
 * `load()`, `FontFace.load()` and `loaded`, `HTMLImageElement.decode()`,
 * `createImageBitmap()` and `navigator.userAgentData.getHighEntropyValues()`
 * settle in a task the platform queues when its work is done (each
 * standard's "queue a global task"), so the browser may run any other task
 * first, and what they settle with depends on the visitor's machine. Each is
 * a platform task: `TaskReg` when it is called, and when it settles its
 * `Task` and then a `PlatformValue` of src 9 with the outcome
 * (`{"resolved": …}` or `{"rejected": {name, message, type}}`, written by
 * {@link outcomeJson}), before the page's continuation runs.
 *
 * **Refused** (§7.5), each before it runs: reading a canvas back
 * (`canvas-readback`: its pixels depend on the visitor's GPU, fonts and
 * anti-aliasing, and logging them would cost the canvas's whole bitmap per
 * read), reading the clipboard (`clipboard-content`: the user's data, like a
 * file's contents), the Cache API (`cache-storage`: asynchronous storage with
 * contents of its own, like IndexedDB), and the platform tasks the shim
 * cannot order (`unrecordable-platform-task`): `navigator.permissions.query()`
 * (a live status object whose `change` events the browser dispatches),
 * `navigator.storage.getDirectory()` (the origin-private file system), and
 * an event the platform dispatches at `navigator.connection`,
 * `screen.orientation`, `screen` or `document.fonts` when the page listens
 * for it.
 *
 * `online` and `offline`, which the browser dispatches at the window when
 * the network comes and goes, are input (seams-dom.ts): replay dispatches
 * them from the log, and the `navigator.onLine` the page then reads comes
 * from the log too.
 */

import { PLATFORM_VALUE_SRC } from "@codetracer/boundary-format";

import { type SeamContext, replaceAccessor, replaceValue } from "./context.js";
import { TaskKind } from "./recorder.js";
import { UNRECORDABLE_PLATFORM_TASK, wrapMethod } from "./seams-platform.js";
import { targetOf } from "./targets.js";

/** `Refusal.feature`: the page read a canvas's pixels back (§7.5). */
export const CANVAS_READBACK = "canvas-readback";
/** `Refusal.feature`: the page read the clipboard's contents (§7.5). */
export const CLIPBOARD_CONTENT = "clipboard-content";
/** `Refusal.feature`: the page used the Cache API (§7.5). */
export const CACHE_STORAGE = "cache-storage";

/**
 * The platform state a page reads that the log answers (src 8): each
 * interface's attributes, and the prefix its queries carry. The navigator's
 * `doNotTrack` and `globalPrivacyControl` are not here: a visitor who sends
 * either is never recorded (§11.2), and the upload transport reads them.
 */
export const STATE_READS: readonly {
  iface: string;
  prefix: string;
  attrs: readonly string[];
}[] = [
  { iface: "Document", prefix: "document", attrs: ["referrer"] },
  {
    iface: "Navigator",
    prefix: "navigator",
    attrs: [
      "appVersion",
      "deviceMemory",
      "hardwareConcurrency",
      "language",
      "languages",
      "maxTouchPoints",
      "onLine",
      "platform",
      "userAgent",
      "vendor",
      "webdriver",
    ],
  },
  {
    iface: "NavigatorUAData",
    prefix: "navigator.userAgentData",
    attrs: ["brands", "mobile", "platform"],
  },
  {
    iface: "NetworkInformation",
    prefix: "navigator.connection",
    attrs: [
      "downlink",
      "downlinkMax",
      "effectiveType",
      "rtt",
      "saveData",
      "type",
    ],
  },
  {
    iface: "Screen",
    prefix: "screen",
    attrs: [
      "availHeight",
      "availLeft",
      "availTop",
      "availWidth",
      "colorDepth",
      "height",
      "isExtended",
      "pixelDepth",
      "width",
    ],
  },
  {
    iface: "ScreenOrientation",
    prefix: "screen.orientation",
    attrs: ["angle", "type"],
  },
  { iface: "FontFaceSet", prefix: "document.fonts", attrs: ["status"] },
  {
    iface: "MemoryInfo",
    prefix: "performance.memory",
    attrs: ["jsHeapSizeLimit", "totalJSHeapSize", "usedJSHeapSize"],
  },
];

/**
 * The interfaces whose interface object Chromium does not expose as a
 * global (`FontFaceSet`; `MemoryInfo`, `performance.memory`'s, a Chromium
 * extension), by the object that has each: their prototype is found from it.
 */
const INSTANCE_OF: Record<string, (w: SeamContext["w"]) => unknown> = {
  FontFaceSet: (w) => (w.document as unknown as { fonts?: unknown }).fonts,
  MemoryInfo: (w) => (w.performance as unknown as { memory?: unknown }).memory,
};

/**
 * The prototype of interface `name`: its global's, or for the interfaces
 * of {@link INSTANCE_OF}, that of the object that has it. Read while the
 * shim installs, before any page code (and before any of these getters is
 * patched), so finding it is no read of the page's.
 */
export function interfaceProto(
  w: SeamContext["w"],
  name: string,
): Proto | undefined {
  const global = (
    w as unknown as Record<string, { prototype?: Proto } | undefined>
  )[name]?.prototype;
  if (global !== undefined) return global;
  const find = INSTANCE_OF[name];
  if (find === undefined) return undefined;
  try {
    const o = find(w);
    return o === null || typeof o !== "object"
      ? undefined
      : (Object.getPrototypeOf(o) as Proto);
  } catch {
    return undefined;
  }
}

/** The query of a state read: `<prefix>.<attr>`, then `[args…]` if any. */
export function stateQuery(name: string, args?: readonly unknown[]): string {
  return args === undefined ? name : `${name}${JSON.stringify(args)}`;
}

/** The query of a font's `status` or `loaded`: its family names it. */
export function fontQuery(name: string, face: unknown): string {
  let family = "";
  try {
    family = String((face as { family?: unknown }).family ?? "");
  } catch {
    family = "";
  }
  return stateQuery(`FontFace.${name}`, [family]);
}

/**
 * The JSON of a state value (src 8): a finite number, a string, a boolean,
 * `null` or an array or object of them as itself; a non-finite number as
 * `{"number": "NaN" | "Infinity" | "-Infinity"}`; `undefined` as
 * `{"undefined": true}`. {@link stateValue} reverses it.
 */
export function stateJson(v: unknown): string {
  if (typeof v === "number" && !Number.isFinite(v)) {
    return JSON.stringify({ number: String(v) });
  }
  if (v === undefined) return JSON.stringify({ undefined: true });
  return JSON.stringify(v);
}

/**
 * A state value from its JSON ({@link stateJson}); arrays and the objects in
 * them come back frozen, as the platform's own (`navigator.languages`,
 * `navigator.userAgentData.brands`) are.
 */
export function stateValue(json: string): unknown {
  const v = JSON.parse(json) as unknown;
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 1 && keys[0] === "number") return Number(o.number);
    if (keys.length === 1 && keys[0] === "undefined") return undefined;
  }
  return deepFreeze(v);
}

function deepFreeze(v: unknown): unknown {
  if (v !== null && typeof v === "object") {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
}

/**
 * The JSON of a platform promise's outcome (src 9): `{"resolved": <value>}`,
 * or `{"rejected": {name, message, type}}` where `type` is the error's
 * constructor (`DOMException`, `TypeError`, …) so replay rejects with the
 * same kind of error.
 */
export function outcomeJson(
  outcome: { resolved: unknown } | { rejected: unknown },
): string {
  if ("resolved" in outcome) {
    return JSON.stringify({ resolved: outcome.resolved ?? null });
  }
  const e = outcome.rejected as {
    name?: unknown;
    message?: unknown;
    constructor?: { name?: unknown };
  } | null;
  let type = "Error";
  try {
    type = String(e?.constructor?.name ?? "Error");
  } catch {
    type = "Error";
  }
  return JSON.stringify({
    rejected: {
      name: String(e?.name ?? "Error"),
      message: String(e?.message ?? ""),
      type,
    },
  });
}

/**
 * A platform promise whose outcome the log carries (§6, src 7 or 9): the
 * call's `TaskReg{kind 13}` now; when it settles, its `Task` and a
 * `PlatformValue` of `src` with `query` and the outcome, `resolved` turning
 * what it resolved with into JSON. Returns the promise the page gets.
 */
export function recordPlatformOutcome<T>(
  ctx: SeamContext,
  src: number,
  query: string,
  settled: Promise<T>,
  resolved: (v: T) => unknown,
): Promise<T> {
  const { rec, orig } = ctx;
  if (!rec.recording) return settled;
  const taskId = rec.guard(() => {
    const id = rec.nextTaskId();
    rec.emit("TaskReg", { task_id: id, kind: TaskKind.platform, delay_ms: 0 });
    return id;
  });
  if (taskId === undefined) return settled;
  const settle = (outcome: { resolved: unknown } | { rejected: unknown }) =>
    rec.guard(() => {
      rec.task(taskId, TaskKind.platform);
      rec.emit("PlatformValue", {
        src,
        task_id: taskId,
        query,
        value: outcomeJson(outcome),
      });
    });
  // The page's promise settles in a task of the shim's own ({@link ownTask}):
  // the platform may settle several of these promises in one microtask
  // checkpoint, and only a task boundary between each `Task` and the next
  // keeps every continuation's reads after its own `Task`, where replay,
  // which drains the page's microtasks after each task it releases, runs
  // them (§6). Each standard settles these promises from a queued task
  // anyway; Chromium resolving some of them earlier is the shortcut this
  // undoes.
  return new orig.Promise<T>((resolve, reject) => {
    (orig.promiseThen as Promise<T>["then"]).call(
      settled,
      (v) =>
        ownTask(ctx, () => {
          settle({ resolved: resolved(v) });
          resolve(v);
        }),
      (e: unknown) =>
        ownTask(ctx, () => {
          settle({ rejected: e });
          reject(e);
        }),
    );
  });
}

/**
 * Run `go` in a task of the shim's own: the delivery of a message on a
 * `MessageChannel` of its own (HTML, "posted message task source",
 * https://html.spec.whatwg.org/multipage/web-messaging.html#message-ports),
 * made and listened to with the captured originals, so it is no task of the
 * page's and reaches no listener of the page. Not a timer: a timer nested
 * more than five deep is clamped to 4 ms (HTML, "timer initialization
 * steps",
 * https://html.spec.whatwg.org/multipage/timers-and-user-prompts.html#timer-initialisation-steps),
 * and every continuation of a page that awaits such promises in a chain
 * runs inside the task before it, so with a timer each await after the
 * fifth cost the page 4 ms the platform does not; and a hidden page's
 * timers are throttled (in Chromium to once a second, and after five
 * minutes to once a minute). A message task is neither, which is why
 * schedulers use it for the same purpose (React's `scheduler` package).
 * The channel is closed when its one message arrives. Where the platform
 * has no channels, the captured original `setTimeout`.
 */
export function ownTask(ctx: SeamContext, go: () => void): void {
  const mc = ctx.orig.messageChannel;
  if (mc === undefined) {
    (ctx.orig.setTimeout as (f: () => void, ms: number) => unknown).call(
      ctx.w,
      go,
      0,
    );
    return;
  }
  const channel = new mc.Channel();
  ctx.orig.addEventListener.call(channel.port1, "message", () => {
    // Closing one port disentangles both (HTML, "disentangle").
    mc.close.call(channel.port1);
    go();
  });
  mc.start.call(channel.port1);
  mc.postMessage.call(channel.port2, null);
}

type Proto = Record<string, unknown>;

const protoOf = interfaceProto;

/** Every state read of {@link STATE_READS} this browser has. */
export function stateGetters(
  w: SeamContext["w"],
): { proto: Proto; name: string; query: string }[] {
  const out: { proto: Proto; name: string; query: string }[] = [];
  for (const { iface, prefix, attrs } of STATE_READS) {
    const proto = protoOf(w, iface);
    if (proto === undefined) continue;
    for (const name of attrs) {
      out.push({ proto, name, query: `${prefix}.${name}` });
    }
  }
  return out;
}

/** The text metrics `measureText()` returns, as JSON-able own values. */
export function textMetricsJson(m: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const proto = Object.getPrototypeOf(m) as object | null;
  if (proto === null) return out;
  for (const k of Object.getOwnPropertyNames(proto)) {
    const d = Object.getOwnPropertyDescriptor(proto, k);
    if (d?.get === undefined) continue;
    const v = (m as Record<string, unknown>)[k];
    if (typeof v === "number") out[k] = Number.isFinite(v) ? v : String(v);
  }
  return out;
}

/** The query of a `measureText()`: the context's font and the text. */
export function measureQuery(context: unknown, text: string): string {
  let font = "";
  try {
    font = String((context as { font?: unknown }).font ?? "");
  } catch {
    font = "";
  }
  return stateQuery("measureText", [font, text]);
}

/** The maplike methods of `performance.eventCounts` (`EventCounts`). */
export const EVENT_COUNTS_ITERATORS: readonly string[] = [
  "entries",
  "keys",
  "values",
];

/**
 * The canvas reads that return its pixels (§7.5 `canvas-readback`), by the
 * interface that defines each.
 */
export const CANVAS_READBACKS: readonly (readonly [
  string,
  readonly string[],
])[] = [
  ["CanvasRenderingContext2D", ["getImageData"]],
  ["OffscreenCanvasRenderingContext2D", ["getImageData"]],
  ["HTMLCanvasElement", ["captureStream", "toBlob", "toDataURL"]],
  ["OffscreenCanvas", ["convertToBlob"]],
  ["WebGLRenderingContext", ["readPixels"]],
  ["WebGL2RenderingContext", ["readPixels"]],
];

/**
 * The events the platform dispatches at a platform object, refused when the
 * page listens for them (§7.5 `unrecordable-platform-task`): the global that
 * holds the object, its interface, and the event types.
 */
export const PLATFORM_EVENTS: readonly {
  iface: string;
  label: string;
  target: (w: SeamContext["w"]) => unknown;
  types: readonly string[];
}[] = [
  {
    iface: "NetworkInformation",
    label: "navigator.connection",
    target: (w) =>
      (w.navigator as unknown as { connection?: unknown }).connection,
    types: ["change"],
  },
  {
    iface: "ScreenOrientation",
    label: "screen.orientation",
    target: (w) => w.screen?.orientation,
    types: ["change"],
  },
  {
    iface: "Screen",
    label: "screen",
    target: (w) => w.screen,
    types: ["change"],
  },
  {
    iface: "FontFaceSet",
    label: "document.fonts",
    target: (w) => (w.document as unknown as { fonts?: unknown }).fonts,
    types: ["loading", "loadingdone", "loadingerror"],
  },
];

/**
 * Note the event types the page listens for at the objects of
 * {@link PLATFORM_EVENTS}: through `addEventListener` (an own method on each
 * interface's prototype, ahead of `EventTarget`'s) and the `on<type>`
 * handlers. Calls `listened(label, type)` the first time each is listened
 * for. Shared by the record and the replay sides.
 */
export function watchPlatformListeners(
  w: SeamContext["w"],
  listened: (label: string, type: string) => void,
): void {
  for (const { iface, label, types } of PLATFORM_EVENTS) {
    const proto = protoOf(w, iface);
    if (proto === undefined) continue;
    const watched = new Set(types);
    const own = Object.prototype.hasOwnProperty.call(proto, "addEventListener")
      ? (proto.addEventListener as (...a: unknown[]) => void)
      : undefined;
    const parent = Object.getPrototypeOf(proto) as Proto | null;
    replaceValue(
      proto,
      "addEventListener",
      function addEventListener(
        this: unknown,
        type: unknown,
        ...rest: unknown[]
      ): void {
        if (typeof type === "string" && watched.has(type) && rest[0] != null) {
          listened(label, type);
        }
        // The inherited method is looked up at the call, so a page or
        // library that patched `EventTarget.prototype.addEventListener`
        // after the shim installed (zone.js does) still sees the listener.
        const next = (own ?? parent?.addEventListener) as (
          ...a: unknown[]
        ) => void;
        return next.call(this, type, ...rest);
      },
    );
    for (const type of types) {
      const d = Object.getOwnPropertyDescriptor(proto, `on${type}`);
      if (d?.set === undefined || d.get === undefined) continue;
      const set = d.set;
      replaceAccessor(
        proto,
        `on${type}`,
        d.get,
        function (this: unknown, v: unknown) {
          if (v !== null && v !== undefined) listened(label, type);
          set.call(this, v);
        },
      );
    }
  }
}

/** Patch every seam this module owns. */
export function patchEnvironmentSeams(ctx: SeamContext): void {
  patchStateReads(ctx);
  patchPlatformOutcomes(ctx);
  patchEnvironmentRefusals(ctx);
}

function patchStateReads(ctx: SeamContext): void {
  const { w, rec } = ctx;
  const state = (query: string, v: unknown) =>
    rec.guard(() =>
      rec.emit("PlatformValue", {
        src: PLATFORM_VALUE_SRC.platformState,
        task_id: 0n,
        query,
        value: stateJson(v),
      }),
    );

  for (const { proto, name, query } of stateGetters(w)) {
    const d = Object.getOwnPropertyDescriptor(proto, name);
    if (d?.get === undefined) continue;
    const get = d.get;
    replaceAccessor(
      proto,
      name,
      function (this: unknown) {
        const v = get.call(this) as unknown;
        state(query, v);
        return v;
      },
      d.set,
    );
  }

  // A font's status: which font it is goes into the query.
  const face = protoOf(w, "FontFace");
  const status = face && Object.getOwnPropertyDescriptor(face, "status");
  if (face !== undefined && status?.get !== undefined) {
    const get = status.get;
    replaceAccessor(
      face,
      "status",
      function (this: unknown) {
        const v = get.call(this) as unknown;
        state(fontQuery("status", this), v);
        return v;
      },
      status.set,
    );
  }

  // Whether the fonts a font string names are loaded.
  wrapMethod(
    protoOf(w, "FontFaceSet"),
    "check",
    (original) =>
      function (this: unknown, ...args: unknown[]) {
        if (args.length === 0) return original.apply(this, args);
        const font = `${args[0] as string}`;
        const text = args[1] === undefined ? " " : `${args[1] as string}`;
        const v = original.call(this, font, text);
        state(stateQuery("document.fonts.check", [font, text]), v);
        return v;
      },
  );

  // How a canvas measures text with the fonts it has.
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
          const m = original.call(this, text) as object;
          state(measureQuery(this, text), textMetricsJson(m));
          return m;
        },
    );
  }

  patchEventCounts(ctx, state);
}

/**
 * `performance.eventCounts` (Event Timing, `EventCounts`, a maplike of
 * event type to count): each read is logged, an iteration as the entries
 * it went over; what the page iterates is those entries, on record as on
 * replay, so both hand the page the same iterator.
 */
function patchEventCounts(
  ctx: SeamContext,
  state: (query: string, v: unknown) => void,
): void {
  const { w } = ctx;
  const proto = protoOf(w, "EventCounts");
  if (proto === undefined) return;
  const origEntries = proto.entries as
    | ((this: unknown) => IterableIterator<[string, number]>)
    | undefined;
  if (typeof origEntries !== "function") return;
  const snapshot = (self: unknown, query: string): [string, number][] => {
    const entries = Array.from(origEntries.call(self));
    state(query, entries);
    return entries;
  };
  for (const name of ["get", "has"]) {
    wrapMethod(
      proto,
      name,
      (original) =>
        function (this: unknown, ...args: unknown[]) {
          if (args.length === 0) return original.apply(this, args);
          const key = `${args[0] as string}`;
          const v = original.call(this, key);
          state(stateQuery(`performance.eventCounts.${name}`, [key]), v);
          return v;
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
        const v = get.call(this) as unknown;
        state("performance.eventCounts.size", v);
        return v;
      },
      size.set,
    );
  }
  for (const name of EVENT_COUNTS_ITERATORS) {
    wrapMethod(
      proto,
      name,
      () =>
        function (this: unknown) {
          const entries = snapshot(this, `performance.eventCounts.${name}`);
          return new Map(entries)[name as "entries"]();
        },
    );
  }
  // `[Symbol.iterator]` is `entries` (WebIDL, "maplike declarations").
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
        const entries = snapshot(this, "performance.eventCounts.forEach");
        const cb = args[0] as (v: number, k: string, m: unknown) => void;
        for (const [k, v] of entries) cb.call(args[1], v, k, this);
        return undefined;
      },
  );
}

function patchPlatformOutcomes(ctx: SeamContext): void {
  const { w } = ctx;
  const src = PLATFORM_VALUE_SRC.platformOutcome;
  const outcome = <T>(
    owner: Proto | undefined,
    name: string,
    query: (self: unknown, args: unknown[]) => string,
    resolved: (v: T, self: unknown) => unknown,
  ) =>
    wrapMethod(
      owner,
      name,
      (original) =>
        function (this: unknown, ...args: unknown[]) {
          const settled = original.apply(this, args) as Promise<T>;
          return recordPlatformOutcome(
            ctx,
            src,
            query(this, args),
            settled,
            (v) => resolved(v, this),
          );
        },
    );

  const storage = protoOf(w, "StorageManager");
  outcome(
    storage,
    "estimate",
    () => "navigator.storage.estimate",
    (v) => v,
  );
  outcome(
    storage,
    "persisted",
    () => "navigator.storage.persisted",
    (v) => v,
  );
  outcome(
    storage,
    "persist",
    () => "navigator.storage.persist",
    (v) => v,
  );

  const clipboard = protoOf(w, "Clipboard");
  outcome(
    clipboard,
    "writeText",
    () => "navigator.clipboard.writeText",
    () => true,
  );
  outcome(
    clipboard,
    "write",
    () => "navigator.clipboard.write",
    () => true,
  );

  outcome(
    protoOf(w, "NavigatorUAData"),
    "getHighEntropyValues",
    () => "navigator.userAgentData.getHighEntropyValues",
    (v) => v,
  );

  outcome(
    protoOf(w, "HTMLImageElement"),
    "decode",
    (self) => stateQuery("HTMLImageElement.decode", [targetOf(self)]),
    () => true,
  );

  const fontSet = protoOf(w, "FontFaceSet");
  const values = fontSet?.values as
    | ((this: unknown) => IterableIterator<unknown>)
    | undefined;
  outcome(
    fontSet,
    "load",
    () => "document.fonts.load",
    (faces: unknown[], self) => {
      // The faces, by their place in the set (the set's own order: its
      // CSS-connected faces in document order, then the ones the page added).
      const all =
        typeof values === "function" ? Array.from(values.call(self)) : [];
      return Array.from(faces).map((f) => all.indexOf(f));
    },
  );
  outcome(
    protoOf(w, "FontFace"),
    "load",
    (self) => fontQuery("load", self),
    () => true,
  );

  // The promises that are attributes: each read is a platform task.
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
        const settled = get.call(this) as Promise<unknown>;
        return recordPlatformOutcome(
          ctx,
          src,
          query(this),
          settled,
          () => true,
        );
      },
      d.set,
    );
  }

  const g = w as unknown as Proto;
  const createImageBitmap = g.createImageBitmap;
  if (typeof createImageBitmap === "function") {
    wrapMethod(
      g,
      "createImageBitmap",
      (original) =>
        function (this: unknown, ...args: unknown[]) {
          const settled = original.apply(this, args) as Promise<ImageBitmap>;
          return recordPlatformOutcome(
            ctx,
            src,
            "createImageBitmap",
            settled,
            (b) => ({
              width: b.width,
              height: b.height,
            }),
          );
        },
    );
  }
}

function patchEnvironmentRefusals(ctx: SeamContext): void {
  const { w } = ctx;
  const refuse = (
    owner: Proto | undefined,
    name: string,
    feature: string,
    detail: string,
  ) =>
    wrapMethod(
      owner,
      name,
      (original) =>
        function (this: unknown, ...args: unknown[]) {
          ctx.refuseOnce(feature, detail);
          return original.apply(this, args);
        },
    );
  for (const [iface, names] of CANVAS_READBACKS) {
    for (const name of names) {
      refuse(protoOf(w, iface), name, CANVAS_READBACK, `${iface}.${name}`);
    }
  }
  for (const name of ["read", "readText"]) {
    refuse(
      protoOf(w, "Clipboard"),
      name,
      CLIPBOARD_CONTENT,
      `navigator.clipboard.${name}`,
    );
  }
  for (const name of ["delete", "has", "keys", "match", "open"]) {
    refuse(protoOf(w, "CacheStorage"), name, CACHE_STORAGE, `caches.${name}`);
  }
  refuse(
    protoOf(w, "Permissions"),
    "query",
    UNRECORDABLE_PLATFORM_TASK,
    "navigator.permissions.query",
  );
  refuse(
    protoOf(w, "StorageManager"),
    "getDirectory",
    UNRECORDABLE_PLATFORM_TASK,
    "navigator.storage.getDirectory",
  );

  // An event the platform dispatches at a platform object: refused when it
  // reaches a page that listens for it. The shim's own listener, added
  // before any page code, runs before every listener the page adds.
  const listening = new Set<string>();
  watchPlatformListeners(w, (label, type) => listening.add(`${label} ${type}`));
  for (const { label, target, types } of PLATFORM_EVENTS) {
    let t: unknown;
    try {
      t = target(w);
    } catch {
      t = undefined;
    }
    if (t === undefined || t === null) continue;
    for (const type of types) {
      ctx.orig.addEventListener.call(t as EventTarget, type, (ev: Event) => {
        if (!ev.isTrusted || !listening.has(`${label} ${type}`)) return;
        ctx.refuseOnce(UNRECORDABLE_PLATFORM_TASK, `${label} ${type} event`);
      });
    }
  }
}

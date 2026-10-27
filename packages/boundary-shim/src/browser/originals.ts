/**
 * The platform functions the shim patches, captured before it patches them
 * (JS-Boundary-Recording.md §6: "originals captured before any patching").
 *
 * The shim calls these to perform the page's real reads, and makes its own
 * reads (session id, `Env`, the values it logs) through them so they never
 * reach a patched seam. They are published on the control global
 * (`__ctBoundaryShim.originals`) so that the `__ct` runtime, loaded after
 * the shim, uses them too and adds nothing to the recorded task order.
 */

/** A property accessor captured from a prototype. */
export interface CapturedGetter {
  owner: object;
  name: string;
  descriptor: PropertyDescriptor;
}

/** What `captureOriginals` returns. Each entry is the value before patching. */
export interface ShimOriginals {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
  requestAnimationFrame: typeof requestAnimationFrame | undefined;
  cancelAnimationFrame: typeof cancelAnimationFrame | undefined;
  requestIdleCallback: typeof requestIdleCallback | undefined;
  queueMicrotask: typeof queueMicrotask;
  /** `Promise` and `Promise.prototype.then`, which a page may replace. */
  Promise: PromiseConstructor;
  promiseThen: Promise<unknown>["then"];
  Date: DateConstructor;
  dateNow: () => number;
  performanceNow: () => number;
  /**
   * `Performance.prototype.getEntriesByType`, for reads that are not the
   * page's: the navigation entry's `Server-Timing` trace context, read for
   * the `Env` record and by the browser error reporter (which takes these
   * published originals).
   */
  getEntriesByType: Performance["getEntriesByType"] | undefined;
  mathRandom: () => number;
  getRandomValues: Crypto["getRandomValues"];
  randomUUID: Crypto["randomUUID"] | undefined;
  fetch: typeof fetch | undefined;
  /**
   * What a streamed fetch response is rebuilt from (seams-net.ts): the
   * `Response` and `ReadableStream` constructors, the `Response`
   * accessors a constructed response cannot be given, `clone`, and the
   * `Headers` mutators.
   */
  Response: typeof Response | undefined;
  ReadableStream: typeof ReadableStream | undefined;
  responseGetters: Map<string, CapturedGetter>;
  responseClone: Response["clone"] | undefined;
  headersMutators: Map<string, (...a: unknown[]) => unknown>;
  XMLHttpRequest: typeof XMLHttpRequest | undefined;
  sendBeacon: Navigator["sendBeacon"] | undefined;
  WebSocket: typeof WebSocket | undefined;
  EventSource: typeof EventSource | undefined;
  storageGetItem: Storage["getItem"];
  /** `setItem`, `removeItem`, `clear` and `key` of `Storage.prototype`. */
  storageMethods: Map<string, (...a: unknown[]) => unknown>;
  storageLength: CapturedGetter | undefined;
  /** `window.localStorage` and `window.sessionStorage`. */
  storageAreas: Map<string, CapturedGetter>;
  StorageEvent: typeof StorageEvent | undefined;
  storageEventArea: CapturedGetter | undefined;
  initStorageEvent: ((...a: unknown[]) => void) | undefined;
  /** `Event.prototype.timeStamp`. */
  eventTimeStamp: CapturedGetter | undefined;
  cookie: CapturedGetter | undefined;
  getBoundingClientRect: Element["getBoundingClientRect"];
  /**
   * The `offset*`, `client*` and `scroll*` getters of elements and the
   * window's viewport and position getters ({@link WINDOW_LAYOUT_PROPS}),
   * by property name.
   */
  layoutGetters: Map<string, CapturedGetter>;
  getComputedStyle: typeof getComputedStyle;
  matchMedia: typeof matchMedia | undefined;
  /**
   * `MediaQueryList.prototype.matches`: the shim's own reads of it (`Env`'s
   * colour scheme) are none of the page's.
   */
  mediaQueryMatches: CapturedGetter | undefined;
  /**
   * `Document.prototype.visibilityState`, which the upload transport and the
   * `__ct` runtime read to flush when the page is hidden: through the
   * original, so neither read is logged (record) or answered from the log
   * (replay) as the page's.
   */
  visibilityState: CapturedGetter | undefined;
  IntersectionObserver: typeof IntersectionObserver | undefined;
  ResizeObserver: typeof ResizeObserver | undefined;
  MutationObserver: typeof MutationObserver | undefined;
  PerformanceObserver: typeof PerformanceObserver | undefined;
  pushState: History["pushState"];
  replaceState: History["replaceState"];
  addEventListener: EventTarget["addEventListener"];
  /**
   * `MessageChannel` and the `MessagePort` methods the shim makes a task of
   * its own with (seams-environment.ts `ownTask`); `undefined` where the
   * platform has no channels.
   */
  messageChannel:
    | {
        Channel: typeof MessageChannel;
        postMessage: MessagePort["postMessage"];
        start: MessagePort["start"];
        close: MessagePort["close"];
      }
    | undefined;
}

/** The layout getters §10.1 lists, and the prototype that defines each. */
export const LAYOUT_PROPS: readonly (readonly [string, readonly string[]])[] = [
  ["HTMLElement", ["offsetWidth", "offsetHeight", "offsetTop", "offsetLeft"]],
  [
    "Element",
    [
      "clientWidth",
      "clientHeight",
      "clientTop",
      "clientLeft",
      "scrollWidth",
      "scrollHeight",
      "scrollTop",
      "scrollLeft",
    ],
  ],
];

/**
 * The window's viewport, scale and position getters, logged as
 * `LayoutRead`s of target `win` where the page reads them (§10.1): the
 * visitor resizes, zooms, moves and scrolls the window, and the replay
 * browser's are its own. In Chromium they are own accessors of the window
 * (WebIDL puts a `[Global]` interface's attributes on the object itself), so
 * they are found on its prototype chain ({@link getterOnChain}).
 */
export const WINDOW_LAYOUT_PROPS: readonly string[] = [
  "devicePixelRatio",
  "innerHeight",
  "innerWidth",
  "outerHeight",
  "outerWidth",
  "pageXOffset",
  "pageYOffset",
  "screenLeft",
  "screenTop",
  "screenX",
  "screenY",
  "scrollX",
  "scrollY",
];

/** The `Response` accessors a constructed response must answer for. */
export const RESPONSE_GETTERS = ["url", "redirected", "type", "statusText"];
/** The `Headers` methods that change a header list. */
export const HEADERS_MUTATORS = ["append", "delete", "set"];
/** The `Storage` methods besides `getItem`. */
export const STORAGE_METHODS = ["setItem", "removeItem", "clear", "key"];

/** Capture every seam's current value from `w` (a window). */
export function captureOriginals(w: Window & typeof globalThis): ShimOriginals {
  const layoutGetters = new Map<string, CapturedGetter>();
  for (const [ctorName, props] of LAYOUT_PROPS) {
    const ctor = (w as unknown as Record<string, { prototype: object }>)[
      ctorName
    ];
    for (const name of props) {
      const g = getter(ctor?.prototype, name);
      if (g !== undefined) layoutGetters.set(name, g);
    }
  }
  for (const name of WINDOW_LAYOUT_PROPS) {
    const g = getterOnChain(w, name);
    if (g !== undefined) layoutGetters.set(name, g);
  }
  const responseGetters = new Map<string, CapturedGetter>();
  for (const name of RESPONSE_GETTERS) {
    const g = getter(w.Response?.prototype, name);
    if (g !== undefined) responseGetters.set(name, g);
  }
  const headersMutators = new Map<string, (...a: unknown[]) => unknown>();
  for (const name of HEADERS_MUTATORS) {
    const f = (w.Headers?.prototype as unknown as Record<string, unknown>)?.[
      name
    ];
    if (typeof f === "function") {
      headersMutators.set(name, f as (...a: unknown[]) => unknown);
    }
  }
  const storageMethods = new Map<string, (...a: unknown[]) => unknown>();
  for (const name of STORAGE_METHODS) {
    const f = (w.Storage.prototype as unknown as Record<string, unknown>)[name];
    if (typeof f === "function") {
      storageMethods.set(name, f as (...a: unknown[]) => unknown);
    }
  }
  const storageAreas = new Map<string, CapturedGetter>();
  for (const name of ["localStorage", "sessionStorage"]) {
    const g = getterOnChain(w, name);
    if (g !== undefined) storageAreas.set(name, g);
  }
  return {
    setTimeout: w.setTimeout,
    clearTimeout: w.clearTimeout,
    setInterval: w.setInterval,
    clearInterval: w.clearInterval,
    requestAnimationFrame: w.requestAnimationFrame,
    cancelAnimationFrame: w.cancelAnimationFrame,
    requestIdleCallback: w.requestIdleCallback,
    queueMicrotask: w.queueMicrotask,
    Promise: w.Promise,
    promiseThen: w.Promise.prototype.then,
    Date: w.Date,
    dateNow: w.Date.now,
    performanceNow: w.performance.now,
    getEntriesByType: w.Performance?.prototype.getEntriesByType,
    mathRandom: w.Math.random,
    getRandomValues: w.Crypto.prototype.getRandomValues,
    randomUUID: w.Crypto.prototype.randomUUID,
    fetch: w.fetch,
    Response: w.Response,
    ReadableStream: w.ReadableStream,
    responseGetters,
    responseClone: w.Response?.prototype.clone,
    headersMutators,
    XMLHttpRequest: w.XMLHttpRequest,
    sendBeacon: w.Navigator?.prototype.sendBeacon,
    WebSocket: w.WebSocket,
    EventSource: w.EventSource,
    storageGetItem: w.Storage.prototype.getItem,
    storageMethods,
    storageLength: getter(w.Storage.prototype, "length"),
    storageAreas,
    StorageEvent: w.StorageEvent,
    storageEventArea: getter(w.StorageEvent?.prototype, "storageArea"),
    initStorageEvent: (
      w.StorageEvent?.prototype as unknown as
        | Record<string, ((...a: unknown[]) => void) | undefined>
        | undefined
    )?.initStorageEvent,
    eventTimeStamp: getter(w.Event.prototype, "timeStamp"),
    cookie: getter(w.Document.prototype, "cookie"),
    getBoundingClientRect: w.Element.prototype.getBoundingClientRect,
    layoutGetters,
    getComputedStyle: w.getComputedStyle,
    matchMedia: w.matchMedia,
    mediaQueryMatches: getter(w.MediaQueryList?.prototype, "matches"),
    visibilityState: getter(w.Document.prototype, "visibilityState"),
    IntersectionObserver: w.IntersectionObserver,
    ResizeObserver: w.ResizeObserver,
    MutationObserver: w.MutationObserver,
    PerformanceObserver: w.PerformanceObserver,
    pushState: w.History.prototype.pushState,
    replaceState: w.History.prototype.replaceState,
    addEventListener: w.EventTarget.prototype.addEventListener,
    messageChannel:
      typeof w.MessageChannel === "function" && w.MessagePort !== undefined
        ? {
            Channel: w.MessageChannel,
            postMessage: w.MessagePort.prototype.postMessage,
            start: w.MessagePort.prototype.start,
            close: w.MessagePort.prototype.close,
          }
        : undefined,
  };
}

/** The accessor `name` on `owner` (not its prototypes), if it has a getter. */
export function getter(
  owner: object | undefined,
  name: string,
): CapturedGetter | undefined {
  if (owner === undefined || owner === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(owner, name);
  if (descriptor === undefined || typeof descriptor.get !== "function") {
    return undefined;
  }
  return { owner, name, descriptor };
}

/**
 * The accessor `name` on `owner` or the nearest object of its prototype
 * chain that has one (`window.localStorage` is an own accessor of the
 * window in Chromium, but WebIDL lets an engine put it on a prototype).
 */
export function getterOnChain(
  owner: object | null,
  name: string,
): CapturedGetter | undefined {
  for (let o = owner; o !== null; o = Object.getPrototypeOf(o) as object) {
    if (Object.getOwnPropertyDescriptor(o, name) !== undefined) {
      return getter(o, name);
    }
  }
  return undefined;
}

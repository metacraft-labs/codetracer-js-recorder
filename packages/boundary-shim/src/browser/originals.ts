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
  /** The `offset*`, `client*` and `scroll*` getters, by property name. */
  layoutGetters: Map<string, CapturedGetter>;
  getComputedStyle: typeof getComputedStyle;
  matchMedia: typeof matchMedia | undefined;
  IntersectionObserver: typeof IntersectionObserver | undefined;
  ResizeObserver: typeof ResizeObserver | undefined;
  MutationObserver: typeof MutationObserver | undefined;
  PerformanceObserver: typeof PerformanceObserver | undefined;
  pushState: History["pushState"];
  replaceState: History["replaceState"];
  addEventListener: EventTarget["addEventListener"];
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
    IntersectionObserver: w.IntersectionObserver,
    ResizeObserver: w.ResizeObserver,
    MutationObserver: w.MutationObserver,
    PerformanceObserver: w.PerformanceObserver,
    pushState: w.History.prototype.pushState,
    replaceState: w.History.prototype.replaceState,
    addEventListener: w.EventTarget.prototype.addEventListener,
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

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
  Date: DateConstructor;
  dateNow: () => number;
  performanceNow: () => number;
  mathRandom: () => number;
  getRandomValues: Crypto["getRandomValues"];
  randomUUID: Crypto["randomUUID"] | undefined;
  fetch: typeof fetch | undefined;
  XMLHttpRequest: typeof XMLHttpRequest | undefined;
  sendBeacon: Navigator["sendBeacon"] | undefined;
  WebSocket: typeof WebSocket | undefined;
  EventSource: typeof EventSource | undefined;
  storageGetItem: Storage["getItem"];
  cookie: CapturedGetter | undefined;
  getBoundingClientRect: Element["getBoundingClientRect"];
  /** The `offset*`, `client*` and `scroll*` getters, by property name. */
  layoutGetters: Map<string, CapturedGetter>;
  getComputedStyle: typeof getComputedStyle;
  matchMedia: typeof matchMedia | undefined;
  IntersectionObserver: typeof IntersectionObserver | undefined;
  ResizeObserver: typeof ResizeObserver | undefined;
  MutationObserver: typeof MutationObserver | undefined;
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
  return {
    setTimeout: w.setTimeout,
    clearTimeout: w.clearTimeout,
    setInterval: w.setInterval,
    clearInterval: w.clearInterval,
    requestAnimationFrame: w.requestAnimationFrame,
    cancelAnimationFrame: w.cancelAnimationFrame,
    requestIdleCallback: w.requestIdleCallback,
    queueMicrotask: w.queueMicrotask,
    Date: w.Date,
    dateNow: w.Date.now,
    performanceNow: w.performance.now,
    mathRandom: w.Math.random,
    getRandomValues: w.Crypto.prototype.getRandomValues,
    randomUUID: w.Crypto.prototype.randomUUID,
    fetch: w.fetch,
    XMLHttpRequest: w.XMLHttpRequest,
    sendBeacon: w.Navigator?.prototype.sendBeacon,
    WebSocket: w.WebSocket,
    EventSource: w.EventSource,
    storageGetItem: w.Storage.prototype.getItem,
    cookie: getter(w.Document.prototype, "cookie"),
    getBoundingClientRect: w.Element.prototype.getBoundingClientRect,
    layoutGetters,
    getComputedStyle: w.getComputedStyle,
    matchMedia: w.matchMedia,
    IntersectionObserver: w.IntersectionObserver,
    ResizeObserver: w.ResizeObserver,
    MutationObserver: w.MutationObserver,
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

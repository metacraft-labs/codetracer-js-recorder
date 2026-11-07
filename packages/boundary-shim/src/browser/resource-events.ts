/**
 * The events of a page's resource elements (CodeTracer's
 * JS-Boundary-Recording specification §5.2 `DocTask` kind 5, §6 "The
 * document's own tasks"): an image's, a style sheet's, a frame's, an
 * object's or a track's `load` and `error`, and a media element's events.
 *
 * The browser dispatches each in a task of its own when the network (or the
 * media pipeline) delivers something, so where they run among the page's
 * other tasks depends on the network and the machine; their listeners are
 * page code. One implementation decides, on both sides of a recording,
 * which events these are and what names them:
 *
 * - the recorders (`recordDocumentProgress`, which the generic shim and a
 *   cooperating framework share) write a `DocTask` of kind 5 for each, with
 *   the element's structural target (§10.2), the event's type, and the
 *   resource's URL;
 * - the replay runner's in-page runtime holds them back until the log says
 *   they ran (`packages/boundary-replay/src/browser/runtime.ts`).
 *
 * An element that is not in the document (`new Image()`) dispatches its
 * events at itself only, so a capture listener on the document never sees
 * them. Its events are observable only through a listener the page adds to
 * the element itself, so {@link watchResourceListeners} adds one of its own
 * to an element just before the page adds its first: a capture listener at
 * the target runs before every non-capture listener there (DOM, "inner
 * invoke": https://dom.spec.whatwg.org/#concept-event-listener-inner-invoke),
 * and before the page's capture listeners, which come after it.
 *
 * Not these events: a script's `load` and `error` (its execution is the
 * `DocTask` of kinds 1 and 4); the window's `load` (kind 3); and the `load` of
 * a frame's initial `about:blank` document, which Chromium dispatches
 * synchronously inside the call that inserted the frame, so it runs where the
 * page's code does on both sides and is no task of its own.
 */

import { isOwnElement } from "./own-elements.js";
import { targetOf } from "./targets.js";

/**
 * The events of a media element (HTML, "Media elements", event summary:
 * https://html.spec.whatwg.org/multipage/media.html#mediaevents), each
 * dispatched by the media element's task source.
 */
export const MEDIA_EVENTS: readonly string[] = [
  "abort",
  "canplay",
  "canplaythrough",
  "durationchange",
  "emptied",
  "ended",
  "error",
  "loadeddata",
  "loadedmetadata",
  "loadstart",
  "pause",
  "play",
  "playing",
  "progress",
  "ratechange",
  "resize",
  "seeked",
  "seeking",
  "stalled",
  "suspend",
  "timeupdate",
  "volumechange",
  "waiting",
];

/** Every event type that can be a resource element's event. */
export const RESOURCE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "load",
  "error",
  ...MEDIA_EVENTS,
]);

/** A resource element's event, as the log names it (`DocTask` kind 5). */
export interface ResourceEvent {
  element: Element;
  /** The element's structural target (§10.2). */
  target: string;
  /** The event's type. */
  event: string;
  /**
   * The URL of the resource the event reports on, without its fragment,
   * which replay holds until the event comes due; empty for a media
   * element and its `<source>`s (replay dispatches their events from the
   * log, since the media pipeline's progress cannot be held) and for an
   * element whose resource has no URL (a `<style>`).
   */
  src: string;
  /** Whether replay dispatches it from the log rather than waiting for it. */
  media: boolean;
}

/** `url` without its fragment. */
function withoutFragment(url: string): string {
  const hash = url.indexOf("#");
  return hash < 0 ? url : url.slice(0, hash);
}

/** A string property of `el`, read without throwing. */
function stringProp(el: Element, name: string): string {
  try {
    const v = (el as unknown as Record<string, unknown>)[name];
    return typeof v === "string" ? v : "";
  } catch {
    return "";
  }
}

/**
 * The URL of the resource `el` loads: the image an `<img>` chose
 * (`currentSrc`, which follows `srcset` and `<picture>`), a style sheet's or
 * a preload's `href`, a frame's, an embed's, a track's or an image input's
 * `src`, an object's `data`, an SVG `<image>`'s `href`. Empty for anything
 * else.
 */
export function resourceUrlOf(el: Element): string {
  let url = "";
  switch (el.localName) {
    case "img":
      url = stringProp(el, "currentSrc") || stringProp(el, "src");
      break;
    case "link":
      url = stringProp(el, "href");
      break;
    case "iframe":
    case "frame":
    case "embed":
    case "track":
    case "input":
      url = stringProp(el, "src");
      break;
    case "object":
      url = stringProp(el, "data");
      break;
    case "image": {
      // SVG: `href` is an SVGAnimatedString, resolved against the base URL.
      const href = (el as unknown as { href?: { baseVal?: unknown } }).href
        ?.baseVal;
      if (typeof href === "string" && href !== "") {
        try {
          url = new URL(href, el.baseURI).href;
        } catch {
          url = "";
        }
      }
      break;
    }
    default:
      url = "";
  }
  return withoutFragment(url);
}

/**
 * Whether `el` is a frame showing its initial `about:blank` document, whose
 * `load` Chromium dispatches synchronously inside the call that inserted it
 * (measured 2026-10-25 with Chromium 141: a capture listener saw it between
 * the two statements around `appendChild`), so it is no task of its own.
 */
function isSyncBlankFrameLoad(el: Element, type: string): boolean {
  if (type !== "load") return false;
  if (el.localName !== "iframe" && el.localName !== "frame") return false;
  try {
    const doc = (el as HTMLIFrameElement).contentDocument;
    return doc !== null && doc.URL === "about:blank";
  } catch {
    return false;
  }
}

/**
 * What `ev` is, if it is a resource element's event the log records (see
 * the module comment): a trusted event of an element of `w`'s document (or
 * of one created for it and not inserted) that is not CodeTracer's own.
 */
export function resourceEventOf(
  w: Window & typeof globalThis,
  ev: Event,
): ResourceEvent | undefined {
  if (!ev.isTrusted || !RESOURCE_EVENT_TYPES.has(ev.type)) return undefined;
  const el = ev.target;
  if (!(el instanceof w.Element) || el.ownerDocument !== w.document) {
    return undefined;
  }
  if (isOwnElement(el)) return undefined;
  const type = ev.type;
  const isMedia = el instanceof w.HTMLMediaElement;
  const isSource = el instanceof w.HTMLSourceElement;
  if (type === "load" || type === "error") {
    if (el.localName === "script") return undefined;
    if (isSyncBlankFrameLoad(el, type)) return undefined;
    if (isMedia || isSource) {
      return {
        element: el,
        target: targetOf(el),
        event: type,
        src: "",
        media: true,
      };
    }
    return {
      element: el,
      target: targetOf(el),
      event: type,
      src: resourceUrlOf(el),
      media: false,
    };
  }
  if (!isMedia) return undefined;
  return {
    element: el,
    target: targetOf(el),
    event: type,
    src: "",
    media: true,
  };
}

/** The `on<event>` handlers of resource events, on the element prototypes. */
const HANDLER_OWNERS = ["HTMLElement", "SVGElement"];

/**
 * Call `onElement(el)` just before the page adds its first listener for a
 * resource event to an element `el`, with `addEventListener` or an
 * `on<event>` handler (see the module comment): the caller adds a capture
 * listener of its own there, which then runs before the page's. `<body>`
 * and `<frameset>` are left out, since their `onload` and `onerror` are the
 * window's (HTML, "WindowEventHandlers").
 */
export function watchResourceListeners(
  w: Window & typeof globalThis,
  onElement: (el: Element) => void,
): void {
  const watched = new WeakSet<Element>();
  const watch = (target: unknown, type: unknown): void => {
    if (!(target instanceof w.Element) || watched.has(target)) return;
    if (typeof type !== "string" || !RESOURCE_EVENT_TYPES.has(type)) return;
    if (target.localName === "body" || target.localName === "frameset") {
      return;
    }
    watched.add(target);
    try {
      onElement(target);
    } catch {
      // The caller's listener is its own business; the page's must still be added.
    }
  };
  const proto = w.EventTarget.prototype;
  const origAdd = proto.addEventListener;
  const d = Object.getOwnPropertyDescriptor(proto, "addEventListener");
  Object.defineProperty(proto, "addEventListener", {
    value: function addEventListener(this: unknown, ...args: unknown[]) {
      watch(this, args[0]);
      return (origAdd as (...a: unknown[]) => void).apply(this, args);
    },
    writable: d?.writable ?? true,
    enumerable: d?.enumerable ?? true,
    configurable: d?.configurable ?? true,
  });
  for (const ctor of HANDLER_OWNERS) {
    const owner = (w as unknown as Record<string, { prototype?: object }>)[ctor]
      ?.prototype;
    if (owner === undefined) continue;
    for (const type of RESOURCE_EVENT_TYPES) {
      const name = `on${type}`;
      const hd = Object.getOwnPropertyDescriptor(owner, name);
      if (hd?.get === undefined || hd.set === undefined) continue;
      const set = hd.set;
      Object.defineProperty(owner, name, {
        get: hd.get,
        set(this: unknown, v: unknown) {
          if (typeof v === "function") watch(this, type);
          set.call(this, v);
        },
        enumerable: hd.enumerable,
        configurable: hd.configurable,
      });
    }
  }
}

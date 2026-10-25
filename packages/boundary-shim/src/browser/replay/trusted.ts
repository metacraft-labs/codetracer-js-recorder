/**
 * Events replay dispatches in the platform's place, seen by the page's
 * listeners as the platform's (CodeTracer's JS-Boundary-Recording
 * specification §10.5).
 *
 * Replay cannot make the platform fire an XMLHttpRequest's, a WebSocket's,
 * an `EventSource`'s or a `MessagePort`'s events, nor a window's `message`,
 * `storage`, `popstate` or `hashchange`: it dispatches events it built
 * itself, and an event built by script has `isTrusted == false` (DOM,
 * "dispatchEvent"). On record each of them was trusted (the record shim
 * records only trusted ones), so a listener that checks `isTrusted` would
 * take another branch on replay. `isTrusted` is an unforgeable own property
 * of the event, so it cannot be changed on the event itself; instead every
 * listener the page registers (with `addEventListener`, or as an `on<event>`
 * handler of those objects) is called, for an event replay dispatched as a
 * stand-in, with a view of the event whose `isTrusted` is `true` and which
 * forwards everything else to the event. Events the page dispatches itself
 * reach its listeners unchanged, untrusted as on record.
 *
 * What no setter sees is a handler set by markup: an `on<event>` content
 * attribute (`<body onmessage="…">`, which is the window's handler, or
 * `<img onload="…">`) is compiled by the platform into the handler's value
 * when it is first read or the event first dispatched (HTML, "getting the
 * current value of the event handler":
 * https://html.spec.whatwg.org/multipage/webappapis.html#getting-the-current-value-of-the-event-handler).
 * Just before a stand-in is dispatched at a target, replay reads the
 * target's handler for its type through the platform's getter (compiling a
 * markup handler, as the dispatch would), and when that value is a function
 * replay did not wrap, sets in its place, through the platform's setter, a
 * wrapper that calls it with the view. Setting an event handler's value
 * keeps the handler's place among the target's listeners (HTML, "event
 * handler IDL attributes", the setter's steps), and the platform's getter
 * still answers the compiled function, so the page sees the handler it had,
 * run at its place, with the event as on record. Injected input events
 * (§10.3) are not stand-ins: they keep the level-0 limitation §10.3 states.
 */

import { getterOnChain } from "../originals.js";
import { replaceAccessor, replaceValue } from "../context.js";
import { RESOURCE_EVENT_TYPES } from "../resource-events.js";
import type { ReplayContext } from "./context.js";

export interface TrustedEvents {
  /**
   * Dispatch `ev`, built by replay in the platform's place, at `target`:
   * the page's listeners see it as trusted.
   */
  dispatch(target: EventTarget, ev: Event): boolean;
}

/** The window's event handlers a stand-in can reach. */
const WINDOW_HANDLERS = ["message", "storage", "popstate", "hashchange"];

/**
 * The `on<event>` handlers of the objects replay dispatches stand-ins at:
 * an XMLHttpRequest and its upload object, a `MessagePort`, and the
 * elements whose resource events the runner dispatches (§6).
 */
const HANDLERS: readonly (readonly [string, readonly string[]])[] = [
  [
    "XMLHttpRequestEventTarget",
    ["loadstart", "progress", "abort", "error", "load", "timeout", "loadend"],
  ],
  ["XMLHttpRequest", ["readystatechange"]],
  ["MessagePort", ["message", "messageerror"]],
  ["HTMLElement", [...RESOURCE_EVENT_TYPES]],
  ["SVGElement", [...RESOURCE_EVENT_TYPES]],
];

export function installTrustedEvents(ctx: ReplayContext): TrustedEvents {
  const { w } = ctx;
  const standIns = new WeakSet<Event>();
  const views = new WeakMap<Event, Event>();
  // A listener (function or `handleEvent` object) -> the one wrapper that is
  // registered in its place, so removeEventListener finds it.
  const wrappers = new WeakMap<object, EventListener>();
  // The wrappers made for `on<event>` handlers -> the handler.
  const handlerOf = new WeakMap<Function, Function>();

  /** The view of stand-in `ev` a listener is called with. */
  const viewOf = (ev: Event): Event => {
    let v = views.get(ev);
    if (v !== undefined) return v;
    const bound = new Map<PropertyKey, Function>();
    v = new Proxy(ev, {
      get(t, p) {
        if (p === "isTrusted") return true;
        const value = Reflect.get(t, p, t) as unknown;
        if (typeof value !== "function" || p === "constructor") return value;
        // The event's methods check their receiver: call them on the event.
        let b = bound.get(p);
        if (b === undefined) {
          b = (value as Function).bind(t) as Function;
          bound.set(p, b);
        }
        return b;
      },
      set(t, p, value) {
        return Reflect.set(t, p, value, t);
      },
    });
    views.set(ev, v);
    return v;
  };
  const seen = (ev: unknown): unknown =>
    ev instanceof w.Event && standIns.has(ev) ? viewOf(ev) : ev;

  const wrap = (listener: unknown): unknown => {
    if (
      listener === null ||
      (typeof listener !== "function" && typeof listener !== "object")
    ) {
      return listener;
    }
    const l = listener as object;
    let wrapper = wrappers.get(l);
    if (wrapper === undefined) {
      wrapper = function (this: unknown, ev: Event): unknown {
        const e = seen(ev);
        if (typeof listener === "function") {
          return (listener as Function).call(this, e);
        }
        // A `handleEvent` object, looked up at each dispatch (DOM, "inner
        // invoke"); a missing one throws, as the platform reports it.
        return (listener as { handleEvent: Function }).handleEvent(e);
      };
      wrappers.set(l, wrapper);
    }
    return wrapper;
  };

  const Target = w.EventTarget.prototype;
  const origAdd = Target.addEventListener;
  const origRemove = Target.removeEventListener;
  replaceValue(
    Target,
    "addEventListener",
    function addEventListener(this: unknown, ...args: unknown[]): void {
      args[1] = wrap(args[1]);
      return (origAdd as (...a: unknown[]) => void).apply(this, args);
    },
  );
  replaceValue(
    Target,
    "removeEventListener",
    function removeEventListener(this: unknown, ...args: unknown[]): void {
      const l = args[1];
      if ((typeof l === "function" || typeof l === "object") && l !== null) {
        args[1] = wrappers.get(l) ?? l;
      }
      return (origRemove as (...a: unknown[]) => void).apply(this, args);
    },
  );

  /**
   * The platform's accessors of each `on<type>` handler patched below, by
   * the object that defines it: they answer and set the function the
   * platform holds (the wrapper, or a handler compiled from markup).
   */
  const platformHandlers = new Map<
    object,
    Map<
      string,
      {
        get: (this: unknown) => unknown;
        set: (this: unknown, v: unknown) => void;
      }
    >
  >();
  /** A wrapper that calls `handler` with the view of a stand-in. */
  const handlerWrapper = (handler: Function): Function => {
    const wrapper = function (this: unknown, ev: Event): unknown {
      return handler.call(this, seen(ev));
    };
    handlerOf.set(wrapper, handler);
    return wrapper;
  };
  /**
   * Make the `on<type>` handler of `owner` call the page's handler with the
   * view, keeping the platform's accessors for {@link wrapMarkupHandler}.
   */
  const patchHandler = (owner: object, type: string): void => {
    const name = `on${type}`;
    const d = Object.getOwnPropertyDescriptor(owner, name);
    if (d?.get === undefined || d.set === undefined) return;
    const get = d.get;
    const set = d.set;
    let byType = platformHandlers.get(owner);
    if (byType === undefined) {
      byType = new Map();
      platformHandlers.set(owner, byType);
    }
    byType.set(type, { get, set });
    replaceAccessor(
      owner,
      name,
      function (this: unknown) {
        const v = get.call(this) as unknown;
        return typeof v === "function" ? (handlerOf.get(v) ?? v) : v;
      },
      function (this: unknown, v: unknown) {
        if (typeof v !== "function") {
          set.call(this, v);
          return;
        }
        set.call(this, handlerWrapper(v as Function));
      },
    );
  };
  for (const [ctor, types] of HANDLERS) {
    const proto = (w as unknown as Record<string, { prototype?: object }>)[ctor]
      ?.prototype;
    if (proto === undefined) continue;
    for (const type of types) patchHandler(proto, type);
  }
  for (const type of WINDOW_HANDLERS) {
    const g = getterOnChain(w, `on${type}`);
    if (g !== undefined) patchHandler(g.owner, type);
    // `<body>` and `<frameset>` reflect the window's handlers (HTML,
    // WindowEventHandlers: https://html.spec.whatwg.org/multipage/webappapis.html#windoweventhandlers),
    // so `document.body.onmessage = f` sets the window's handler from
    // script; it gets the view too, and is not mistaken for markup.
    for (const ctor of ["HTMLBodyElement", "HTMLFrameSetElement"]) {
      const proto = (w as unknown as Record<string, { prototype?: object }>)[
        ctor
      ]?.prototype;
      if (proto !== undefined) patchHandler(proto, type);
    }
  }

  /**
   * Before a stand-in of type `type` reaches `target`: when the target's
   * `on<type>` handler holds a function replay did not wrap (one compiled
   * from a content attribute; see the module comment), put a wrapper in its
   * place, at its place among the target's listeners.
   */
  const wrapMarkupHandler = (target: EventTarget, type: string): void => {
    for (
      let o: object | null = target;
      o !== null;
      o = Object.getPrototypeOf(o) as object | null
    ) {
      const accessors = platformHandlers.get(o)?.get(type);
      if (accessors === undefined) {
        // A handler of the same name defined here (not one replay patched)
        // is the target's: `<body>`'s `onload` is the window's.
        if (Object.getOwnPropertyDescriptor(o, `on${type}`) !== undefined) {
          return;
        }
        continue;
      }
      const h = accessors.get.call(target);
      if (typeof h !== "function" || handlerOf.has(h)) return;
      try {
        accessors.set.call(target, handlerWrapper(h));
      } catch (e) {
        ctx.replay.fail(
          "NonReplayable",
          `the ${type} handler set by markup could not be given the replayed event as trusted (${String(e)})`,
        );
      }
      return;
    }
  };

  const dispatch = w.EventTarget.prototype.dispatchEvent;
  return {
    dispatch(target, ev) {
      wrapMarkupHandler(target, ev.type);
      standIns.add(ev);
      return dispatch.call(target, ev);
    },
  };
}

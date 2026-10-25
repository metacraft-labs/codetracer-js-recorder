/**
 * Replay of storage, layout and navigation reads, and level-0 input
 * injection (CodeTracer's JS-Boundary-Recording specification §5.2
 * `StorageRead`, `LayoutRead`, `Navigation`, `Input`, `DomEffect`; §9.3;
 * §10.1 to §10.3).
 *
 * Reads answer from the log; writes (a `setItem`, a scroll, a `pushState`)
 * reach the platform, since the replay page's own state must follow the
 * page's code.
 *
 * Input (§10.3): the runner hands each `Input` and the `DomEffect`s before
 * it to {@link ReplayInjector.inject}, which applies the effects, resolves
 * the structural target and dispatches a synthetic event built from the
 * recorded properties. Browser default actions do not run on replay: their
 * effects arrive as `DomEffect` records and, where the platform reacts to a
 * synthetic event by dispatching trusted events of its own (a checkbox's
 * `input` and `change`, a form's `submit`, the `focus` an applied effect
 * causes), those reach no page listener: each was recorded as an input of
 * its own and is injected from the log in its turn.
 */

import { replaceAccessor, replaceValue } from "../context.js";
import {
  INPUT_EVENT_TYPES,
  dispatchedFromScript,
  isInputEvent,
  jsStackDepth,
  mediaQueryProp,
  mediaQueryTarget,
  VISUAL_VIEWPORT_EVENT_TYPES,
  VISUAL_VIEWPORT_TARGET,
} from "../seams-dom.js";
import { NOTIFICATION_EVENT_TYPES } from "../seams-notification.js";
import { patchStorageEvents } from "../seams-storage.js";
import { resolveTarget, targetOf } from "../targets.js";
import type { RecordOf } from "@codetracer/boundary-format";
import type { ReplayContext } from "./context.js";

/** `StorageRead.area` (§5.2). */
const Area = { local: 1, session: 2, cookie: 3 };
/** `StorageRead.present` of a read of an area's shape (§10.4). */
const SHAPE_READ = 2;

/** Replace every seam this module owns. */
export function replayDomSeams(ctx: ReplayContext): void {
  replayStorage(ctx);
  replayLayout(ctx);
}

function replayStorage(ctx: ReplayContext): void {
  const { w, replay, orig } = ctx;
  const areaOf = new Map<Storage, number>();
  for (const [name, area] of [
    ["localStorage", Area.local],
    ["sessionStorage", Area.session],
  ] as const) {
    const g = orig.storageAreas.get(name);
    if (g === undefined) continue;
    try {
      areaOf.set(g.descriptor.get!.call(w) as Storage, area);
    } catch {
      // Storage denied to this document: its getter throws, as on record.
    }
  }

  /** A key read: `present` 1 with the value, or 0 (§10.4). */
  const keyRead = (area: number, key: string) => {
    const r = replay.next("StorageRead", { area, key });
    if (r.present === SHAPE_READ) {
      replay.fail(
        "ArgumentMismatch",
        `the page read storage key ${JSON.stringify(key)}; the log has a read of the area's ${key}`,
      );
    }
    return r;
  };
  /** A read of the area's shape: `length`, `key` or `keys` (§10.4). */
  const shapeRead = (area: number, key: string): unknown => {
    const r = replay.next("StorageRead", { area, key, present: SHAPE_READ });
    return JSON.parse(r.value) as unknown;
  };

  const proxyOf = new Map<Storage, Storage>();
  const realOf = new WeakMap<object, Storage>();
  const unwrap = (s: unknown): unknown =>
    (typeof s === "object" || typeof s === "function") && s !== null
      ? (realOf.get(s) ?? s)
      : s;
  const areaOfThis = (s: unknown): number =>
    areaOf.get(unwrap(s) as Storage) ?? 0;
  const onPrototype = (t: object, p: string): boolean => {
    const proto = Reflect.getPrototypeOf(t);
    return proto !== null && Reflect.has(proto, p);
  };

  // The same traps as on record (seams-storage.ts), answering from the log.
  const wrap = (real: Storage, area: number): Storage => {
    const existing = proxyOf.get(real);
    if (existing !== undefined) return existing;
    const recv = (receiver: unknown) => (receiver === proxy ? real : receiver);
    const proxy: Storage = new Proxy(real, {
      get(t, p, receiver) {
        if (typeof p !== "string" || onPrototype(t, p)) {
          return Reflect.get(t, p, recv(receiver));
        }
        const r = keyRead(area, p);
        return r.present === 1 ? r.value : undefined;
      },
      has(t, p) {
        if (typeof p === "string" && !onPrototype(t, p)) {
          return keyRead(area, p).present === 1;
        }
        return Reflect.has(t, p);
      },
      getOwnPropertyDescriptor(t, p) {
        if (typeof p === "string" && !onPrototype(t, p)) {
          const r = keyRead(area, p);
          return r.present === 1
            ? {
                value: r.value,
                writable: true,
                enumerable: true,
                configurable: true,
              }
            : undefined;
        }
        return Reflect.getOwnPropertyDescriptor(t, p);
      },
      ownKeys() {
        const keys = shapeRead(area, "keys");
        return Array.isArray(keys) ? keys.map(String) : [];
      },
      set(t, p, v, receiver) {
        return Reflect.set(t, p, v, recv(receiver));
      },
    });
    proxyOf.set(real, proxy);
    realOf.set(proxy, real);
    return proxy;
  };

  for (const [name, g] of orig.storageAreas) {
    const get = g.descriptor.get!;
    replaceAccessor(
      g.owner,
      name,
      function (this: unknown) {
        const real = get.call(this) as Storage;
        const area = areaOf.get(real);
        return area === undefined ? real : wrap(real, area);
      },
      g.descriptor.set,
    );
  }

  patchStorageEvents(ctx, areaOf, wrap, unwrap);

  const origGet = orig.storageGetItem;
  replaceValue(
    w.Storage.prototype,
    "getItem",
    function getItem(this: unknown, key: unknown): string | null {
      const area = areaOfThis(this);
      if (area === 0 || arguments.length === 0) {
        return (origGet as (...a: unknown[]) => string | null).apply(
          unwrap(this),
          Array.from(arguments),
        );
      }
      const r = keyRead(area, `${key as string}`);
      return r.present === 1 ? r.value : null;
    },
  );
  for (const [name, f] of orig.storageMethods) {
    const patched =
      name === "key"
        ? function key(this: unknown): string | null {
            const area = areaOfThis(this);
            if (area === 0 || arguments.length === 0) {
              return f.apply(unwrap(this), Array.from(arguments)) as
                | string
                | null;
            }
            return shapeRead(area, "key") as string | null;
          }
        : function (this: unknown): unknown {
            return f.apply(unwrap(this), Array.from(arguments));
          };
    if (name !== "key") Object.defineProperty(patched, "name", { value: name });
    replaceValue(w.Storage.prototype, name, patched);
  }
  const length = orig.storageLength;
  if (length !== undefined) {
    const get = length.descriptor.get!;
    replaceAccessor(
      length.owner,
      "length",
      function (this: unknown) {
        const area = areaOfThis(this);
        if (area === 0) return get.call(unwrap(this)) as number;
        return Number(shapeRead(area, "length"));
      },
      length.descriptor.set,
    );
  }

  const cookie = orig.cookie;
  if (cookie !== undefined) {
    const get = cookie.descriptor.get!;
    const set = cookie.descriptor.set;
    replaceAccessor(
      cookie.owner,
      "cookie",
      function (this: unknown) {
        get.call(this); // the platform's receiver check, as on record
        return replay.next("StorageRead", { area: Area.cookie, key: "" }).value;
      },
      set === undefined
        ? undefined
        : function (this: unknown, v: unknown) {
            set.call(this, v);
          },
    );
  }
}

function replayLayout({
  w,
  replay,
  orig,
  mediaQueries,
  injection,
}: ReplayContext): void {
  const read = (target: unknown, prop: string): unknown =>
    JSON.parse(
      replay.next("LayoutRead", { target: targetOf(target), prop }).value,
    ) as unknown;

  const origRect = orig.getBoundingClientRect;
  replaceValue(
    w.Element.prototype,
    "getBoundingClientRect",
    function (this: Element): DOMRect {
      origRect.call(this); // the platform's receiver check
      const v = read(this, "getBoundingClientRect") as Record<string, number>;
      return new w.DOMRect(v.x, v.y, v.width, v.height);
    },
  );

  for (const [name, g] of orig.layoutGetters) {
    const get = g.descriptor.get!;
    const set = g.descriptor.set;
    replaceAccessor(
      g.owner,
      name,
      function (this: unknown) {
        get.call(this);
        return read(this, name);
      },
      set === undefined
        ? undefined
        : function (this: unknown, v: unknown) {
            set.call(this, v);
          },
    );
  }

  const origStyle = orig.getComputedStyle;
  replaceValue(
    w,
    "getComputedStyle",
    function getComputedStyle(
      el: Element,
      pseudo?: string | null,
    ): CSSStyleDeclaration {
      const style = origStyle.call(w, el, pseudo);
      const prefix = "getComputedStyle:" + (pseudo ? String(pseudo) + ":" : "");
      return new Proxy(style, {
        get(t, p) {
          const v = Reflect.get(t, p, t) as unknown;
          if (typeof p !== "string") return v;
          if (p === "getPropertyValue") {
            return function getPropertyValue(name: string): string {
              return read(el, prefix + String(name)) as string;
            };
          }
          if (typeof v === "function") return v.bind(t);
          return read(el, prefix + p);
        },
        set(t, p, v) {
          return Reflect.set(t, p, v, t);
        },
      });
    },
  );

  // The lists `matchMedia` makes (seams-dom.ts `patchMediaQueries`): each
  // read of `matches` answers from the log; each list is numbered as on
  // record, so an injected `change` finds it (`mql:<n>`), and the replay
  // browser's own `change`s, which are not the visitor's, never reach the
  // page.
  const origMatch = orig.matchMedia;
  if (origMatch !== undefined) {
    replaceValue(
      w,
      "matchMedia",
      function matchMedia(query: string): MediaQueryList {
        const m = origMatch.call(w, query);
        mediaQueries.set(mediaQueryTarget(mediaQueries.size + 1), m);
        orig.addEventListener.call(m, "change", (ev: Event) => {
          // An injected `change` passes no window listener: its depth is
          // measured here, first on the list (ReplayContext.injection).
          if (ev === injection.event) {
            injection.depth = jsStackDepth();
            return;
          }
          if (ev.isTrusted) ev.stopImmediatePropagation();
        });
        return m;
      },
    );
  }
  const matches = orig.mediaQueryMatches;
  if (matches !== undefined) {
    const get = matches.descriptor.get!;
    replaceAccessor(
      matches.owner,
      "matches",
      function (this: unknown) {
        get.call(this); // the platform's receiver check, as on record
        return (read(w, mediaQueryProp(this)) as { matches: boolean }).matches;
      },
      matches.descriptor.set,
    );
  }
}

/** Replay `pushState`/`replaceState` and the browser's navigation events. */
export function replayNavigation(ctx: ReplayContext): void {
  const { w, replay, orig } = ctx;
  /** The state the page left on each URL it put in the history. */
  const states = new Map<string, unknown>([[w.location.href, null]]);
  const nav = (kind: number) => {
    states.set(w.location.href, w.history.state);
    replay.next("Navigation", { kind, url: w.location.href });
  };
  replaceValue(
    w.History.prototype,
    "pushState",
    function pushState(
      this: History,
      ...args: Parameters<History["pushState"]>
    ): void {
      orig.pushState.apply(this, args);
      nav(1);
    },
  );
  replaceValue(
    w.History.prototype,
    "replaceState",
    function replaceState(
      this: History,
      ...args: Parameters<History["replaceState"]>
    ): void {
      orig.replaceState.apply(this, args);
      nav(2);
    },
  );

  // A popstate or hashchange the browser dispatched (Task{kind 12}, no
  // TaskReg): the page is moved to the logged URL, then the event is
  // dispatched with what the page's listeners read.
  replay.onUnregisteredTask(12, (task) => {
    ctx.claimTaskId(task.task_id);
    const v = replay.peek();
    if (v.kind !== "Navigation") {
      replay.fail(
        "MissingRead",
        "a navigation task is not followed by its Navigation record",
      );
    }
    const r = replay.next("Navigation");
    if (r.kind === 3) {
      const state = states.get(r.url) ?? null;
      orig.replaceState.call(w.history, state, "", r.url);
      ctx.trusted.dispatch(w, new w.PopStateEvent("popstate", { state }));
    } else if (r.kind === 4) {
      const oldURL = w.location.href;
      orig.replaceState.call(w.history, w.history.state, "", r.url);
      ctx.trusted.dispatch(
        w,
        new w.HashChangeEvent("hashchange", { oldURL, newURL: r.url }),
      );
    } else {
      replay.fail(
        "ArgumentMismatch",
        `a navigation task's Navigation is kind ${r.kind}, not popstate (3) or hashchange (4)`,
      );
    }
  });
}

/** How each captured event type is built: its interface and its flags. */
interface EventShape {
  ctor: string;
  bubbles: boolean;
  cancelable: boolean;
  /**
   * Whether the event crosses shadow boundaries; the UI events are, the
   * events the platform fires at the window, the document or a
   * `MediaQueryList` are not (DOM, "fire an event": `composed` defaults to
   * false). Absent means composed unless the type is `change` or `submit`.
   */
  composed?: boolean;
}

const POINTER: EventShape = {
  ctor: "PointerEvent",
  bubbles: true,
  cancelable: true,
};
const MOUSE: EventShape = {
  ctor: "MouseEvent",
  bubbles: true,
  cancelable: true,
};
const KEY: EventShape = {
  ctor: "KeyboardEvent",
  bubbles: true,
  cancelable: true,
};
const FOCUS: EventShape = {
  ctor: "FocusEvent",
  bubbles: false,
  cancelable: false,
};
const FOCUS_BUBBLING: EventShape = {
  ctor: "FocusEvent",
  bubbles: true,
  cancelable: false,
};
const TOUCH: EventShape = {
  ctor: "TouchEvent",
  bubbles: true,
  cancelable: true,
};
const COMPOSITION: EventShape = {
  ctor: "CompositionEvent",
  bubbles: true,
  cancelable: true,
};

/**
 * The interface and flags of each event type §10.2 captures, as the UI
 * Events, Pointer Events, Touch Events and HTML standards define them
 * (https://w3c.github.io/uievents/#events-mouse-types and the
 * corresponding tables). `click`, `auxclick` and `contextmenu` are
 * `PointerEvent`s in Chromium.
 */
const SHAPES: Record<string, EventShape> = {
  pointerdown: POINTER,
  pointerup: POINTER,
  pointermove: POINTER,
  pointercancel: { ...POINTER, cancelable: false },
  pointerover: POINTER,
  pointerout: POINTER,
  mousedown: MOUSE,
  mouseup: MOUSE,
  mousemove: MOUSE,
  mouseover: MOUSE,
  mouseout: MOUSE,
  click: POINTER,
  auxclick: POINTER,
  dblclick: MOUSE,
  contextmenu: POINTER,
  keydown: KEY,
  keypress: KEY,
  keyup: KEY,
  beforeinput: { ctor: "InputEvent", bubbles: true, cancelable: true },
  input: { ctor: "InputEvent", bubbles: true, cancelable: false },
  change: { ctor: "Event", bubbles: true, cancelable: false },
  submit: { ctor: "SubmitEvent", bubbles: true, cancelable: true },
  reset: { ctor: "Event", bubbles: true, cancelable: true },
  focus: FOCUS,
  blur: FOCUS,
  focusin: FOCUS_BUBBLING,
  focusout: FOCUS_BUBBLING,
  wheel: { ctor: "WheelEvent", bubbles: true, cancelable: true },
  touchstart: TOUCH,
  touchmove: TOUCH,
  touchend: TOUCH,
  touchcancel: { ...TOUCH, cancelable: false },
  scroll: { ctor: "Event", bubbles: false, cancelable: false },
  compositionstart: COMPOSITION,
  compositionupdate: COMPOSITION,
  compositionend: { ...COMPOSITION, cancelable: false },
  // HTML, "online and offline events": plain events at the window.
  online: { ctor: "Event", bubbles: false, cancelable: false },
  offline: { ctor: "Event", bubbles: false, cancelable: false },
  // CSSOM View, "run the resize steps": a plain `resize` at the window.
  resize: { ctor: "Event", bubbles: false, cancelable: false, composed: false },
  // HTML, "language preferences": a plain `languagechange` at the window.
  languagechange: {
    ctor: "Event",
    bubbles: false,
    cancelable: false,
    composed: false,
  },
  // HTML, "checking if unloading is canceled": a cancelable
  // `BeforeUnloadEvent` at the window, which script cannot construct
  // (`document.createEvent` makes one, DOM's legacy table).
  beforeunload: {
    ctor: "BeforeUnloadEvent",
    bubbles: false,
    cancelable: true,
    composed: false,
  },
  // HTML, "update the visibility state": `visibilitychange` at the document
  // bubbles.
  visibilitychange: {
    ctor: "Event",
    bubbles: true,
    cancelable: false,
    composed: false,
  },
  // Page Lifecycle, "freeze steps" and "resume steps": plain events at the
  // document.
  freeze: { ctor: "Event", bubbles: false, cancelable: false, composed: false },
  resume: { ctor: "Event", bubbles: false, cancelable: false, composed: false },
};

/**
 * A `MediaQueryList`'s `change` (CSSOM View, "evaluate media queries and
 * report changes"): a `MediaQueryListEvent` with the list's `matches` and
 * `media`, which does not bubble.
 */
const MEDIA_QUERY_CHANGE: EventShape = {
  ctor: "MediaQueryListEvent",
  bubbles: false,
  cancelable: false,
  composed: false,
};

/**
 * An event at the visual viewport (CSSOM View, "run the resize steps" and
 * "run the scroll steps"): a plain event that does not bubble.
 */
const VISUAL_VIEWPORT_EVENT: EventShape = {
  ctor: "Event",
  bubbles: false,
  cancelable: false,
  composed: false,
};

/**
 * An event at a notification (Notifications API, "fire an event named
 * show/close/error on notification"): a plain event that does not bubble.
 */
const NOTIFICATION_EVENT: EventShape = {
  ctor: "Event",
  bubbles: false,
  cancelable: false,
  composed: false,
};

/**
 * A notification's `click` (Notifications API, "activating a
 * notification"): a plain event, cancelable (cancelling it keeps the page
 * from being focused).
 */
const NOTIFICATION_CLICK: EventShape = {
  ctor: "Event",
  bubbles: false,
  cancelable: true,
  composed: false,
};

/** `DomEffect.effect` (§5.2). */
const Effect = {
  value: 1,
  checked: 2,
  selection: 3,
  scroll: 4,
  focus: 5,
  files: 6,
};

/** What the shim's replay mode publishes for the runner to inject with. */
export interface ReplayInjector {
  inject(input: RecordOf<"Input">, effects: RecordOf<"DomEffect">[]): string;
}

/**
 * Level-0 injection (§10.3), and the listener that keeps the platform's
 * own reactions to it from reaching the page.
 */
export function replayInput(ctx: ReplayContext): ReplayInjector {
  const { w } = ctx;
  const doc = w.document;
  const dispatch = w.EventTarget.prototype.dispatchEvent;
  // Captured before any page code, which may replace them.
  const OrigFile = w.File;
  const OrigBlob = w.Blob;
  const OrigDataTransfer = w.DataTransfer;
  // The input being dispatched and the stack depth its own listeners run
  // at (ReplayContext.injection), and whether replay is applying an input's
  // effects (see the stopper below).
  const injection = ctx.injection;
  let applying = false;

  for (const type of INPUT_EVENT_TYPES) {
    ctx.orig.addEventListener.call(
      w,
      type,
      (ev: Event) => {
        if (ev === injection.event) {
          // The depth the injected event's own listeners run at.
          injection.depth = jsStackDepth();
          return;
        }
        if (!ev.isTrusted || !isInputEvent(w, ev)) return;
        // A trusted event the page's own replayed code dispatches inside a
        // call (`focus()`, `requestSubmit()`, a navigation's
        // `beforeunload`) is the one the visitor's page saw there, which
        // the recorder did not log as input (seams-dom.ts,
        // `listenForPageEvents`), and reaches the page. Script lies below
        // its listener: outside an injection any; inside one, more than
        // below the injected event's own listeners, since the page's
        // listener made the call. What the platform dispatches in reaction
        // to an injected event (a checkbox's `input` and `change` after
        // its `click`) runs at the injected event's own depth, and what it
        // dispatches as an effect is applied (`focus()` for a focus effect)
        // is replay's own: each was recorded as input of its own, and is
        // injected from the log in its turn.
        if (!applying) {
          const depth = jsStackDepth();
          const pageCaused =
            injection.event === undefined ? depth > 1 : depth > injection.depth;
          if (pageCaused) return;
        }
        ev.stopImmediatePropagation();
        if (ev.cancelable) ev.preventDefault();
      },
      { capture: true },
    );
  }
  // The visual viewport's own events on replay are not the visitor's: they
  // never reach the page, and the visitor's are injected from the log.
  const vv = w.visualViewport;
  if (vv !== null && vv !== undefined) {
    for (const type of VISUAL_VIEWPORT_EVENT_TYPES) {
      ctx.orig.addEventListener.call(vv, type, (ev: Event) => {
        // An injected one passes no window listener: its depth is measured
        // here, first on the viewport (ReplayContext.injection).
        if (ev === injection.event) {
          injection.depth = jsStackDepth();
          return;
        }
        if (ev.isTrusted) ev.stopImmediatePropagation();
      });
    }
  }
  // The replay browser's own navigation events: a traversal's `popstate`,
  // a link's (an injected click activates it, where the visitor's click
  // did) and every `hashchange` are tasks the log has (`Task{kind 12}`),
  // which `replayNavigation` dispatches in their place, so the platform's are
  // held back; a fragment navigation's `popstate`, fired synchronously by the
  // page's own replayed code (seams-dom.ts, `listenForPageEvents`), is the
  // one the visitor's page saw, and reaches it.
  for (const type of ["popstate", "hashchange"]) {
    ctx.orig.addEventListener.call(
      w,
      type,
      (ev: Event) => {
        if (!ev.isTrusted) return;
        const fromPage =
          dispatchedFromScript() && injection.event === undefined;
        if (type === "popstate" && fromPage) return;
        ev.stopImmediatePropagation();
      },
      { capture: true },
    );
  }

  /** The element (or document) a target names, for an effect. */
  const scrollerOf = (t: Element | Document | Window): Element | null =>
    t instanceof w.Element ? t : (doc.scrollingElement ?? doc.documentElement);

  const apply = (e: RecordOf<"DomEffect">): string | undefined => {
    const t = resolveTarget(e.target, doc);
    if (t === null) return `DomEffect target ${e.target} does not resolve`;
    const v = JSON.parse(e.value) as unknown;
    const el = t as HTMLInputElement;
    switch (e.effect) {
      case Effect.value:
        el.value = String(v);
        return undefined;
      case Effect.checked:
        el.checked = v === true;
        return undefined;
      case Effect.selection: {
        const s = v as { start: number; end: number; direction?: string };
        try {
          el.setSelectionRange(
            s.start,
            s.end,
            (s.direction ?? undefined) as "forward" | "backward" | "none",
          );
        } catch {
          // A control without a selection: nothing was recorded for it.
        }
        return undefined;
      }
      case Effect.scroll: {
        const s = v as { top: number; left: number };
        const scroller = scrollerOf(t);
        if (scroller === null) return `no element scrolls for ${e.target}`;
        scroller.scrollTop = s.top;
        scroller.scrollLeft = s.left;
        return undefined;
      }
      case Effect.focus:
        if (t instanceof w.HTMLElement || t instanceof w.SVGElement) t.focus();
        return undefined;
      case Effect.files:
        return setFiles(el, v);
      default:
        return `unknown DomEffect ${e.effect}`;
    }
  };

  /**
   * Give a file input the files the user chose, in the recorded shape
   * (`fileJson`, seams-dom.ts): name, size, type, modification time and
   * relative path. Their contents were not recorded: on record, a read of
   * them was refused (`file-content`), and that refusal ends the replay
   * where the page reads them, so these bytes are never what it computes on.
   */
  const setFiles = (el: HTMLInputElement, v: unknown): string | undefined => {
    if (!(el instanceof w.HTMLInputElement) || el.type !== "file") {
      return "a files effect names an element that is not a file input";
    }
    if (OrigDataTransfer === undefined || OrigFile === undefined) {
      return "this browser cannot set a file input's files";
    }
    // The same choice, effect after effect (an `input` and its `change`),
    // is the same `FileList` of the same files, as on record.
    const json = JSON.stringify(v);
    const last = chosen.get(el);
    if (last?.json === json) {
      if (el.files !== last.files) el.files = last.files;
      return undefined;
    }
    const dt = new OrigDataTransfer();
    for (const f of Array.isArray(v) ? v : []) {
      const j = f as {
        name: string;
        size: number;
        type: string;
        lastModified: number;
        webkitRelativePath?: string;
      };
      if (!Number.isSafeInteger(j.size) || j.size < 0) {
        return `a files effect has a file of size ${JSON.stringify(j.size)}`;
      }
      const file = new OrigFile(zeroParts(j.size), j.name, {
        type: j.type,
        lastModified: j.lastModified,
      });
      if (j.webkitRelativePath) {
        Object.defineProperty(file, "webkitRelativePath", {
          value: j.webkitRelativePath,
          enumerable: true,
        });
      }
      dt.items.add(file);
    }
    el.files = dt.files;
    chosen.set(el, { json, files: dt.files });
    return undefined;
  };
  const chosen = new WeakMap<object, { json: string; files: FileList }>();

  /**
   * The parts of a file of `size` zero bytes, without holding `size` bytes:
   * a user may choose a file of gigabytes, which one array could not hold.
   * A `Blob` part is kept by reference (File API, "process blob parts": a
   * `Blob` element contributes its bytes, which Chromium shares rather than
   * copies; https://w3c.github.io/FileAPI/#process-blob-parts), so the file
   * is made of references to one 1 MiB zero blob and a slice of it.
   */
  const ZERO_CHUNK = 1 << 20;
  let zeroChunk: Blob | undefined;
  const zeroParts = (size: number): BlobPart[] => {
    if (size <= ZERO_CHUNK) return [new Uint8Array(size)];
    zeroChunk ??= new OrigBlob([new Uint8Array(ZERO_CHUNK)]);
    const parts: BlobPart[] = [];
    let left = size;
    for (; left >= ZERO_CHUNK; left -= ZERO_CHUNK) parts.push(zeroChunk);
    if (left > 0) parts.push(zeroChunk.slice(0, left));
    return parts;
  };

  /**
   * An event of `shape`'s interface. A `BeforeUnloadEvent` has no
   * constructor (HTML: it is created only by the platform), so it is made by
   * `document.createEvent`, whose legacy table has it
   * (https://dom.spec.whatwg.org/#dom-document-createevent), and initialised
   * with the type and flags; it carries no recorded property.
   */
  const newEvent = (shape: EventShape, type: string, init: EventInit) => {
    if (shape.ctor === "BeforeUnloadEvent") {
      const ev = doc.createEvent("BeforeUnloadEvent");
      ev.initEvent(type, init.bubbles, init.cancelable);
      return ev;
    }
    const Ctor =
      ((w as unknown as Record<string, typeof Event | undefined>)[
        shape.ctor
      ] as typeof Event | undefined) ?? w.Event;
    return new Ctor(type, init);
  };

  return {
    inject(input, effects) {
      ctx.claimTaskId(input.task_id);
      applying = true;
      try {
        for (const e of effects) {
          const problem = apply(e);
          if (problem !== undefined) return problem;
        }
      } finally {
        applying = false;
      }
      // A `MediaQueryList` the page made (`mql:<n>`) is no node: it is
      // found among the lists, and only its `change` is input.
      // So is the visual viewport (`visualViewport`), whose events are
      // plain ones.
      // So is a notification the page made (`notification:<n>`), whose
      // events are plain ones too.
      const isList = input.target.startsWith("mql:");
      const isViewport = input.target === VISUAL_VIEWPORT_TARGET;
      const isNotification = input.target.startsWith("notification:");
      const target: EventTarget | null = isList
        ? (ctx.mediaQueries.get(input.target) ?? null)
        : isViewport
          ? (w.visualViewport ?? null)
          : isNotification
            ? (ctx.notifications.get(input.target) ?? null)
            : resolveTarget(input.target, doc);
      if (target === null) return `target ${input.target} does not resolve`;
      const shape = isList
        ? input.type === "change"
          ? MEDIA_QUERY_CHANGE
          : undefined
        : isViewport
          ? VISUAL_VIEWPORT_EVENT_TYPES.includes(input.type)
            ? VISUAL_VIEWPORT_EVENT
            : undefined
          : isNotification
            ? NOTIFICATION_EVENT_TYPES.includes(input.type)
              ? input.type === "click"
                ? NOTIFICATION_CLICK
                : NOTIFICATION_EVENT
              : undefined
            : SHAPES[input.type];
      if (shape === undefined)
        return `event type ${input.type} is not captured`;
      const props = JSON.parse(input.props) as Record<string, unknown>;
      delete props.touches;
      delete props.changedTouches;
      const bubbles = input.type === "scroll" ? target === doc : shape.bubbles;
      const ev = newEvent(shape, input.type, {
        ...props,
        bubbles,
        cancelable: shape.cancelable,
        composed:
          shape.composed ??
          (input.type !== "change" && input.type !== "submit"),
        view: w,
      } as EventInit);
      // A synthetic click on a checkbox or radio toggles it before the
      // listeners run (HTML "legacy-pre-activation behavior"): start from
      // the state before the recorded click, so the listeners see the
      // recorded one.
      const el = target as HTMLInputElement;
      if (
        input.type === "click" &&
        el instanceof w.HTMLInputElement &&
        (el.type === "checkbox" || el.type === "radio")
      ) {
        const after = [...effects]
          .reverse()
          .find((e) => e.effect === Effect.checked);
        if (after !== undefined) {
          const checked = JSON.parse(after.value) === true;
          el.checked = el.type === "checkbox" ? !checked : false;
        }
      }
      // Until the injected event's own listener measures it, every trusted
      // event of a captured type is the platform's reaction.
      injection.depth = Infinity;
      injection.event = ev;
      try {
        dispatch.call(target, ev);
      } finally {
        injection.event = undefined;
      }
      return "ok";
    },
  };
}

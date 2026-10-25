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
import { INPUT_EVENT_TYPES } from "../seams-dom.js";
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

function replayLayout({ w, replay, orig }: ReplayContext): void {
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

  const origMatch = orig.matchMedia;
  if (origMatch !== undefined) {
    replaceValue(
      w,
      "matchMedia",
      function matchMedia(query: string): MediaQueryList {
        const m = origMatch.call(w, query);
        const v = read(w, "matchMedia:" + String(query)) as {
          matches: boolean;
        };
        Object.defineProperty(m, "matches", {
          get: () => v.matches,
          configurable: true,
        });
        return m;
      },
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
  let injecting: Event | undefined;

  for (const type of INPUT_EVENT_TYPES) {
    ctx.orig.addEventListener.call(
      w,
      type,
      (ev: Event) => {
        if (ev.isTrusted && ev !== injecting) {
          ev.stopImmediatePropagation();
          if (ev.cancelable) ev.preventDefault();
        }
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

  return {
    inject(input, effects) {
      ctx.claimTaskId(input.task_id);
      for (const e of effects) {
        const problem = apply(e);
        if (problem !== undefined) return problem;
      }
      const target = resolveTarget(input.target, doc);
      if (target === null) return `target ${input.target} does not resolve`;
      const shape = SHAPES[input.type];
      if (shape === undefined)
        return `event type ${input.type} is not captured`;
      const props = JSON.parse(input.props) as Record<string, unknown>;
      delete props.touches;
      delete props.changedTouches;
      const Ctor =
        ((w as unknown as Record<string, typeof Event | undefined>)[
          shape.ctor
        ] as typeof Event | undefined) ?? w.Event;
      const bubbles = input.type === "scroll" ? target === doc : shape.bubbles;
      const ev = new Ctor(input.type, {
        ...props,
        bubbles,
        cancelable: shape.cancelable,
        composed: input.type !== "change" && input.type !== "submit",
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
      injecting = ev;
      try {
        dispatch.call(target, ev);
      } finally {
        injecting = undefined;
      }
      return "ok";
    },
  };
}

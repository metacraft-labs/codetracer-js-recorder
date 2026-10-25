/**
 * Storage, layout, navigation and input seams (JS-Boundary-Recording.md
 * §5.2 `StorageRead`, `LayoutRead`, `Navigation`, `Input`, `DomEffect`;
 * §10.1, §10.2). Storage is in seams-storage.ts.
 */

import { type SeamContext, replaceAccessor, replaceValue } from "./context.js";
import { TaskKind } from "./recorder.js";
import { patchStorage } from "./seams-storage.js";
import { targetOf } from "./targets.js";

/** Patch every seam this module owns. */
export function patchDomSeams(ctx: SeamContext): void {
  patchStorage(ctx);
  patchLayout(ctx);
  patchHistory(ctx);
}

function patchLayout(ctx: SeamContext): void {
  const { w, rec, orig } = ctx;
  const read = (target: unknown, prop: string, value: unknown) =>
    rec.guard(() =>
      rec.emit("LayoutRead", {
        target: targetOf(target),
        prop,
        value: JSON.stringify(value === undefined ? null : value),
      }),
    );

  const origRect = orig.getBoundingClientRect;
  replaceValue(
    w.Element.prototype,
    "getBoundingClientRect",
    function (this: Element): DOMRect {
      const r = origRect.call(this);
      read(this, "getBoundingClientRect", {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
        left: r.left,
      });
      return r;
    },
  );

  for (const [name, g] of orig.layoutGetters) {
    const get = g.descriptor.get!;
    const set = g.descriptor.set;
    replaceAccessor(
      g.owner,
      name,
      function (this: unknown) {
        const v = get.call(this);
        read(this, name, v);
        return v;
      },
      set === undefined
        ? undefined
        : function (this: unknown, v: unknown) {
            set.call(this, v);
          },
    );
  }

  // getComputedStyle returns a live declaration whose properties are read
  // later; each read is logged when it happens, by a proxy that forwards
  // everything else unchanged.
  const origStyle = orig.getComputedStyle;
  replaceValue(
    w,
    "getComputedStyle",
    function getComputedStyle(
      el: Element,
      pseudo?: string | null,
    ): CSSStyleDeclaration {
      const style = origStyle.call(w, el, pseudo);
      if (!rec.recording) return style;
      const prefix = "getComputedStyle:" + (pseudo ? String(pseudo) + ":" : "");
      return new Proxy(style, {
        get(t, p) {
          const v = Reflect.get(t, p, t) as unknown;
          if (typeof p !== "string") return v;
          if (p === "getPropertyValue") {
            return function getPropertyValue(name: string): string {
              const r = t.getPropertyValue(name);
              read(el, prefix + String(name), r);
              return r;
            };
          }
          if (typeof v === "function") return v.bind(t);
          read(el, prefix + p, v);
          return v;
        },
        set(t, p, v) {
          return Reflect.set(t, p, v, t);
        },
      });
    },
  );

  patchMediaQueries(ctx);
}

/**
 * `matchMedia` and the lists it makes (CSSOM View, "The MediaQueryList
 * interface", https://drafts.csswg.org/cssom-view/#the-mediaquerylist-interface).
 *
 * A list's `matches` is evaluated against the visitor's viewport, screen
 * and preferences each time it is read, so every read is a `LayoutRead`
 * (target `win`, prop `matchMedia:<media>`, `{matches}`), `<media>` the
 * list's serialised query (its `media`, which the same engine serialises the
 * same way on replay).
 *
 * The browser dispatches `change` at a list when its `matches` flips (the
 * rendering steps' "evaluate media queries and report changes"). A list is
 * no node, so the window's listeners never see it: the shim listens on each
 * list as `matchMedia` makes it, before the page can, and records a trusted
 * `change` as input at target `mql:<n>`, the n-th list the page made
 * (counting from 1; the page's code makes them in the same order on replay),
 * with the event's `matches` and `media`.
 */
function patchMediaQueries(ctx: SeamContext): void {
  const { w, rec, orig } = ctx;
  const origMatch = orig.matchMedia;
  if (origMatch === undefined) return;
  let made = 0;
  replaceValue(
    w,
    "matchMedia",
    function matchMedia(query: string): MediaQueryList {
      const m = origMatch.call(w, query);
      const target = mediaQueryTarget(++made);
      orig.addEventListener.call(m, "change", (ev: Event) => {
        if (!ev.isTrusted || !rec.recording) return;
        rec.guard(() => recordInput(ctx, ev, target));
      });
      return m;
    },
  );
  const matches = orig.mediaQueryMatches;
  if (matches === undefined) return;
  const get = matches.descriptor.get!;
  replaceAccessor(
    matches.owner,
    "matches",
    function (this: unknown) {
      const v = get.call(this) as boolean;
      rec.guard(() =>
        rec.emit("LayoutRead", {
          target: "win",
          prop: mediaQueryProp(this),
          value: JSON.stringify({ matches: v }),
        }),
      );
      return v;
    },
    matches.descriptor.set,
  );
}

/** The target of the n-th `MediaQueryList` the page made (§9.3, §10.2). */
export function mediaQueryTarget(n: number): string {
  return `mql:${n}`;
}

/**
 * The `LayoutRead.prop` of a read of list `m`'s `matches`:
 * `matchMedia:<media>`.
 */
export function mediaQueryProp(m: unknown): string {
  let media = "";
  try {
    media = String((m as { media?: unknown }).media ?? "");
  } catch {
    media = "";
  }
  return "matchMedia:" + media;
}

function patchHistory({ w, rec, orig }: SeamContext): void {
  const nav = (kind: number) =>
    rec.guard(() => rec.emit("Navigation", { kind, url: w.location.href }));
  const origPush = orig.pushState;
  const origReplace = orig.replaceState;
  replaceValue(
    w.History.prototype,
    "pushState",
    function pushState(
      this: History,
      ...args: Parameters<History["pushState"]>
    ): void {
      origPush.apply(this, args);
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
      origReplace.apply(this, args);
      nav(2);
    },
  );
}

/**
 * Listen, on the window in the capture phase, for the events the browser
 * dispatches to the page: input (§10.2) and navigation. Registered at
 * install, before any page code, so these listeners run before every
 * listener the page adds and the records they write precede everything
 * the page's handlers read.
 */
export function listenForPageEvents(
  ctx: SeamContext,
  onPageHide: () => void,
): void {
  const { w, rec, orig } = ctx;
  const add = (type: string, l: (ev: Event) => void) =>
    orig.addEventListener.call(w, type, l, { capture: true, passive: true });

  for (const type of INPUT_EVENT_TYPES) {
    add(type, (ev) => {
      // Events the page dispatches itself are its own deterministic
      // behaviour and happen again on replay; only the browser's are input.
      if (!ev.isTrusted || !rec.recording || !isInputEvent(w, ev)) return;
      // A trusted event the page's own code dispatches inside one of its
      // calls is the page's deterministic behaviour, in a task the log
      // already has, and the replayed code dispatches it again there: the
      // `focus`, `blur`, `focusin` and `focusout` of `focus()` and `blur()`,
      // the `submit` of `requestSubmit()`, the `reset` of `reset()`, the
      // `input` and `change` of a checkbox's `click()`, the `beforeunload`
      // of a navigation the page starts (`location.href = …`; HTML,
      // "checking if unloading is canceled"). Only what the browser
      // dispatches from a task of its own (the user's input, the
      // environment changing) is input.
      if (dispatchedFromScript()) return;
      // Chromium dispatches `beforeunload` at the window alone with the
      // document as its `target` (as it does `load`); only the window's
      // listeners see it, so it is input at `win`, where replay injects it.
      rec.guard(() =>
        recordInput(ctx, ev, ev.type === "beforeunload" ? "win" : undefined),
      );
    });
  }

  // The visual viewport is no node, so the window's listeners never see its
  // events: the shim listens on it, first, and records each trusted one as
  // input at target `visualViewport`.
  const vv = w.visualViewport;
  if (vv !== null && vv !== undefined) {
    for (const type of VISUAL_VIEWPORT_EVENT_TYPES) {
      orig.addEventListener.call(vv, type, (ev: Event) => {
        if (!ev.isTrusted || !rec.recording) return;
        rec.guard(() => recordInput(ctx, ev, VISUAL_VIEWPORT_TARGET));
      });
    }
  }

  for (const [type, kind] of [
    ["popstate", 3],
    ["hashchange", 4],
  ] as const) {
    add(type, (ev) => {
      if (!ev.isTrusted || !rec.recording) return;
      // A fragment navigation the page's code makes (`location.hash = …`)
      // fires `popstate` synchronously, inside that call (HTML, "navigate to
      // a fragment" → "update document for history step application"): it
      // runs inside a task the log already has, and the replayed code fires
      // it again there. Every other `popstate` (a traversal's, or a link the
      // user activated, after the click's listeners) and every `hashchange`
      // (which is queued) is a task of its own.
      if (type === "popstate" && dispatchedFromScript()) return;
      rec.guard(() => {
        // Dispatched by the browser, not registered by the page: the task
        // id is minted here, and no TaskReg precedes it.
        rec.task(rec.nextTaskId(), TaskKind.navigation);
        rec.emit("Navigation", { kind, url: w.location.href });
      });
    });
  }

  add("pagehide", (ev) => {
    if (!ev.isTrusted || !rec.recording) return;
    rec.guard(() => rec.emit("Navigation", { kind: 5, url: w.location.href }));
    onPageHide();
  });
}

/**
 * The realm's own `Error`, captured when the shim's bundle runs, before any
 * page code. The stack tests below read V8's structured stack through it
 * (`prepareStackTrace` is looked up on this intrinsic, never on whatever the
 * global `Error` names later), so a page that replaces the global (with a
 * function that makes the platform's errors, as error-tracking and zone
 * libraries have done) neither adds its own frame to every stack nor turns
 * the structured read into the text fallback: either made every event
 * the browser dispatched look dispatched from script, and no input was
 * recorded at all.
 */
const NativeError = Error as ErrorConstructor & {
  stackTraceLimit?: number;
  prepareStackTrace?: (e: Error, frames: unknown[]) => unknown;
};

/**
 * Whether the event whose capture listener calls this (directly, as its
 * first frame) was dispatched synchronously from script: a JavaScript frame
 * lies below the listener's (the page's `location.hash = …`, an injected
 * click's activation), rather than the listener being called from a task
 * of the platform's. Read from V8's structured stack (`prepareStackTrace`,
 * https://v8.dev/docs/stack-trace-api), set only for this one capture and
 * restored, with the text of the stack as the fallback of another engine.
 */
export function dispatchedFromScript(): boolean {
  const E = NativeError;
  const limit = E.stackTraceLimit;
  const prepare = E.prepareStackTrace;
  try {
    E.stackTraceLimit = 4;
    E.prepareStackTrace = (_e, frames) => frames.length;
    const stack = new E().stack as unknown;
    // This function's frame, the listener's, then whatever dispatched.
    if (typeof stack === "number") return stack > 2;
    const lines = String(stack ?? "")
      .split("\n")
      .filter((l) => /\S/.test(l) && !/^Error\b/.test(l));
    return lines.length > 2;
  } catch {
    return false;
  } finally {
    E.prepareStackTrace = prepare;
    E.stackTraceLimit = limit;
  }
}

/**
 * The number of JavaScript frames on the stack of the function that calls
 * this, itself included (1 for a listener the platform called from a task
 * of its own; more when script lies below it). Read from V8's structured
 * stack with no frame limit, set only for this one capture and restored,
 * with the text of the stack as the fallback of another engine. Replay
 * tells the platform's reaction to an event it injected from an event the
 * page's own listener caused with it (replay/dom.ts, `replayInput`).
 */
export function jsStackDepth(): number {
  const E = NativeError;
  const limit = E.stackTraceLimit;
  const prepare = E.prepareStackTrace;
  try {
    E.stackTraceLimit = Infinity;
    E.prepareStackTrace = (_e, frames) => frames.length;
    const stack = new E().stack as unknown;
    // This function's frame is not counted.
    if (typeof stack === "number") return stack - 1;
    const lines = String(stack ?? "")
      .split("\n")
      .filter((l) => /\S/.test(l) && !/^Error\b/.test(l));
    return lines.length - 1;
  } catch {
    return 1;
  } finally {
    E.prepareStackTrace = prepare;
    E.stackTraceLimit = limit;
  }
}

/** The DOM events §10.2 captures, by group. */
export const INPUT_EVENT_TYPES: readonly string[] = [
  // pointer
  "pointerdown",
  "pointerup",
  "pointermove",
  "pointercancel",
  "pointerover",
  "pointerout",
  // mouse
  "mousedown",
  "mouseup",
  "mousemove",
  "mouseover",
  "mouseout",
  "click",
  "auxclick",
  "dblclick",
  "contextmenu",
  // keyboard
  "keydown",
  "keypress",
  "keyup",
  // input and change
  "beforeinput",
  "input",
  "change",
  // submit
  "submit",
  "reset",
  // focus
  "focus",
  "blur",
  "focusin",
  "focusout",
  // wheel
  "wheel",
  // touch
  "touchstart",
  "touchmove",
  "touchend",
  "touchcancel",
  // scroll
  "scroll",
  // composition
  "compositionstart",
  "compositionupdate",
  "compositionend",
  // the network coming and going (the platform's `navigator.onLine`, which
  // the page then reads, is logged too: seams-environment.ts)
  "online",
  "offline",
  // the page's environment changing under it, at the window: its viewport
  // (`resize`, which a zoom also fires; the window's own only, see
  // WINDOW_ONLY_INPUT_TYPES), the user's languages (`languagechange`), the
  // user leaving (`beforeunload`); at the document: its visibility
  // (`visibilitychange`) and the browser freezing and resuming it (Page
  // Lifecycle `freeze` and `resume`). What the page then reads of that
  // state (`innerWidth`, `devicePixelRatio`, `navigator.languages`,
  // `document.visibilityState`, …) is logged where it reads it.
  "resize",
  "languagechange",
  "beforeunload",
  "visibilitychange",
  "freeze",
  "resume",
];

/**
 * The events the browser dispatches at `window.visualViewport` when the
 * visitor pinch-zooms, pans or the on-screen keyboard resizes it (CSSOM
 * View, "The VisualViewport interface"), recorded as input at
 * {@link VISUAL_VIEWPORT_TARGET}.
 */
export const VISUAL_VIEWPORT_EVENT_TYPES: readonly string[] = [
  "resize",
  "scroll",
  "scrollend",
];

/** The target of `window.visualViewport`'s events (§9.3, §10.2). */
export const VISUAL_VIEWPORT_TARGET = "visualViewport";

/**
 * The input types that are input only at the window: a media element
 * dispatches a `resize` of its own when its video's size changes, a
 * resource event of the document's (resource-events.ts), whose capture
 * reaches the window's listeners too.
 */
export const WINDOW_ONLY_INPUT_TYPES: ReadonlySet<string> = new Set(["resize"]);

/**
 * Whether `ev`, of a type of {@link INPUT_EVENT_TYPES}, is input: every
 * event of those types but a {@link WINDOW_ONLY_INPUT_TYPES} one at another
 * target than the window `w`. Shared by record and replay.
 */
export function isInputEvent(w: Window, ev: Event): boolean {
  return !WINDOW_ONLY_INPUT_TYPES.has(ev.type) || ev.target === w;
}

/** The event properties `Input.props` carries, when the event has them. */
const INPUT_PROPS: readonly string[] = [
  "key",
  "code",
  "location",
  "repeat",
  "isComposing",
  "ctrlKey",
  "shiftKey",
  "altKey",
  "metaKey",
  "clientX",
  "clientY",
  "screenX",
  "screenY",
  "button",
  "buttons",
  "detail",
  "pointerId",
  "pointerType",
  "pressure",
  "width",
  "height",
  "isPrimary",
  "deltaX",
  "deltaY",
  "deltaZ",
  "deltaMode",
  "data",
  "inputType",
  // a `MediaQueryList`'s `change` (MediaQueryListEvent)
  "matches",
  "media",
];

function eventProps(ev: Event): string {
  const props: Record<string, unknown> = {};
  const e = ev as unknown as Record<string, unknown>;
  for (const k of INPUT_PROPS) {
    if (!(k in ev)) continue;
    const v = e[k];
    if (
      v === null ||
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean"
    ) {
      props[k] = v;
    }
  }
  for (const k of ["touches", "changedTouches"]) {
    const list = e[k] as TouchList | undefined;
    if (list === undefined || list === null) continue;
    const touches = [];
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      touches.push({
        identifier: t.identifier,
        clientX: t.clientX,
        clientY: t.clientY,
        screenX: t.screenX,
        screenY: t.screenY,
      });
    }
    props[k] = touches;
  }
  return JSON.stringify(props);
}

/** `DomEffect.effect` (§5.2). */
const Effect = {
  value: 1,
  checked: 2,
  selection: 3,
  scroll: 4,
  focus: 5,
  files: 6,
};

/**
 * An input event: the start of a macrotask (`Loading` while the document
 * loads, a checkpoint if one is due), the `DomEffect`s of default actions
 * that already changed state, then `Task{kind: input}` and `Input` (§9.5's
 * order, at level 0). `name` is the target's name when it is no node or
 * window (a `MediaQueryList`'s `mql:<n>`).
 */
export function recordInput(
  ctx: SeamContext,
  ev: Event,
  name = targetOf(ev.target),
): void {
  const { rec } = ctx;
  rec.macrotask();
  for (const [effect, value] of domEffects(ctx, ev)) {
    rec.emit("DomEffect", {
      target: name,
      effect,
      value: JSON.stringify(value),
    });
  }
  const taskId = rec.nextTaskId();
  // Dispatched by the browser, not registered by the page: the task id is
  // minted here, and no TaskReg precedes it.
  rec.emit("Task", { task_id: taskId, kind: TaskKind.input });
  rec.emit("Input", {
    task_id: taskId,
    type: ev.type,
    target: name,
    props: eventProps(ev),
    label: "",
  });
}

/** The state a default action has already changed when `ev` reaches the window. */
function domEffects(ctx: SeamContext, ev: Event): [number, unknown][] {
  const t = ev.target as Element | Document | null;
  const out: [number, unknown][] = [];
  if (t === null) return out;
  const tag = (t as Element).localName;
  const isControl = tag === "input" || tag === "textarea" || tag === "select";
  if (ev.type === "scroll") {
    const el =
      t instanceof ctx.w.Document
        ? (t.scrollingElement ?? t.documentElement)
        : t;
    if (el !== null) {
      const top = ctx.orig.layoutGetters.get("scrollTop")!.descriptor.get!;
      const left = ctx.orig.layoutGetters.get("scrollLeft")!.descriptor.get!;
      out.push([Effect.scroll, { top: top.call(el), left: left.call(el) }]);
    }
  } else if (ev.type === "focus" || ev.type === "focusin") {
    out.push([Effect.focus, true]);
  } else if (isControl) {
    const c = t as HTMLInputElement;
    const checkable =
      tag === "input" && (c.type === "checkbox" || c.type === "radio");
    if (
      checkable &&
      (ev.type === "click" || ev.type === "input" || ev.type === "change")
    ) {
      out.push([Effect.checked, c.checked]);
    } else if (ev.type === "input" || ev.type === "change") {
      if (tag === "input" && c.type === "file") {
        const files = [];
        for (const f of Array.from(c.files ?? [])) {
          files.push(fileJson(f));
        }
        out.push([Effect.files, files]);
      } else {
        out.push([Effect.value, c.value]);
        const sel = selection(c);
        if (sel !== null) out.push([Effect.selection, sel]);
      }
    }
  }
  return out;
}

/**
 * What a page can read of a file a user chose without reading its contents
 * (File API: `name`, `size`, `type`, `lastModified`; File and Directory
 * Entries API: `webkitRelativePath`), the `files` effect's element (§10.2).
 * Replay hands the page files of exactly this shape; their contents are not
 * recorded (seams-platform.ts).
 */
export function fileJson(f: File): {
  name: string;
  size: number;
  type: string;
  lastModified: number;
  webkitRelativePath: string;
} {
  return {
    name: f.name,
    size: f.size,
    type: f.type,
    lastModified: f.lastModified,
    webkitRelativePath: f.webkitRelativePath ?? "",
  };
}

/** The selection range of a text control, or `null` for one without. */
function selection(c: HTMLInputElement): unknown {
  try {
    if (c.selectionStart === null || c.selectionEnd === null) return null;
    return {
      start: c.selectionStart,
      end: c.selectionEnd,
      direction: c.selectionDirection,
    };
  } catch {
    return null; // input types without a selection throw on access
  }
}

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

function patchLayout({ w, rec, orig }: SeamContext): void {
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

  const origMatch = orig.matchMedia;
  if (origMatch !== undefined) {
    replaceValue(
      w,
      "matchMedia",
      function matchMedia(query: string): MediaQueryList {
        const m = origMatch.call(w, query);
        read(w, "matchMedia:" + String(query), { matches: m.matches });
        return m;
      },
    );
  }
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
      if (!ev.isTrusted || !rec.recording) return;
      rec.guard(() => recordInput(ctx, ev));
    });
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
 * Whether the event whose capture listener calls this (directly, as its
 * first frame) was dispatched synchronously from script: a JavaScript frame
 * lies below the listener's (the page's `location.hash = …`, an injected
 * click's activation), rather than the listener being called from a task
 * of the platform's. Read from V8's structured stack (`prepareStackTrace`,
 * https://v8.dev/docs/stack-trace-api), set only for this one capture and
 * restored, with the text of the stack as the fallback of another engine.
 */
export function dispatchedFromScript(): boolean {
  const E = Error as ErrorConstructor & {
    stackTraceLimit?: number;
    prepareStackTrace?: (e: Error, frames: unknown[]) => unknown;
  };
  const limit = E.stackTraceLimit;
  const prepare = E.prepareStackTrace;
  try {
    E.stackTraceLimit = 4;
    E.prepareStackTrace = (_e, frames) => frames.length;
    const stack = new Error().stack as unknown;
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
];

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
 * order, at level 0).
 */
function recordInput(ctx: SeamContext, ev: Event): void {
  const { rec } = ctx;
  rec.macrotask();
  const target = ev.target;
  const name = targetOf(target);
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

/**
 * Where the document is in its own loading, and the tasks of that loading
 * that run page code (CodeTracer's JS-Boundary-Recording specification §6,
 * "The document's own tasks"; the `Loading` and `DocTask` records of §5.2).
 *
 * While a document loads, the browser runs tasks of its own between the
 * page's: the parser inserts elements and runs parser-inserted scripts,
 * external scripts run when they arrive, `DOMContentLoaded` and `load` are
 * dispatched. Their order relative to the page's own tasks (an input, a
 * timer, a response) depends on the network and the machine, so it is
 * logged like every other nondeterministic order:
 *
 * - **`Loading`**, before every macrotask recorded before `load`: the
 *   document's {@link DocumentPosition}, which replay brings the replayed
 *   document to before it releases the task (the runner's parser gates and
 *   held scripts, `packages/boundary-replay`).
 * - **`DocTask`**, for each external script's execution, for
 *   `DOMContentLoaded` and for `load`: replay lets the document run that
 *   task (it holds them until then) at that point of the log.
 *
 * One implementation of the position serves both sides, so a recording and
 * its replay measure the same thing: the recorders (the generic shim, and
 * a cooperating framework, which reuses {@link recordDocumentProgress})
 * and the replay runner's scheduler.
 */

import { DOC_TASK, LOADING_PHASE } from "@codetracer/boundary-format";

import { BOOTSTRAP_MARKER } from "./config.js";
import type { Recorder } from "./recorder.js";

/**
 * The attribute of the elements the replay runner adds to a replayed page
 * (its parser gates, `packages/boundary-replay/src/gates.ts`). Like the
 * record bootstrap ({@link BOOTSTRAP_MARKER}), they are CodeTracer's, not
 * the page's, and are never counted.
 */
export const REPLAY_GATE_MARKER = "data-ct-replay-gate";

/**
 * Where the document is in its own loading (the fields of `Loading`, §5.2):
 *
 * - `phase`: {@link LOADING_PHASE} 1 while it is parsed (`readyState`
 *   `loading`), 2 once parsed and before `DOMContentLoaded` is dispatched,
 *   3 from `DOMContentLoaded` until `load`;
 * - `elements`: the elements in the document, CodeTracer's own scripts and
 *   an inline script the parser holds for a style sheet excepted. An
 *   external script the parser waits for is counted: replay holds the
 *   parser at it, as the network held it on record;
 * - `scripts`: the `<script>` elements that have run: an external one once
 *   its `load` or `error` was dispatched, an inline classic one once it is in
 *   the document, unless the parser is still holding it for a style sheet
 *   that blocks scripts. Inline module scripts are not counted (they run
 *   later, with no event that says when), nor are the record bootstrap and
 *   the replay runner's gates.
 */
export interface DocumentPosition {
  phase: number;
  elements: number;
  scripts: number;
}

/** Whether two positions are the same. */
export function samePosition(
  a: DocumentPosition,
  b: DocumentPosition,
): boolean {
  return (
    a.phase === b.phase && a.elements === b.elements && a.scripts === b.scripts
  );
}

/** `{phase, elements, scripts}` as a short string, for a report. */
export function describePosition(p: DocumentPosition | undefined): string {
  return p === undefined
    ? "loaded"
    : `phase ${p.phase}, ${p.elements} elements, ${p.scripts} scripts run`;
}

/** The document's own events {@link DocumentProgress.listen} reports. */
export interface DocumentEvents {
  /** A `<script>`'s `load` or `error` (the script has run, or failed to). */
  scriptSettled(script: HTMLScriptElement): void;
  domContentLoaded(): void;
  /** The loading completed: `readyState` became `complete`, just before `load`. */
  load(): void;
}

/** A getter of `owner`'s prototype chain, captured before a page could patch it. */
function getter<T>(owner: object, name: string): (this: unknown) => T {
  let o: object | null = owner;
  while (o !== null) {
    const d = Object.getOwnPropertyDescriptor(o, name);
    if (d?.get !== undefined) return d.get as (this: unknown) => T;
    o = Object.getPrototypeOf(o);
  }
  throw new Error(`no ${name} getter`);
}

/**
 * The position of one document, and the record of which of its scripts have
 * settled and which of its events were dispatched. See the module comment.
 */
export class DocumentProgress {
  private readonly doc: Document;
  private readonly readyState: (this: unknown) => string;
  private readonly currentScriptOf: (this: unknown) => Element | null;
  private readonly scriptSrc: (this: unknown) => string;
  /** Live: every element, and every `<script>`, of the document. */
  private readonly all: HTMLCollectionOf<Element>;
  private readonly scriptElements: HTMLCollectionOf<Element>;
  private readonly settledScripts = new WeakSet<Element>();
  private readonly failedSheets = new WeakSet<Element>();
  private dcl = false;
  private loaded = false;

  constructor(private readonly w: Window & typeof globalThis) {
    this.doc = w.document;
    this.readyState = getter<string>(this.doc, "readyState");
    this.currentScriptOf = getter<Element | null>(this.doc, "currentScript");
    this.scriptSrc = getter<string>(w.HTMLScriptElement.prototype, "src");
    this.all = this.doc.getElementsByTagName("*");
    this.scriptElements = this.doc.getElementsByTagName("script");
  }

  /** Whether `DOMContentLoaded` has been dispatched. */
  get domContentLoadedFired(): boolean {
    return this.dcl;
  }

  /** Whether the window's `load` has been dispatched. */
  get complete(): boolean {
    return this.loaded;
  }

  /** The document's `readyState`, through the original getter. */
  get state(): string {
    return this.readyState.call(this.doc);
  }

  /** Where the document is now; `undefined` once `load` was dispatched. */
  position(): DocumentPosition | undefined {
    if (this.loaded) return undefined;
    const parsing = this.state === "loading";
    const phase = parsing
      ? LOADING_PHASE.parsing
      : this.dcl
        ? LOADING_PHASE.contentLoaded
        : LOADING_PHASE.parsed;
    const s = this.countScripts(parsing);
    return {
      phase,
      elements: this.all.length - s.uncounted,
      scripts: s.run,
    };
  }

  /** Whether `el` is one of CodeTracer's own scripts, never counted. */
  static isOwn(el: Element): boolean {
    return (
      el.hasAttribute(BOOTSTRAP_MARKER) || el.hasAttribute(REPLAY_GATE_MARKER)
    );
  }

  /** The URL an external script was fetched from, without its fragment. */
  srcOf(script: Element): string {
    const src = String(this.scriptSrc.call(script));
    const hash = src.indexOf("#");
    return hash < 0 ? src : src.slice(0, hash);
  }

  /**
   * The external classic script running now (`document.currentScript`),
   * if it is the page's; `undefined` in a callback, a module, or an inline
   * script.
   */
  currentExternalScript(): HTMLScriptElement | undefined {
    const s = this.currentScriptOf.call(this.doc);
    if (s === null || !s.hasAttribute("src") || DocumentProgress.isOwn(s)) {
      return undefined;
    }
    return s as HTMLScriptElement;
  }

  /** Whether the external script `el` has settled (`load` or `error`). */
  settled(el: Element): boolean {
    return this.settledScripts.has(el);
  }

  /**
   * The document's external scripts that have not settled, CodeTracer's own
   * excepted, in document order.
   */
  pendingScripts(): HTMLScriptElement[] {
    const out: HTMLScriptElement[] = [];
    for (let i = 0; i < this.scriptElements.length; i++) {
      const s = this.scriptElements[i];
      if (DocumentProgress.isOwn(s) || !s.hasAttribute("src")) continue;
      if (!this.settledScripts.has(s)) out.push(s as HTMLScriptElement);
    }
    return out;
  }

  /** Note that `el` settled; call after anything that must precede it. */
  markScriptSettled(el: Element): void {
    this.settledScripts.add(el);
  }

  /** Note that `DOMContentLoaded` was dispatched. */
  markDomContentLoaded(): void {
    this.dcl = true;
  }

  /** Note that `load` was dispatched. */
  markLoad(): void {
    this.dcl = true;
    this.loaded = true;
  }

  /**
   * Listen, before any page code, for the document's own events, with
   * capture listeners on the window and the document (they run before every
   * listener the page adds there). Only trusted events count: one the page dispatches is its
   * own deterministic behaviour. A stylesheet's `error` is noted here too:
   * a failed stylesheet no longer blocks scripts.
   */
  listen(
    addEventListener: typeof EventTarget.prototype.addEventListener,
    on: DocumentEvents,
  ): void {
    const add = (at: EventTarget, type: string, l: (ev: Event) => void) =>
      addEventListener.call(at, type, l, { capture: true });
    const settle = (ev: Event) => {
      if (!ev.isTrusted) return;
      const t = ev.target;
      if (t instanceof this.w.HTMLScriptElement) {
        if (!DocumentProgress.isOwn(t) && t.hasAttribute("src")) {
          on.scriptSettled(t);
        }
      } else if (ev.type === "error" && t instanceof this.w.HTMLLinkElement) {
        this.failedSheets.add(t);
      }
    };
    // An element's `load` never reaches the window (DOM, "get the parent"
    // of a Document is null for a `load` event), so the elements' events
    // are caught at the document; the window's own `load` at the window.
    add(this.doc, "load", settle);
    add(this.doc, "error", settle);
    // `load` is reported where the document's loading completes: at the
    // `readystatechange` to `complete`, which the browser dispatches in the
    // same task just before the window's `load` (HTML, "The end"), so that
    // the page's listeners of both come after it. Caught at the window, in
    // the capture phase, before any listener the page adds.
    let completed = false;
    const complete = (ev: Event) => {
      if (completed || !ev.isTrusted || ev.target !== this.doc) return;
      if (ev.type === "readystatechange" && this.state !== "complete") return;
      completed = true;
      on.load();
    };
    add(this.w, "readystatechange", complete);
    add(this.w, "load", complete);
    add(this.w, "DOMContentLoaded", (ev) => {
      if (ev.isTrusted && ev.target === this.doc) on.domContentLoaded();
    });
  }

  /**
   * The scripts that have run, and the elements {@link position} does not
   * count (CodeTracer's own scripts, and an inline script the parser holds
   * for a style sheet: replay gets there before the parser inserts it).
   */
  private countScripts(parsing: boolean): { run: number; uncounted: number } {
    let n = 0;
    let uncounted = 0;
    let held: Element | null | undefined;
    for (let i = 0; i < this.scriptElements.length; i++) {
      const s = this.scriptElements[i];
      if (DocumentProgress.isOwn(s)) {
        uncounted++;
        continue;
      }
      if (s.hasAttribute("src")) {
        if (this.settledScripts.has(s)) n++;
        continue;
      }
      if ((s.getAttribute("type") ?? "").trim().toLowerCase() === "module") {
        continue;
      }
      if (parsing) {
        held ??= this.inlineHeldForStyleSheet();
        if (held === s) {
          uncounted++;
          continue;
        }
      }
      n++;
    }
    return { run: n, uncounted };
  }

  /**
   * The inline script the parser holds for a style sheet that blocks
   * scripts, if any (HTML, "An end tag whose tag name is script": the
   * pending parsing-blocking script waits for "a style sheet that is
   * blocking scripts"). It is in the document but has not run. It is the
   * last thing the parser inserted, so the document's last node is in it,
   * and a `<link rel=stylesheet>` before it has neither loaded (`sheet`) nor
   * failed. Anything else the parser has got past, so it ran.
   */
  private inlineHeldForStyleSheet(): Element | null {
    let last: Node | null = this.doc.documentElement;
    while (last?.lastChild) last = last.lastChild;
    const script =
      last === null
        ? null
        : last.nodeType === 1
          ? (last as Element)
          : last.parentElement;
    if (
      script === null ||
      script.localName !== "script" ||
      script.hasAttribute("src")
    ) {
      return null;
    }
    const links = this.doc.getElementsByTagName("link");
    for (let i = 0; i < links.length; i++) {
      const l = links[i];
      if (!l.relList.contains("stylesheet") || l.disabled) continue;
      if (l.sheet !== null || this.failedSheets.has(l)) continue;
      // DOCUMENT_POSITION_FOLLOWING: the script comes after the link.
      if (l.compareDocumentPosition(script) & 4) return script;
    }
    return null;
  }
}

/**
 * What a recorder writes for the document's loading (see the module
 * comment), given to the {@link Recorder} it writes with.
 */
export interface RecorderProgress {
  /** At the start of a macrotask, before its records: `Loading`, if loading. */
  macrotask(): void;
  /** Before any record: `DocTask` for an external script that runs now. */
  beforeRecord(): void;
  /** Whether a checkpoint may be taken now: not while the document parses. */
  checkpointsAllowed(): boolean;
}

/**
 * Record the document's loading through `rec` (the generic shim does; a
 * cooperating framework calls it too, with its own recorder): `Loading`
 * before every macrotask recorded before `load`, and a `DocTask` for each
 * external script's execution, `DOMContentLoaded` and `load`.
 *
 * A script's `DocTask` (kind 1) is written before its first record, when
 * it makes one while it runs (`document.currentScript` names it then), so it
 * precedes the script's reads; a script that writes nothing while it runs
 * (a module, or one that makes no boundary read but in a microtask) gets
 * its `DocTask` (kind 4) at its `load` or `error`, which is where it
 * finished, after the records of its microtasks. Every `DocTask` is preceded by the
 * `Loading` of that moment, measured before the script counts as settled,
 * and so is each `DOMContentLoaded` and `load`, measured before they count
 * as dispatched; replay measures at the same points.
 */
export function recordDocumentProgress(
  w: Window & typeof globalThis,
  rec: Recorder,
  addEventListener: typeof EventTarget.prototype.addEventListener,
): DocumentProgress {
  const progress = new DocumentProgress(w);
  const announced = new WeakSet<Element>();
  const loading = () => {
    const p = progress.position();
    if (p !== undefined) rec.emit("Loading", p);
  };
  const announce = (script: Element, kind: number) => {
    announced.add(script);
    loading();
    rec.emit("DocTask", { kind, src: progress.srcOf(script) });
  };
  rec.attachProgress({
    macrotask: loading,
    beforeRecord() {
      const s = progress.currentExternalScript();
      if (s !== undefined && !announced.has(s)) announce(s, DOC_TASK.script);
    },
    checkpointsAllowed: () =>
      progress.position()?.phase !== LOADING_PHASE.parsing,
  });
  progress.listen(addEventListener, {
    scriptSettled(script) {
      rec.guard(() => {
        if (rec.recording && !announced.has(script)) {
          announce(script, DOC_TASK.scriptSettled);
        }
      });
      progress.markScriptSettled(script);
    },
    domContentLoaded() {
      rec.guard(() => {
        if (!rec.recording) return;
        loading();
        rec.emit("DocTask", { kind: DOC_TASK.domContentLoaded, src: "" });
      });
      progress.markDomContentLoaded();
    },
    load() {
      rec.guard(() => {
        if (!rec.recording) return;
        loading();
        rec.emit("DocTask", { kind: DOC_TASK.load, src: "" });
      });
      progress.markLoad();
    },
  });
  return progress;
}

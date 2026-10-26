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
 *   task (it holds them until then) at that point of the log; and for each
 *   event of a resource element (an image's, a style sheet's, a frame's
 *   `load` or `error`, a media element's events; `resource-events.ts`),
 *   which replay holds back, with the resource's request, until then.
 *
 * One implementation of the position serves both sides, so a recording and
 * its replay measure the same thing: the recorders (the generic shim, and
 * a cooperating framework, which reuses {@link recordDocumentProgress})
 * and the replay runner's scheduler.
 */

import { DOC_TASK, LOADING_PHASE } from "@codetracer/boundary-format";

import { REPLAY_GATE_MARKER, isOwnElement } from "./own-elements.js";
import { ParseCensus, getter } from "./parse-census.js";
import type { Recorder } from "./recorder.js";
import {
  type ResourceEvent,
  resourceEventOf,
  RESOURCE_EVENT_TYPES,
  watchResourceListeners,
} from "./resource-events.js";

export { REPLAY_GATE_MARKER };

/**
 * Where the document is in its own loading (the fields of `Loading`, §5.2):
 *
 * - `phase`: {@link LOADING_PHASE} 1 while it is parsed (`readyState`
 *   `loading`), 2 once parsed and before `DOMContentLoaded` is dispatched,
 *   3 from `DOMContentLoaded` until `load`;
 * - `elements`: the elements in the document, CodeTracer's own scripts
 *   excepted, and, while it parses, an inline classic script that is its
 *   last element (the parser may not have run it yet). An external script
 *   the parser waits for is counted: replay holds the parser at it, as the
 *   network held it on record;
 * - `scripts`: the `<script>` elements that have run: an external one once
 *   its `load` or `error` was dispatched, an inline classic one once it is in
 *   the document, but not, while it parses, the one that is its last
 *   element. Inline module scripts are not counted (they run
 *   later, with no event that says when), nor are the record bootstrap and
 *   the replay runner's gates;
 * - `text`: while it parses, the character data the document holds
 *   ({@link DocumentProgress.characterData}): the length of every text
 *   node's data and one more than the length of every comment's, in UTF-16
 *   code units, but for the text of CodeTracer's own scripts and of the
 *   inline script the elements leave out. The parser inserts text and
 *   comments as well as elements, and a task that runs before it reached a
 *   run of text sees, and changes, another document than one that runs after
 *   it. 0 once the document is parsed: the parser inserts nothing more.
 */
export interface DocumentPosition {
  phase: number;
  elements: number;
  scripts: number;
  text: number;
}

/** Whether two positions are the same. */
export function samePosition(
  a: DocumentPosition,
  b: DocumentPosition,
): boolean {
  return (
    a.phase === b.phase &&
    a.elements === b.elements &&
    a.scripts === b.scripts &&
    a.text === b.text
  );
}

/** `{phase, elements, scripts, text}` as a short string, for a report. */
export function describePosition(p: DocumentPosition | undefined): string {
  return p === undefined
    ? "loaded"
    : `phase ${p.phase}, ${p.elements} elements, ${p.scripts} scripts run, ${p.text} of text`;
}

/** `NodeFilter.SHOW_TEXT | NodeFilter.SHOW_COMMENT` (DOM, "Interface NodeFilter"). */
const SHOW_CHARACTER_DATA = 0x4 | 0x80;
/** `Node.ELEMENT_NODE` and `Node.TEXT_NODE`. */
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/** `Node.DOCUMENT_POSITION_FOLLOWING`. */
const FOLLOWING = 0x4;

/** Whether the `<script>` `el` is a module script (by its `type`). */
function isModuleScript(el: Element): boolean {
  return (el.getAttribute("type") ?? "").trim().toLowerCase() === "module";
}

/**
 * Whether `el` is an inline classic script of HTML's: the kind the parser
 * may be inside of, or hold at its end tag (see
 * `DocumentProgress.trailingInlineScript`).
 */
function isInlineClassicScript(el: Element): boolean {
  return (
    el.localName === "script" &&
    el.namespaceURI === "http://www.w3.org/1999/xhtml" &&
    !el.hasAttribute("src") &&
    !isModuleScript(el)
  );
}

/** The document's own events {@link DocumentProgress.listen} reports. */
export interface DocumentEvents {
  /** A `<script>`'s `load` or `error` (the script has run, or failed to). */
  scriptSettled(script: HTMLScriptElement): void;
  domContentLoaded(): void;
  /** The loading completed: `readyState` became `complete`, just before `load`. */
  load(): void;
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
  /**
   * The platform functions {@link characterData} walks the document with,
   * captured before a page could patch them.
   */
  private readonly createTreeWalker: Document["createTreeWalker"];
  private readonly nextNode: (this: TreeWalker) => Node | null;
  private readonly nodeType: (this: unknown) => number;
  private readonly parentNode: (this: unknown) => Node | null;
  private readonly dataLength: (this: unknown) => number;
  /** Live: every element, and every `<script>`, of the document. */
  private readonly all: HTMLCollectionOf<Element>;
  private readonly scriptElements: HTMLCollectionOf<Element>;
  /** The census of the document while it parses, if it was made then. */
  private readonly census: ParseCensus | undefined;
  private readonly compareDocumentPosition: Node["compareDocumentPosition"];
  private readonly settledScripts = new WeakSet<Element>();
  private dcl = false;
  private loaded = false;

  constructor(private readonly w: Window & typeof globalThis) {
    this.doc = w.document;
    this.readyState = getter<string>(this.doc, "readyState");
    this.currentScriptOf = getter<Element | null>(this.doc, "currentScript");
    this.scriptSrc = getter<string>(w.HTMLScriptElement.prototype, "src");
    this.createTreeWalker = w.Document.prototype.createTreeWalker;
    this.nextNode = w.TreeWalker.prototype.nextNode;
    this.nodeType = getter<number>(w.Node.prototype, "nodeType");
    this.parentNode = getter<Node | null>(w.Node.prototype, "parentNode");
    this.dataLength = getter<number>(w.CharacterData.prototype, "length");
    this.all = this.doc.getElementsByTagName("*");
    this.scriptElements = this.doc.getElementsByTagName("script");
    this.compareDocumentPosition = w.Node.prototype.compareDocumentPosition;
    // Made, and started, before page code, while the document parses; a
    // document made after that is measured whole, as is every document once
    // it is parsed.
    let census: ParseCensus | undefined;
    if (this.state === "loading") {
      try {
        census = new ParseCensus(w);
        census.start();
      } catch {
        census = undefined;
      }
    }
    this.census = census;
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

  /** Whether {@link position} answers from the census now (the document parses). */
  get incremental(): boolean {
    return this.parsingCensus() !== undefined;
  }

  /**
   * Where the document is now; `undefined` once `load` was dispatched.
   * While the document parses, from its {@link ParseCensus}, in time
   * proportional to what changed since the last question (a recorder asks
   * at every task, the replay runner at every parser gate); otherwise as
   * {@link fullPosition}, which it equals.
   */
  position(): DocumentPosition | undefined {
    const census = this.parsingCensus();
    return census === undefined
      ? this.fullPosition()
      : this.censusPosition(census);
  }

  /**
   * As {@link position}, measured from the whole document (its live
   * collections and a walk of its text), in time proportional to its size:
   * the definition the census is held to (`tests/boundary/parse-census.test.ts`).
   */
  fullPosition(): DocumentPosition | undefined {
    const phase = this.phase();
    if (phase === undefined) return undefined;
    const parsing = phase === LOADING_PHASE.parsing;
    const s = this.countScripts(parsing);
    return {
      phase,
      elements: this.all.length - s.uncounted,
      scripts: s.run,
      text: parsing ? this.characterData(s.held) : 0,
    };
  }

  /** The position's `phase` now; `undefined` once `load` was dispatched. */
  phase(): number | undefined {
    if (this.loaded) return undefined;
    if (this.state === "loading") return LOADING_PHASE.parsing;
    return this.dcl ? LOADING_PHASE.contentLoaded : LOADING_PHASE.parsed;
  }

  /** Whether the document is at `p` now. */
  at(p: DocumentPosition): boolean {
    const q = this.position();
    return q !== undefined && samePosition(q, p);
  }

  /**
   * The census, while the document parses (stopped once it is parsed:
   * the parser inserts nothing more, and the other phases are measured at
   * each task only); `undefined` otherwise.
   */
  private parsingCensus(): ParseCensus | undefined {
    const census = this.census;
    if (census === undefined || !census.active) return undefined;
    if (this.state !== "loading") {
      census.stop();
      return undefined;
    }
    return census;
  }

  /**
   * The position while the document parses, from `census`: what
   * {@link fullPosition} measures, as {@link countScripts} and
   * {@link characterData} define it.
   */
  private censusPosition(census: ParseCensus): DocumentPosition {
    const c = census.counts();
    const last = census.lastElement();
    const held = last !== null && isInlineClassicScript(last) ? last : null;
    let run = 0;
    for (const s of c.scripts) {
      if (s.hasAttribute("src")) {
        if (this.settledScripts.has(s)) run++;
        continue;
      }
      if (isModuleScript(s) || s === held) continue;
      run++;
    }
    return {
      phase: LOADING_PHASE.parsing,
      elements: c.elements - (held === null ? 0 : 1),
      scripts: run,
      text: c.text - (held === null ? 0 : census.textOfChildren(held)),
    };
  }

  /**
   * The character data the document holds, as a position counts it (see
   * {@link DocumentPosition}): every text node's length and every comment's
   * plus one (an empty comment is a node the parser inserted too), in tree
   * order from the document (a `<template>`'s contents and shadow trees are
   * not in it, as their elements are not counted either), but for the text
   * of CodeTracer's own scripts and of `held`, the inline script
   * {@link countScripts} leaves out (the parser may be inside it).
   *
   * https://dom.spec.whatwg.org/#interface-treewalker
   */
  characterData(held: Element | null = null): number {
    const walker = this.createTreeWalker.call(
      this.doc,
      this.doc,
      SHOW_CHARACTER_DATA,
    );
    let n = 0;
    for (
      let node = this.nextNode.call(walker);
      node !== null;
      node = this.nextNode.call(walker)
    ) {
      const length = this.dataLength.call(node);
      if (this.nodeType.call(node) !== TEXT_NODE) {
        n += length + 1;
        continue;
      }
      const parent = this.parentNode.call(node);
      if (
        parent !== null &&
        (parent === held ||
          (this.nodeType.call(parent) === ELEMENT_NODE &&
            DocumentProgress.isOwn(parent as Element)))
      ) {
        continue;
      }
      n += length;
    }
    return n;
  }

  /** Whether `el` is one of CodeTracer's own scripts, never counted. */
  static isOwn(el: Element): boolean {
    return isOwnElement(el);
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
    const pending = (s: Element) =>
      !DocumentProgress.isOwn(s) &&
      s.hasAttribute("src") &&
      !this.settledScripts.has(s);
    const census = this.parsingCensus();
    if (census !== undefined) {
      // The census has them in the order it met them, and the parser can
      // insert before what it inserted already (a foster parent).
      const found = census.counts().scripts.filter(pending);
      return (found as HTMLScriptElement[]).sort((a, b) =>
        this.compareDocumentPosition.call(a, b) & FOLLOWING ? -1 : 1,
      );
    }
    const out: HTMLScriptElement[] = [];
    for (let i = 0; i < this.scriptElements.length; i++) {
      const s = this.scriptElements[i];
      if (pending(s)) out.push(s as HTMLScriptElement);
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
      if (
        t instanceof this.w.HTMLScriptElement &&
        !DocumentProgress.isOwn(t) &&
        t.hasAttribute("src")
      ) {
        on.scriptSettled(t);
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
   * count (CodeTracer's own scripts, and, while the document parses, an
   * inline script that is the document's last element,
   * {@link trailingInlineScript}: replay gets there before the parser
   * inserts it).
   */
  private countScripts(parsing: boolean): {
    run: number;
    uncounted: number;
    held: Element | null;
  } {
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
      if (isModuleScript(s)) {
        continue;
      }
      if (parsing) {
        held ??= this.trailingInlineScript();
        if (held === s) {
          uncounted++;
          continue;
        }
      }
      n++;
    }
    // The inline script left out, whose text is not counted either. Found
    // only while the document parses (and so `held` is `undefined` when no
    // inline classic script was met).
    return { run: n, uncounted, held: held ?? null };
  }

  /**
   * The inline classic script that is the document's last element (its own
   * elements, the bootstrap and the replay gates, aside), if any, while the
   * document parses. The parser may not have run it yet: it may be inside
   * it (its text not all there), or at its end tag with the script pending:
   * held for a style sheet that blocks scripts (HTML, "An end tag whose tag
   * name is script": the pending parsing-blocking script waits for "a style
   * sheet that is blocking scripts"), or because the browser yielded before
   * running it (Chromium's parser does, when its time slice is used up; a
   * task such as an input then runs with the script in the document and not
   * yet run). Nothing in the document tells these from a script that has
   * just run with the parser stopped right after it, so such a script is
   * never counted, run or not, until the parser inserts another element.
   * The replay measures the same: at a parser gate before the script and at
   * one right after it the position is the same, so a task the log has
   * there is released at whichever of the two the log's reads put first.
   */
  private trailingInlineScript(): Element | null {
    for (let i = this.all.length - 1; i >= 0; i--) {
      const el = this.all[i];
      if (DocumentProgress.isOwn(el)) continue;
      return isInlineClassicScript(el) ? el : null;
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
    rec.emit("DocTask", {
      kind,
      src: progress.srcOf(script),
      target: "",
      event: "",
    });
  };
  rec.attachProgress({
    macrotask: loading,
    beforeRecord() {
      const s = progress.currentExternalScript();
      if (s !== undefined && !announced.has(s)) announce(s, DOC_TASK.script);
    },
    checkpointsAllowed: () => progress.phase() !== LOADING_PHASE.parsing,
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
        rec.emit("DocTask", {
          kind: DOC_TASK.domContentLoaded,
          src: "",
          target: "",
          event: "",
        });
      });
      progress.markDomContentLoaded();
    },
    load() {
      rec.guard(() => {
        if (!rec.recording) return;
        loading();
        rec.emit("DocTask", {
          kind: DOC_TASK.load,
          src: "",
          target: "",
          event: "",
        });
      });
      progress.markLoad();
    },
  });
  recordResourceEvents(w, rec, addEventListener, loading);
  return progress;
}

/**
 * The capture listeners {@link recordResourceEvents} and the replay runtime
 * put where a resource element's event reaches first (`resource-events.ts`):
 * on the window for every type, since a page's capture listener there runs
 * before one on the document, and on the document for `load`, which never
 * reaches the window (DOM, "get the parent" of a Document:
 * https://dom.spec.whatwg.org/#ref-for-get-the-parent%E2%91%A6); and on an
 * element just before the page adds its first listener for one, for an
 * element that is not in the document.
 */
export function listenForResourceEvents(
  w: Window & typeof globalThis,
  addEventListener: typeof EventTarget.prototype.addEventListener,
  listener: (ev: Event) => void,
  onWatched?: (el: Element) => void,
): void {
  const add = (at: EventTarget, type: string) =>
    addEventListener.call(at, type, listener, { capture: true });
  for (const type of RESOURCE_EVENT_TYPES) add(w, type);
  add(w.document, "load");
  watchResourceListeners(w, (el) => {
    for (const type of RESOURCE_EVENT_TYPES) add(el, type);
    onWatched?.(el);
  });
}

/**
 * Record each resource element's event (`DocTask` kind 5, §6): where the
 * document was (`Loading`, while it loads), then the event, before any
 * listener of the page runs. Each event is written once, however many of the
 * capture listeners see it.
 */
function recordResourceEvents(
  w: Window & typeof globalThis,
  rec: Recorder,
  addEventListener: typeof EventTarget.prototype.addEventListener,
  loading: () => void,
): void {
  const recorded = new WeakSet<Event>();
  listenForResourceEvents(w, addEventListener, (ev) => {
    if (recorded.has(ev)) return;
    rec.guard(() => {
      const r: ResourceEvent | undefined = resourceEventOf(w, ev);
      if (r === undefined) return;
      recorded.add(ev);
      if (!rec.recording) return;
      loading();
      rec.emit("DocTask", {
        kind: DOC_TASK.resourceEvent,
        src: r.src,
        target: r.target,
        event: r.event,
      });
    });
  });
}

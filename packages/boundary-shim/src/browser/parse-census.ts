/**
 * The census of a document while it is parsed: how many elements it holds,
 * which of them are `<script>`s, and how much character data, kept up to
 * date from the document's mutation records instead of a walk of the whole
 * document at each question (CodeTracer's JS-Boundary-Recording
 * specification §6, "The position").
 *
 * A document position is asked for at every task a recorder writes while the
 * document parses, and the replay runner asks at every parser gate, of which
 * there is one at almost every token boundary. Counting the live
 * `getElementsByTagName("*")` collection or walking the document's text
 * costs the size of the document each time (Blink recounts a live collection
 * after every change to the tree, and the parser changes it at every token),
 * so a page of N tokens cost O(N²): a 500 KB page took a minute to replay.
 * The census answers in time proportional to what changed since it was last
 * asked, and to the depth of the tree.
 *
 * It counts exactly what `DocumentProgress`'s full measure counts (the two
 * are compared, node for node, by `tests/boundary/parse-census.test.ts`):
 *
 * - every element in the document's tree (not in a `<template>`'s contents
 *   or a shadow tree, which `getElementsByTagName` does not reach either),
 *   but for CodeTracer's own scripts (`isOwnElement` and the qualified name
 *   `script`, as `getElementsByTagName("script")` matches it);
 * - every element whose qualified name is `script`, CodeTracer's own aside,
 *   for the caller to classify;
 * - the length of every text node's data, but for text whose parent is one
 *   of CodeTracer's own elements, and one more than the length of every
 *   comment's.
 *
 * How it stays exact: the parser and the page change the tree only by
 * inserting and removing nodes, by changing character data and by changing
 * attributes, and a `MutationObserver` on the document's subtree is told of
 * each (DOM, "queue a mutation record"). An inserted node not yet counted is
 * counted with the part of its subtree not yet counted (a counted node's later
 * children are inserted, and reported, on their own); a counted text node or
 * comment whose data changed is counted again at its new length. Anything
 * else it does not follow node by node, and then counts the whole document
 * again: the removal of a counted node (or of one of CodeTracer's own other
 * than its scripts, which are counted), and a change of an attribute that
 * decides what is counted (`src`, `type`, and the markers of CodeTracer's own
 * elements). The parser removes nodes only in the adoption agency algorithm
 * (misnested formatting elements), so a whole count is rare.
 *
 * The observer and every platform function the census calls are captured
 * when it is made, before page code runs, so a page that patches them changes
 * nothing, and a recorder's seams never see the census's observer as the
 * page's.
 *
 * https://dom.spec.whatwg.org/#interface-mutationobserver
 * https://dom.spec.whatwg.org/#concept-getelementsbytagname
 */

import { BOOTSTRAP_MARKER } from "./config.js";
import { REPLAY_GATE_MARKER, isOwnElement } from "./own-elements.js";

/** `Node.ELEMENT_NODE`, `Node.TEXT_NODE`, `Node.COMMENT_NODE`. */
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const COMMENT_NODE = 8;

/** The getter of `name` on `owner` or its prototype chain. */
export function getter<T>(owner: object, name: string): (this: unknown) => T {
  let o: object | null = owner;
  while (o !== null) {
    const d = Object.getOwnPropertyDescriptor(o, name);
    if (d?.get !== undefined) return d.get as (this: unknown) => T;
    o = Object.getPrototypeOf(o);
  }
  throw new Error(`no ${name} getter`);
}

/**
 * Whether `el`'s qualified name is `script`: what `getElementsByTagName`
 * matches for the name `script` in an HTML document (an HTML element's name
 * compared in lower case, any other's as written; neither has a prefix).
 */
export function isScriptElement(el: Element): boolean {
  return el.localName === "script" && el.prefix === null;
}

/** What {@link ParseCensus.counts} reports. */
export interface CensusCounts {
  /** The elements counted (see the module comment). */
  elements: number;
  /** The character data counted (see the module comment). */
  text: number;
  /**
   * The `<script>` elements in the document, CodeTracer's own aside, in no
   * particular order.
   */
  scripts: readonly Element[];
}

/** The census of one document while it is parsed (see the module comment). */
export class ParseCensus {
  private readonly doc: Document;
  private readonly observer: MutationObserver;
  private readonly observe: MutationObserver["observe"];
  private readonly takeRecords: MutationObserver["takeRecords"];
  private readonly disconnect: MutationObserver["disconnect"];
  private readonly nodeType: (this: unknown) => number;
  private readonly parentNode: (this: unknown) => Node | null;
  private readonly firstChild: (this: unknown) => Node | null;
  private readonly nextSibling: (this: unknown) => Node | null;
  private readonly isConnected: (this: unknown) => boolean;
  private readonly dataLength: (this: unknown) => number;
  private readonly documentElement: (this: unknown) => Element | null;
  private readonly lastElementChild: (this: unknown) => Element | null;
  private readonly previousElementSibling: (this: unknown) => Element | null;
  private readonly parentElement: (this: unknown) => Element | null;

  /** Every node counted, so that a node is counted once. */
  private counted = new WeakSet<Node>();
  /** The length each counted text node or comment was counted at. */
  private lengths = new WeakMap<Node, number>();
  private elements = 0;
  private text = 0;
  private scripts: Element[] = [];
  /** Whether the counts must be made again from the whole document. */
  private dirty = true;
  private observing = false;

  constructor(w: Window & typeof globalThis) {
    this.doc = w.document;
    const MO = w.MutationObserver;
    this.observe = MO.prototype.observe;
    this.takeRecords = MO.prototype.takeRecords;
    this.disconnect = MO.prototype.disconnect;
    // The records the platform delivers before the census asks for them
    // (at a microtask checkpoint) are applied then; never into the page.
    this.observer = new MO((records) => {
      try {
        this.apply(records);
      } catch {
        this.dirty = true;
      }
    });
    this.nodeType = getter<number>(w.Node.prototype, "nodeType");
    this.parentNode = getter<Node | null>(w.Node.prototype, "parentNode");
    this.firstChild = getter<Node | null>(w.Node.prototype, "firstChild");
    this.nextSibling = getter<Node | null>(w.Node.prototype, "nextSibling");
    this.isConnected = getter<boolean>(w.Node.prototype, "isConnected");
    this.dataLength = getter<number>(w.CharacterData.prototype, "length");
    this.documentElement = getter<Element | null>(
      w.Document.prototype,
      "documentElement",
    );
    this.lastElementChild = getter<Element | null>(
      w.Element.prototype,
      "lastElementChild",
    );
    this.previousElementSibling = getter<Element | null>(
      w.Element.prototype,
      "previousElementSibling",
    );
    this.parentElement = getter<Element | null>(
      w.Node.prototype,
      "parentElement",
    );
  }

  /** Start following the document's mutations. */
  start(): void {
    if (this.observing) return;
    this.observe.call(this.observer, this.doc, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["src", "type", BOOTSTRAP_MARKER, REPLAY_GATE_MARKER],
    });
    this.observing = true;
    this.dirty = true;
  }

  /** Stop following them (the document is parsed); the counts go stale. */
  stop(): void {
    if (!this.observing) return;
    this.disconnect.call(this.observer);
    this.observing = false;
    this.dirty = true;
    this.counted = new WeakSet();
    this.lengths = new WeakMap();
    this.scripts = [];
  }

  /** Whether the census follows the document. */
  get active(): boolean {
    return this.observing;
  }

  /** The counts now (see {@link CensusCounts}). */
  counts(): CensusCounts {
    try {
      this.apply(this.takeRecords.call(this.observer));
    } catch {
      this.dirty = true;
    }
    if (this.dirty) this.recount();
    return { elements: this.elements, text: this.text, scripts: this.scripts };
  }

  /**
   * The last element of the document in tree order that is not one of
   * CodeTracer's own, as the last item of `getElementsByTagName("*")` that
   * is not: the deepest last element, then each element before it in tree
   * order. In time proportional to the tree's depth and to the own elements
   * passed.
   */
  lastElement(): Element | null {
    const root = this.documentElement.call(this.doc);
    if (root === null) return null;
    let el: Element = this.deepestLast(root);
    while (isOwnElement(el)) {
      const prev: Element | null = this.previousElementSibling.call(el);
      if (prev !== null) {
        el = this.deepestLast(prev);
        continue;
      }
      const parent: Element | null = this.parentElement.call(el);
      if (parent === null) return null;
      el = parent;
    }
    return el;
  }

  /** The length of the text node children of `el` (counted, `el` not own). */
  textOfChildren(el: Element): number {
    let n = 0;
    for (
      let c = this.firstChild.call(el);
      c !== null;
      c = this.nextSibling.call(c)
    ) {
      if (this.nodeType.call(c) === TEXT_NODE) n += this.dataLength.call(c);
    }
    return n;
  }

  private deepestLast(el: Element): Element {
    for (
      let last = this.lastElementChild.call(el);
      last !== null;
      last = this.lastElementChild.call(el)
    ) {
      el = last;
    }
    return el;
  }

  /** Apply `records` to the counts, or note that they must be made again. */
  private apply(records: MutationRecord[]): void {
    if (this.dirty) return;
    for (const r of records) {
      if (r.type === "attributes") {
        // `src` and `type` decide only how a `<script>` is classified; a
        // marker, whether an element is CodeTracer's own.
        if (
          (r.attributeName === "src" || r.attributeName === "type") &&
          !(
            this.nodeType.call(r.target) === ELEMENT_NODE &&
            isScriptElement(r.target as Element)
          )
        ) {
          continue;
        }
        this.dirty = true;
        return;
      }
      if (r.type === "characterData") {
        this.recountData(r.target);
        continue;
      }
      for (let i = 0; i < r.removedNodes.length; i++) {
        const n = r.removedNodes[i];
        // Text of one of CodeTracer's own elements was never counted; nor
        // was a node inserted and removed since the census last looked (a
        // counted node cannot have been moved into it without being
        // removed, which is a removal of a counted node). One of
        // CodeTracer's own scripts (a gate taking itself out) counts for
        // nothing, and holds only its text.
        if (!this.counted.has(n) || this.ownScript(n)) continue;
        this.dirty = true;
        return;
      }
      for (let i = 0; i < r.addedNodes.length; i++) {
        const n = r.addedNodes[i];
        // A node removed again since is counted, if ever, where it is now.
        if (!this.isConnected.call(n)) continue;
        this.countSubtree(n);
      }
    }
  }

  /** Whether `n` is one of CodeTracer's own scripts. */
  private ownScript(n: Node): boolean {
    if (this.nodeType.call(n) !== ELEMENT_NODE) return false;
    const el = n as Element;
    return isScriptElement(el) && isOwnElement(el);
  }

  /** Count again the data of `node`, if it was counted. */
  private recountData(node: Node): void {
    const before = this.lengths.get(node);
    if (before === undefined || !this.isConnected.call(node)) return;
    const after = this.dataCount(node);
    this.text += after - before;
    this.lengths.set(node, after);
  }

  /** What a counted text node or comment adds to the text: see the module comment. */
  private dataCount(node: Node): number {
    const length = this.dataLength.call(node);
    return this.nodeType.call(node) === COMMENT_NODE ? length + 1 : length;
  }

  /** Count `root` and the part of its subtree not counted yet. */
  private countSubtree(root: Node): void {
    const stack: Node[] = [root];
    while (stack.length > 0) {
      const n = stack.pop()!;
      // A counted node's subtree was counted with it, and its later
      // children were inserted, and are reported, on their own.
      if (this.counted.has(n)) continue;
      const type = this.nodeType.call(n);
      if (type === ELEMENT_NODE) {
        const el = n as Element;
        this.counted.add(el);
        if (isScriptElement(el)) {
          if (!isOwnElement(el)) {
            this.elements++;
            this.scripts.push(el);
          }
        } else {
          this.elements++;
        }
        // Children in reverse, so they are counted in tree order.
        const kids: Node[] = [];
        for (
          let c = this.firstChild.call(el);
          c !== null;
          c = this.nextSibling.call(c)
        ) {
          kids.push(c);
        }
        for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
      } else if (type === TEXT_NODE || type === COMMENT_NODE) {
        if (type === TEXT_NODE) {
          const parent = this.parentNode.call(n);
          if (
            parent !== null &&
            this.nodeType.call(parent) === ELEMENT_NODE &&
            isOwnElement(parent as Element)
          ) {
            continue;
          }
        }
        this.counted.add(n);
        const count = this.dataCount(n);
        this.lengths.set(n, count);
        this.text += count;
      } else {
        // The document, a doctype, a processing instruction: not counted,
        // and only the document has children.
        for (
          let c = this.firstChild.call(n);
          c !== null;
          c = this.nextSibling.call(c)
        ) {
          stack.push(c);
        }
      }
    }
  }

  /** Make the counts again from the whole document. */
  private recount(): void {
    this.counted = new WeakSet();
    this.lengths = new WeakMap();
    this.elements = 0;
    this.text = 0;
    this.scripts = [];
    this.dirty = false;
    this.countSubtree(this.doc);
  }
}

/**
 * The JSON forms of what a platform object hands the page in a list
 * (JS-Boundary-Recording.md §5.2 `PlatformValue`, §10.4): observer entries,
 * mutation records and performance-timeline entries. One implementation for
 * record and replay, so the two compare like with like.
 *
 * Elements are named by their structural target (§10.2, `targets.ts`).
 * Geometry is written as plain `{x, y, width, height}` objects. Replay
 * rebuilds each entry as an object of the platform's interface (its
 * prototype is the interface's, so `instanceof` holds) whose values are own
 * properties.
 */

import { HOLE_TOKEN } from "@codetracer/boundary-format";

import { targetOf } from "./targets.js";

/** A rectangle as its four defining numbers. */
export interface RectJson {
  x: number;
  y: number;
  width: number;
  height: number;
}

function rect(r: DOMRectReadOnly | null | undefined): RectJson | null {
  if (r === null || r === undefined) return null;
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

/** `ResizeObserverSize` lists (`borderBoxSize`, …). */
function sizes(
  list: readonly ResizeObserverSize[] | undefined,
): { inlineSize: number; blockSize: number }[] {
  return Array.from(list ?? []).map((s) => ({
    inlineSize: s.inlineSize,
    blockSize: s.blockSize,
  }));
}

/** One `IntersectionObserverEntry` (Intersection Observer, §2.5). */
export function intersectionEntryJson(e: IntersectionObserverEntry): unknown {
  const out: Record<string, unknown> = {
    target: targetOf(e.target),
    time: e.time,
    rootBounds: rect(e.rootBounds),
    boundingClientRect: rect(e.boundingClientRect),
    intersectionRect: rect(e.intersectionRect),
    isIntersecting: e.isIntersecting,
    intersectionRatio: e.intersectionRatio,
  };
  // Intersection Observer v2 (`trackVisibility`), where the engine has it.
  const visible = (e as unknown as { isVisible?: unknown }).isVisible;
  if (typeof visible === "boolean") out.isVisible = visible;
  return out;
}

/** One `ResizeObserverEntry` (Resize Observer, §3.4). */
export function resizeEntryJson(e: ResizeObserverEntry): unknown {
  return {
    target: targetOf(e.target),
    contentRect: rect(e.contentRect),
    borderBoxSize: sizes(e.borderBoxSize),
    contentBoxSize: sizes(e.contentBoxSize),
    devicePixelContentBoxSize: sizes(e.devicePixelContentBoxSize),
  };
}

/**
 * A node of a mutation record: its type, its target and, for text, its data
 * (the hole token, §5.2.1, when `hole`).
 */
function nodeJson(n: Node | null, hole = false): unknown {
  if (n === null) return null;
  if (n.nodeType === 1) return { t: 1, target: targetOf(n) };
  return {
    t: n.nodeType,
    target: targetOf(n),
    data: hole && n.nodeValue !== null ? HOLE_TOKEN : n.nodeValue,
  };
}

/**
 * Whether a node is inside a sensitive field (`inSensitiveField`), asked of
 * each node a mutation record names.
 */
export type SensitiveNodeTest = (n: Node) => boolean;

/**
 * One `MutationRecord` (DOM, "Interface MutationRecord"). Replay compares
 * this form of its own records with the logged one (§5.2), since the page's
 * own DOM changes are replayed and the records follow from them.
 *
 * What a sensitive field holds is never written (§11.3.1, §11.3.3): when
 * the record's target is inside a sensitive field (`sensitive`), the text
 * it names (a text node's data, a `characterData` record's `oldValue`) and
 * the old `value` attribute of an `attributes` record are the hole token,
 * so text typed into a `contenteditable` region, or a value a framework
 * mirrors into the field's `value` attribute, never reaches the log.
 * `holedNodes` are nodes known to have been in such a field (removed from
 * one by an earlier record of the same list), whose own records are holed
 * too. Replay holes its own records the same way, so the two still compare.
 */
export function mutationRecordJson(
  r: MutationRecord,
  sensitive: SensitiveNodeTest = () => false,
  holedNodes: ReadonlySet<Node> = new Set(),
): unknown {
  const hole = holedNodes.has(r.target) || sensitive(r.target);
  const oldValue =
    hole &&
    r.oldValue !== null &&
    (r.type === "characterData" ||
      (r.type === "attributes" && r.attributeName === "value"))
      ? HOLE_TOKEN
      : r.oldValue;
  const node = (n: Node) =>
    nodeJson(n, hole || holedNodes.has(n) || sensitive(n));
  return {
    type: r.type,
    target: nodeJson(r.target, hole),
    addedNodes: Array.from(r.addedNodes).map(node),
    removedNodes: Array.from(r.removedNodes).map(node),
    previousSibling: nodeJson(r.previousSibling, hole),
    nextSibling: nodeJson(r.nextSibling, hole),
    attributeName: r.attributeName,
    attributeNamespace: r.attributeNamespace,
    oldValue,
  };
}

/**
 * A list of `MutationRecord`s ({@link mutationRecordJson}). The nodes a
 * record removes from a sensitive field are remembered for the whole list,
 * since by the time the list is delivered such a node may have left the
 * field, and a later record of the list (a `characterData` change of a text
 * node removed since) names it with nothing to tell where it was.
 */
export function mutationRecordsJson(
  records: readonly MutationRecord[],
  sensitive: SensitiveNodeTest = () => false,
): unknown[] {
  const holed = new Set<Node>();
  for (const r of records) {
    if (!sensitive(r.target)) continue;
    for (const n of Array.from(r.removedNodes)) holed.add(n);
    for (const n of Array.from(r.addedNodes)) holed.add(n);
  }
  // A text node removed with an element: its own records hold the data too.
  for (const n of [...holed]) {
    if (n.nodeType !== 1) continue;
    const walker = (n.ownerDocument ?? document).createTreeWalker(n, 4);
    for (let t = walker.nextNode(); t !== null; t = walker.nextNode()) {
      holed.add(t);
    }
  }
  return records.map((r) => mutationRecordJson(r, sensitive, holed));
}

/**
 * One performance-timeline entry (Performance Timeline): its `toJSON()`,
 * which every entry interface defines as its attributes of JSON types (WebIDL
 * "default toJSON steps"), plus, under keys of their own (`ct:element`,
 * `ct:sourceNodes`), what `toJSON()` leaves out because it is a node: the
 * `element` of a `largest-contentful-paint` or `element` entry and the
 * `node` of each of a `layout-shift` entry's sources, as targets. Replay's
 * `toJSON()` returns the entry without the `ct:` keys, as the visitor's did.
 */
export function performanceEntryJson(e: PerformanceEntry): unknown {
  const json = { ...(e.toJSON() as Record<string, unknown>) };
  const element = (e as unknown as { element?: unknown }).element;
  if (element !== undefined) {
    json["ct:element"] = element === null ? null : targetOf(element);
  }
  const sources = (e as unknown as { sources?: unknown }).sources;
  if (Array.isArray(sources)) {
    json["ct:sourceNodes"] = sources.map((s: { node?: Node | null }) =>
      s.node === null || s.node === undefined ? null : targetOf(s.node),
    );
  }
  return json;
}

/** A list of performance entries. */
export function performanceEntriesJson(list: readonly PerformanceEntry[]) {
  return Array.from(list).map(performanceEntryJson);
}

/**
 * The interface of a performance entry of `entryType` (the registry of
 * https://w3c.github.io/timing-entrytypes-registry/), when the window has
 * it.
 */
export const ENTRY_INTERFACES: Readonly<Record<string, string>> = {
  mark: "PerformanceMark",
  measure: "PerformanceMeasure",
  navigation: "PerformanceNavigationTiming",
  resource: "PerformanceResourceTiming",
  paint: "PerformancePaintTiming",
  "largest-contentful-paint": "LargestContentfulPaint",
  "layout-shift": "LayoutShift",
  longtask: "PerformanceLongTaskTiming",
  "long-animation-frame": "PerformanceLongAnimationFrameTiming",
  event: "PerformanceEventTiming",
  "first-input": "PerformanceEventTiming",
  element: "PerformanceElementTiming",
  "visibility-state": "VisibilityStateEntry",
  taskattribution: "TaskAttributionTiming",
};

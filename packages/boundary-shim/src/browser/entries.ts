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

/** A node of a mutation record: its type, its target and, for text, its data. */
function nodeJson(n: Node | null): unknown {
  if (n === null) return null;
  if (n.nodeType === 1) return { t: 1, target: targetOf(n) };
  return { t: n.nodeType, target: targetOf(n), data: n.nodeValue };
}

/**
 * One `MutationRecord` (DOM, "Interface MutationRecord"). Replay compares
 * this form of its own records with the logged one (§5.2), since the page's
 * own DOM changes are replayed and the records follow from them.
 */
export function mutationRecordJson(r: MutationRecord): unknown {
  return {
    type: r.type,
    target: nodeJson(r.target),
    addedNodes: Array.from(r.addedNodes).map(nodeJson),
    removedNodes: Array.from(r.removedNodes).map(nodeJson),
    previousSibling: nodeJson(r.previousSibling),
    nextSibling: nodeJson(r.nextSibling),
    attributeName: r.attributeName,
    attributeNamespace: r.attributeNamespace,
    oldValue: r.oldValue,
  };
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

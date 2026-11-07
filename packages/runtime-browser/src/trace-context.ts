/**
 * The W3C trace context a server-rendered page carries for the request that
 * served it, read in the browser so that something the page reports (an
 * error report, `error-report.ts`) can be joined to the backend span that
 * rendered the page.
 *
 * A browser script cannot read the response headers of its own document, so
 * the server hands the `traceparent` over in one of the two places a page can
 * read:
 *
 * 1. a `<meta name="traceparent" content="00-…">` element in the document,
 *    the convention OpenTelemetry's document-load instrumentation reads
 *    (https://github.com/open-telemetry/opentelemetry-js-contrib/tree/main/plugins/web/opentelemetry-instrumentation-document-load);
 * 2. a `Server-Timing: traceparent;desc="00-…"` response header, which the
 *    browser exposes to the page as the navigation entry's `serverTiming`
 *    (https://www.w3.org/TR/server-timing/#the-performanceservertiming-interface).
 *
 * The meta element wins when both are present and well formed. A value that
 * is not a well-formed `traceparent` is no trace context: the caller gets
 * `null`, never a guess.
 */

/** The length of a version-00 `traceparent`, and of the part any version shares with it. */
const TRACEPARENT_LENGTH = 55;

/** Version, trace id, parent id and flags, lowercase hex (W3C Trace Context §3.2.2). */
const TRACEPARENT =
  /^(?<version>[0-9a-f]{2})-(?<traceId>[0-9a-f]{32})-(?<parentId>[0-9a-f]{16})-(?<flags>[0-9a-f]{2})$/;

/** The longest header value examined; a longer one is not a trace context. */
const MAX_TRACEPARENT_INPUT = 512;

/** A parsed `traceparent`. */
export interface TraceParent {
  /** The header as it is carried on: the first 55 characters, the part every version shares. */
  value: string;
  version: string;
  /** 32 lowercase hex digits, not all zero. */
  traceId: string;
  /** 16 lowercase hex digits, not all zero. */
  parentId: string;
  flags: string;
}

/**
 * Parse a W3C `traceparent` header value
 * (https://www.w3.org/TR/trace-context/#traceparent-header), or `null` when
 * it is not a well-formed one: lowercase hex fields of the right lengths, a
 * version other than `ff`, a trace id and a parent id that are not all
 * zeros, exactly 55 characters for version `00`, and for a later version at
 * least 55 with a `-` after them (§3.2.4, "Versioning of traceparent").
 * Surrounding whitespace is ignored (an HTTP field value's optional white
 * space).
 */
export function parseTraceparent(raw: unknown): TraceParent | null {
  if (typeof raw !== "string" || raw.length > MAX_TRACEPARENT_INPUT) {
    return null;
  }
  const text = raw.trim();
  if (text.length < TRACEPARENT_LENGTH) return null;
  const head = text.slice(0, TRACEPARENT_LENGTH);
  const m = TRACEPARENT.exec(head);
  if (m?.groups === undefined) return null;
  const { version, traceId, parentId, flags } = m.groups;
  if (version === "ff") return null;
  if (version === "00" && text.length !== TRACEPARENT_LENGTH) return null;
  if (text.length > TRACEPARENT_LENGTH && text[TRACEPARENT_LENGTH] !== "-") {
    return null;
  }
  if (/^0+$/.test(traceId) || /^0+$/.test(parentId)) return null;
  return { value: head, version, traceId, parentId, flags };
}

/** The slice of the document a reader needs (a stand-in in unit tests). */
export interface TraceContextDocument {
  querySelector(
    selectors: string,
  ): { getAttribute(name: string): string | null } | null;
}

/** The slice of `performance` a reader needs. */
export interface TraceContextPerformance {
  getEntriesByType(type: string): ReadonlyArray<unknown>;
}

/**
 * `perf` read through `getEntriesByType`, a captured original of
 * `Performance.prototype.getEntriesByType`: on a page a boundary shim
 * records, the timeline's methods are seams that log each read as the
 * page's, and reading the trace context is not the page's read. `undefined`
 * when either is missing (no timeline to read).
 */
export function timelineThrough(
  perf: unknown,
  getEntriesByType: ((this: never, type: string) => unknown) | undefined,
): TraceContextPerformance | undefined {
  if (perf === undefined || perf === null || getEntriesByType === undefined) {
    return undefined;
  }
  return {
    getEntriesByType: (type: string) =>
      (
        getEntriesByType as unknown as (
          this: unknown,
          type: string,
        ) => ReadonlyArray<unknown>
      ).call(perf, type),
  };
}

/** Where a page's trace context was found. */
export type TraceContextSource = "meta" | "server-timing";

/** A page's trace context and where it was found. */
export interface PageTraceContext extends TraceParent {
  source: TraceContextSource;
}

/** The `traceparent` of the document's `<meta name="traceparent">`, or `null`. */
function fromMeta(doc: TraceContextDocument | undefined): TraceParent | null {
  if (doc === undefined) return null;
  try {
    const meta = doc.querySelector('meta[name="traceparent" i]');
    return meta === null
      ? null
      : parseTraceparent(meta.getAttribute("content"));
  } catch {
    return null;
  }
}

/**
 * The `traceparent` of the navigation's `Server-Timing` entry named
 * `traceparent`, or `null`. Its value is the entry's `description`.
 */
function fromServerTiming(
  perf: TraceContextPerformance | undefined,
): TraceParent | null {
  if (perf === undefined) return null;
  try {
    const nav = perf.getEntriesByType("navigation")[0] as
      | {
          serverTiming?: ReadonlyArray<{
            name?: unknown;
            description?: unknown;
          }>;
        }
      | undefined;
    for (const entry of nav?.serverTiming ?? []) {
      if (typeof entry.name !== "string") continue;
      if (entry.name.toLowerCase() !== "traceparent") continue;
      const parsed = parseTraceparent(entry.description);
      if (parsed !== null) return parsed;
    }
  } catch {
    // A performance object whose reads throw carries no trace context.
  }
  return null;
}

/**
 * The trace context the server-rendered response carried: the
 * `<meta name="traceparent">` element's, else the navigation's
 * `Server-Timing` `traceparent` entry's, else `null`.
 */
export function readPageTraceContext(
  doc: TraceContextDocument | undefined,
  perf: TraceContextPerformance | undefined,
): PageTraceContext | null {
  const meta = fromMeta(doc);
  if (meta !== null) return { ...meta, source: "meta" };
  const timing = fromServerTiming(perf);
  if (timing !== null) return { ...timing, source: "server-timing" };
  return null;
}

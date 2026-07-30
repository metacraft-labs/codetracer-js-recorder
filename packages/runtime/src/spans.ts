/**
 * Web-request span contract for the CodeTracer JS recorder (RS-M9).
 *
 * This module is the canonical definition of the surface framework middleware
 * calls, and of the metadata keys the Request Panel reads.  It has **no
 * side effects and no imports** so it can be pulled into anything.
 *
 * Two things install the surface described here:
 *
 *   * `packages/cli/src/record-cmd.ts` — the standalone runner script the
 *     `record` command generates and executes.  This is the path a recorded
 *     server actually takes.
 *   * `packages/runtime/src/runtime.ts` — the library path, for programs that
 *     drive `startRecording` themselves.
 *
 * Middleware never imports either: it calls `globalThis.__ct.webRequestStart`
 * / `webRequestStop` if they are there and does nothing if they are not, so an
 * app can keep the middleware installed when it is not being recorded.
 *
 * See `codetracer-specs/Trace-Files/CTFS-Request-Span-Streams.md` for the
 * on-wire record and `codetracer-specs/GUI/Core-Panes/Request-Panel.md` for
 * what the panel does with each key.
 */

/** Span status wire values (`CTFS-Request-Span-Streams.md` §"Record Model"). */
export const SPAN_STATUS_UNKNOWN = 0 as const;
/** The interval completed normally. */
export const SPAN_STATUS_OK = 1 as const;
/** The interval completed in error — a 4xx/5xx response or a thrown handler. */
export const SPAN_STATUS_ERROR = 2 as const;

export type SpanStatus =
  | typeof SPAN_STATUS_UNKNOWN
  | typeof SPAN_STATUS_OK
  | typeof SPAN_STATUS_ERROR;

/**
 * Flat span metadata as `[key, value]` pairs.
 *
 * **Order is part of the contract** — consumers render metadata in emission
 * order — so this is an array of pairs and never an object.
 */
export type SpanMetadata = Array<[string, string]>;

/**
 * The metadata keys the Request Panel reads, shared with every other language
 * recorder (`request_spans.rs::to_request_record` maps them to the wire
 * `RequestRecord` the panel's ViewModel consumes).
 */
export const SPAN_META_KEYS = {
  /** `"GET"`, `"POST"`, … */
  method: "http.method",
  /** The request target as the client sent it, e.g. `"/api/users/2"`. */
  url: "http.url",
  /** The matched route *pattern*, e.g. `"/api/users/:id"`; empty if none. */
  route: "http.route",
  /** Decimal integer. */
  statusCode: "http.status_code",
  /** Decimal integer milliseconds. */
  durationMs: "http.duration_ms",
  /** Decimal integer bytes of response body. */
  responseSize: "http.response_size",
  /** The web framework that produced the span, e.g. `"express"`. */
  framework: "framework",
  /** Present only when the request failed with a diagnosable message. */
  errorMessage: "error.message",
} as const;

/**
 * What `globalThis.__ct` exposes to framework middleware.
 *
 * Both methods are total: they never throw into the host program, and
 * `webRequestStart` returns 0 when recording is not active, which
 * `webRequestStop` then ignores.
 */
export interface WebRequestSpanSurface {
  /**
   * Open a span for a request that just entered the pipeline.
   *
   * @param label  the panel's row label, conventionally `"<METHOD> <url>"`.
   * @returns the span id to pass to `webRequestStop`, or 0 if not recording.
   */
  webRequestStart(label: string, metadata: SpanMetadata): number;

  /** Settle a span opened by `webRequestStart`.  A 0 id is a no-op. */
  webRequestStop(
    spanId: number,
    status: SpanStatus,
    metadata: SpanMetadata,
  ): void;
}

/**
 * Where the runtime forwards span boundaries once a recording is active.
 *
 * `startRecording` installs one backed by the native addon; tests install
 * their own to observe the boundaries without a trace writer.
 */
export interface SpanSink {
  open(spanType: string, label: string, metadata: SpanMetadata): number;
  close(spanId: number, status: SpanStatus, metadata: SpanMetadata): void;
}

/**
 * Express middleware emitting CodeTracer web-request spans (RS-M9).
 *
 * One span per request, written **inline** into the `.ct` container the
 * recorder is already producing: no `codetracer_spans.jsonl` sidecar, no
 * second file to find, tail or keep in sync.  See
 * `codetracer-specs/Trace-Files/CTFS-Request-Span-Streams.md`.
 *
 * ## How it binds to the recording
 *
 * The middleware never touches the trace writer. It calls
 * `globalThis.__ct.webRequestStart` / `webRequestStop`, the surface the
 * recorder's runner installs (see
 * `packages/runtime/src/spans.ts` for the canonical definition). When the app
 * is not being recorded those functions are absent, `spanId` is 0, and every
 * call here degrades to a no-op — so the middleware can stay installed in
 * production.
 *
 * ## Why the span settles in `res.end` and not on the `finish` event
 *
 * The recorder maps each Node async context (`async_hooks.executionAsyncId()`)
 * onto a container thread, and the span's `contiguous_on_one_thread` bit is
 * measured from the thread events that land inside its step range. `res.end`
 * is called **synchronously by the handler**, so a handler that never awaited
 * opens and settles its span in one async context and is genuinely contiguous.
 * The `finish` event, by contrast, always fires in a fresh async context after
 * the socket flushes — settling there would put a thread switch inside every
 * span and make the bit constant-false, which is to say useless.
 *
 * `finish` and `close` are still wired, as a *fallback* for a request that
 * never reaches `res.end` (an aborted connection). Settling is idempotent on
 * both sides, so whichever fires first wins.
 *
 * ## Per-request state lives in the request's own frame
 *
 * Everything a span needs is captured in the closure created for that one
 * `(req, res)` pair. There is no module-level "current request": the Ruby
 * recorder's original design had one and lost a span whenever a request was
 * handled inside another, and Node — where two requests interleave across
 * every `await` — would lose them constantly.
 */

// ---------------------------------------------------------------------------
// The recorder surface (canonical definition: packages/runtime/src/spans.ts)
// ---------------------------------------------------------------------------
//
// Deliberately re-declared rather than imported. This module is loaded inside
// the *recorded* application, and it is designed to stay installed in
// production; importing `@codetracer/runtime` for two integer constants would
// pull the recorder's whole module graph — value encoders, IO capture, async
// -context tracking and the native-addon loader — into an app that may never
// be recorded, and would give this package a dependency it otherwise does not
// need. `tests/web/express-spans.test.ts` asserts these values against the
// canonical module so the duplication cannot drift.

/** The interval completed normally. */
export const SPAN_STATUS_OK = 1;
/** The interval completed in error — a 4xx/5xx response or a thrown handler. */
export const SPAN_STATUS_ERROR = 2;

/** Flat span metadata as ordered `[key, value]` pairs. */
export type SpanMetadata = Array<[string, string]>;

interface RecorderSpanSurface {
  webRequestStart?: (label: string, metadata: SpanMetadata) => number;
  webRequestStop?: (
    spanId: number,
    status: number,
    metadata: SpanMetadata,
  ) => void;
}

// ---------------------------------------------------------------------------
// Minimal structural types for the Express objects we touch
// ---------------------------------------------------------------------------
//
// Typed structurally so this package has no dependency on express itself —
// it works with any express@4/5 (and any connect-style server whose objects
// carry these fields).

interface CtRequest {
  method?: string;
  originalUrl?: string;
  url?: string;
  baseUrl?: string;
  route?: { path?: string };
}

interface CtResponse {
  statusCode?: number;
  write(...args: unknown[]): boolean;
  end(...args: unknown[]): unknown;
  on(event: string, listener: () => void): unknown;
}

type NextFunction = (err?: unknown) => void;

/** Options for {@link codetracerExpress}. */
export interface CodetracerExpressOptions {
  /**
   * The value recorded under the `framework` metadata key. Defaults to
   * `"express"`; override it when the middleware fronts a framework built on
   * Express so a row says what the user actually wrote.
   */
  framework?: string;
}

/**
 * Per-request span bookkeeping, created fresh in each middleware invocation.
 */
interface RequestSpan {
  spanId: number;
  startedAt: number;
  bytes: number;
  errorMessage: string;
  settled: boolean;
}

/**
 * The property the error handler uses to find the span state the middleware
 * created. A symbol so it cannot collide with anything the app puts on `req`.
 */
const SPAN_STATE = Symbol.for("codetracer.express.span");

/** Byte length of one chunk handed to `res.write` / `res.end`. */
function chunkLength(chunk: unknown, encoding?: unknown): number {
  if (chunk === undefined || chunk === null) return 0;
  if (typeof chunk === "string") {
    const enc = typeof encoding === "string" ? encoding : "utf8";
    try {
      return Buffer.byteLength(chunk, enc as BufferEncoding);
    } catch {
      return Buffer.byteLength(chunk, "utf8");
    }
  }
  if (Buffer.isBuffer(chunk)) return chunk.length;
  if (ArrayBuffer.isView(chunk)) return chunk.byteLength;
  return 0;
}

/**
 * The route *pattern* the request matched, e.g. `"/api/users/:id"`.
 *
 * Empty when nothing matched — which is how a routing 404 stays
 * distinguishable from a 404 a handler chose to return.
 */
function routePattern(req: CtRequest): string {
  const path = req.route?.path;
  if (typeof path !== "string" || path.length === 0) return "";
  const base = typeof req.baseUrl === "string" ? req.baseUrl : "";
  const full = `${base}${path}`;
  // A router mounted at "/" contributes "" and a route of "/" would then
  // render as "" rather than "/".
  return full.length > 0 ? full : "/";
}

/** The request target as the client sent it. */
function requestUrl(req: CtRequest): string {
  return req.originalUrl ?? req.url ?? "";
}

/**
 * Express request-span middleware.
 *
 * Install it **first**, before any router or body parser, so the span covers
 * routing, body parsing and error handling — everything the server did on
 * behalf of the request — and not just the handler body:
 *
 * ```js
 * const app = express();
 * app.use(codetracerExpress());
 * app.use(express.json());
 * // … routes …
 * app.use(codetracerExpressErrors());   // AFTER the routes
 * ```
 */
export function codetracerExpress(
  options: CodetracerExpressOptions = {},
): (req: CtRequest, res: CtResponse, next: NextFunction) => void {
  const framework = options.framework ?? "express";

  return function codetracerExpressMiddleware(
    req: CtRequest,
    res: CtResponse,
    next: NextFunction,
  ): void {
    const ct = (globalThis as { __ct?: RecorderSpanSurface }).__ct;
    const start = ct?.webRequestStart;
    if (typeof start !== "function") {
      // Not being recorded: stay completely out of the way.
      next();
      return;
    }

    const method = req.method ?? "GET";
    const url = requestUrl(req);

    // Everything below lives in THIS invocation's frame. Two requests
    // interleaving across an await each have their own `state`.
    const state: RequestSpan = {
      spanId: 0,
      startedAt: Date.now(),
      bytes: 0,
      errorMessage: "",
      settled: false,
    };
    (req as Record<string | symbol, unknown>)[SPAN_STATE] = state;

    // Metadata known at entry. The route is not among them: Express has not
    // matched one yet, and reporting "" here and the pattern at settle time is
    // exactly the open-then-settled record pair the format is built around.
    state.spanId = start.call(ct, `${method} ${url}`, [
      ["http.method", method],
      ["http.url", url],
      ["framework", framework],
    ]);

    const settle = (): void => {
      if (state.settled) return;
      state.settled = true;
      const stop = (globalThis as { __ct?: RecorderSpanSurface }).__ct
        ?.webRequestStop;
      if (typeof stop !== "function") return;

      const statusCode = res.statusCode ?? 0;
      const metadata: SpanMetadata = [
        ["http.route", routePattern(req)],
        ["http.status_code", String(statusCode)],
        ["http.duration_ms", String(Date.now() - state.startedAt)],
        ["http.response_size", String(state.bytes)],
      ];
      if (state.errorMessage.length > 0) {
        metadata.push(["error.message", state.errorMessage]);
      }
      // A 4xx is as much a failed request as a 5xx from the panel's point of
      // view, and every other language recorder in the matrix draws the line
      // in the same place.
      const status = statusCode >= 400 ? SPAN_STATUS_ERROR : SPAN_STATUS_OK;
      stop.call(ct, state.spanId, status, metadata);
    };

    // Count the response body exactly, rather than trusting a Content-Length
    // header the app may never have set (chunked responses have none).
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);

    res.write = function patchedWrite(...args: unknown[]): boolean {
      state.bytes += chunkLength(args[0], args[1]);
      return originalWrite(...args);
    };

    res.end = function patchedEnd(...args: unknown[]): unknown {
      // Count first, then let the response actually complete, then settle:
      // the span must close AFTER the bytes the handler wrote are accounted
      // for, and while we are still in the handler's own async context.
      if (typeof args[0] !== "function") {
        state.bytes += chunkLength(args[0], args[1]);
      }
      const result = originalEnd(...args);
      settle();
      return result;
    };

    // Fallback for a request that never reaches `res.end` — an aborted
    // connection, or a framework that destroys the socket directly. Settling
    // is idempotent, so on the normal path these fire after `settle()`
    // already ran and do nothing.
    res.on("finish", settle);
    res.on("close", settle);

    next();
  };
}

/**
 * Express error-handling middleware that records the failure message on the
 * request's span.
 *
 * Install it **after** the routes, like any Express error handler. It does not
 * send a response and does not settle the span: it annotates and re-throws
 * into the pipeline, so the app's own error handling (or Express's default)
 * decides the status code, and the span settles from `res.end` as usual with
 * whatever that turned out to be.
 */
export function codetracerExpressErrors(): (
  err: unknown,
  req: CtRequest,
  res: CtResponse,
  next: NextFunction,
) => void {
  return function codetracerExpressErrorMiddleware(
    err: unknown,
    req: CtRequest,
    _res: CtResponse,
    next: NextFunction,
  ): void {
    const state = (req as Record<string | symbol, unknown>)[SPAN_STATE] as
      | RequestSpan
      | undefined;
    if (state && !state.settled) {
      state.errorMessage =
        err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : String(err);
    }
    next(err);
  };
}

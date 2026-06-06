/**
 * `@codetracer/runtime-browser` — browser-side CodeTracer runtime.
 *
 * Mirrors `@codetracer/runtime`'s `__ct.step/enter/ret/write` surface but
 * targets a *browser* environment. Instead of buffering to a Rust N-API
 * addon (which requires Node) it produces a **newline-delimited JSON event
 * stream** and ships it over WebSocket to the M26 daemon receiver.
 *
 * Wire format and policy come from
 * `codetracer-specs/GUI/Debugging-Features/Value-Origin-Tracking.md` §14.4:
 *
 *   * One event per line, JSON-encoded.
 *   * Event variants mirror `TraceLowLevelEvent`
 *     (`Step`, `Call`, `Return`, `Assignment`, `Value`, …) as documented in
 *     `codetracer-specs/Trace-Files/Trace-Event-Types.md`.
 *   * **No protocol shims.** The browser recorder never intercepts
 *     `fetch` / `XMLHttpRequest` / `WebSocket` / `window.postMessage`.
 *     Cross-process correlation rides on the M25 user-placed marker
 *     mechanism (`ct.mark_correlation_send(...)` / `mark_correlation_recv(...)`)
 *     emitted as a regular tracepoint event through the same JSON stream.
 *
 * The transport URL defaults to `ws://localhost:<port>/ct-stream` and is
 * configurable via either `window.__codetracer_endpoint` (set before the
 * instrumented bundle loads) or via the bundler-plugin options that wire a
 * `<script>` injection.
 */

// ── JSON event vocabulary ───────────────────────────────────────────────
//
// These shapes mirror the canonical `TraceLowLevelEvent` enum in
// `codetracer-specs/Trace-Files/Trace-Event-Types.md`. We send the JSON
// representation on the wire (one event per line); the daemon translates
// to the CTFS split-binary / CBOR-Zstd encoding before persisting.

export type EncodedValue = {
  /** Mirrors `ValueRecord` — primitive or compound rendering. */
  value: unknown;
  /** `TypeKind` tag from the trace-format spec. */
  typeKind: string;
};

/** `Path` interning event — declares a new source path. */
export interface PathEvent {
  kind: "Path";
  pathId: number;
  path: string;
}

/** `Step` event — execution reached the given site. */
export interface StepEvent {
  kind: "Step";
  siteId: number;
}

/** `Call` event — entered a function with the given args. */
export interface CallEvent {
  kind: "Call";
  fnId: number;
  args: EncodedValue[];
}

/** `Return` event — returned from a function with the given value. */
export interface ReturnEvent {
  kind: "Return";
  fnId: number;
  returnValue: EncodedValue;
}

/**
 * `Assignment` event — synthetic M16a event for a recognised
 * simple-assignment shape.  The daemon resolves the manifest write-site
 * entry for `siteId` and lowers into `BindVariable + Assignment`.
 */
export interface AssignmentEvent {
  kind: "Assignment";
  siteId: number;
}

/** `Value` event — full value snapshot for a variable. */
export interface ValueEvent {
  kind: "Value";
  name: string;
  value: EncodedValue;
}

/** `Write` event — I/O capture (`console.log` etc.). */
export interface WriteEvent {
  kind: "Write";
  channel: "stdout" | "stderr";
  content: string;
}

/**
 * `CorrelationMarker` event — M25 user-placed cross-process correlation
 * marker.  No protocol-specific shim runs; the user's instrumented code
 * calls `__ct.markCorrelation(...)` explicitly at the source location
 * where the value crosses a boundary.
 */
export interface CorrelationMarkerEvent {
  kind: "CorrelationMarker";
  direction: "send" | "recv";
  /** Boundary identifier (e.g. `"outbound"`, `"http-in"`). */
  boundary: string;
  /** Match key used to pair a send / recv across recorders. */
  key: unknown;
  /** Optional payload alongside the key (carried through verbatim). */
  payload?: unknown;
}

/** `Manifest` event — sent once at session start to ship the manifest. */
export interface ManifestEvent {
  kind: "Manifest";
  manifest: unknown;
}

/** `SessionStart` event — sent once before any payload event. */
export interface SessionStartEvent {
  kind: "SessionStart";
  program: string;
  args: string[];
}

/** `SessionEnd` event — sent when the page tears down / explicit flush. */
export interface SessionEndEvent {
  kind: "SessionEnd";
}

export type BrowserEvent =
  | PathEvent
  | StepEvent
  | CallEvent
  | ReturnEvent
  | AssignmentEvent
  | ValueEvent
  | WriteEvent
  | CorrelationMarkerEvent
  | ManifestEvent
  | SessionStartEvent
  | SessionEndEvent;

// ── Transport ────────────────────────────────────────────────────────────

/**
 * Minimal subset of the WHATWG `WebSocket` interface we depend on.
 *
 * Exposed as an interface so tests can swap in a fake transport without
 * pulling in a real `WebSocket` polyfill (`ws` is Node-only; jsdom does
 * not ship a `WebSocket`).
 */
export interface BrowserTransport {
  send(payload: string): void;
  close(): void;
  readyState: number;
}

/** Factory that constructs the transport given an endpoint URL. */
export type TransportFactory = (url: string) => BrowserTransport;

/**
 * Default transport factory — uses the WHATWG `WebSocket` global.
 *
 * Bundler-plugin / test environments can override this so the runtime
 * never references the `WebSocket` symbol at module-evaluation time
 * (avoids `ReferenceError` in non-browser smoke tests).
 */
export const defaultWebSocketFactory: TransportFactory = (url) => {
  const Ctor = (globalThis as { WebSocket?: new (u: string) => unknown })
    .WebSocket;
  if (!Ctor) {
    throw new Error(
      "WebSocket is not available in this environment; provide a custom transportFactory",
    );
  }
  return new Ctor(url) as unknown as BrowserTransport;
};

// ── Runtime options ──────────────────────────────────────────────────────

export interface BrowserRuntimeOptions {
  /**
   * WebSocket endpoint URL.  Defaults to
   * `ws://localhost:9230/ct-stream` (matching the M26 daemon-receiver
   * default port; configurable via the bundler-plugin options).
   *
   * The runtime also consults `window.__codetracer_endpoint` at construction
   * time so a static deployment can be re-pointed without rebuilding.
   */
  endpoint?: string;
  /**
   * Maximum number of events to buffer before flushing to the transport.
   * Defaults to 256 — small enough to keep latency low, large enough to
   * batch the per-event WebSocket message overhead.
   */
  flushThreshold?: number;
  /**
   * Override the WebSocket factory (mostly for tests).  When provided,
   * the runtime never touches the global `WebSocket` symbol.
   */
  transportFactory?: TransportFactory;
  /**
   * When true, the runtime starts disabled — every method is a no-op.
   * Equivalent to the `CODETRACER_JS_RECORDER_DISABLED` env var on the
   * Node path.
   */
  disabled?: boolean;
  /**
   * The trace manifest, shipped to the daemon at session start.
   * Mirrors the Node runtime's `init(manifestPath)` step — the browser
   * cannot read the filesystem, so the manifest is bundled as a JSON
   * object alongside the instrumented code.
   */
  manifest?: unknown;
  /**
   * Program identifier reported alongside the `SessionStart` event.
   * Defaults to the page's `document.title` if available, else `"browser"`.
   */
  program?: string;
  /** Program args reported alongside the `SessionStart` event. */
  args?: string[];
}

const DEFAULT_ENDPOINT = "ws://localhost:9230/ct-stream";
const DEFAULT_FLUSH_THRESHOLD = 256;

/** Resolve the effective endpoint URL per the §14.4 lookup order. */
export function resolveEndpoint(
  optsEndpoint: string | undefined,
  globalRef?: { __codetracer_endpoint?: string },
): string {
  if (optsEndpoint) return optsEndpoint;
  const fromGlobal =
    globalRef?.__codetracer_endpoint ??
    (typeof globalThis !== "undefined"
      ? (globalThis as { __codetracer_endpoint?: string }).__codetracer_endpoint
      : undefined);
  if (fromGlobal) return fromGlobal;
  return DEFAULT_ENDPOINT;
}

// ── Value encoding ───────────────────────────────────────────────────────
//
// We re-use the same encoding rules as `@codetracer/runtime` (depth-limited,
// circular-reference-safe).  Duplicated here so the browser bundle does
// not have to pull in the Node runtime (which has `node:fs` imports at
// module top-level).

const MAX_STRING_LENGTH = 1000;
const DEFAULT_MAX_DEPTH = 5;
const DEFAULT_MAX_SIZE = 100;

export interface EncodeValueOptions {
  maxDepth?: number;
  maxSize?: number;
}

export function encodeValue(
  value: unknown,
  options?: EncodeValueOptions,
): EncodedValue {
  const maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxSize = options?.maxSize ?? DEFAULT_MAX_SIZE;
  const seen = new WeakSet<object>();
  return encodeInner(value, 0, maxDepth, maxSize, seen);
}

function encodeInner(
  value: unknown,
  depth: number,
  maxDepth: number,
  maxSize: number,
  seen: WeakSet<object>,
): EncodedValue {
  try {
    if (value === undefined || value === null) {
      return { value: null, typeKind: "None" };
    }
    switch (typeof value) {
      case "boolean":
        return { value, typeKind: "Bool" };
      case "number":
        if (Number.isNaN(value)) return { value: "NaN", typeKind: "Raw" };
        if (!Number.isFinite(value)) {
          return {
            value: value > 0 ? "Infinity" : "-Infinity",
            typeKind: "Raw",
          };
        }
        return Number.isInteger(value)
          ? { value, typeKind: "Int" }
          : { value, typeKind: "Float" };
      case "string": {
        const truncated =
          value.length > MAX_STRING_LENGTH
            ? value.slice(0, MAX_STRING_LENGTH)
            : value;
        return { value: truncated, typeKind: "String" };
      }
      case "bigint":
        return { value: value.toString(), typeKind: "BigInt" };
      case "symbol":
        return { value: value.toString(), typeKind: "Raw" };
      case "function":
        return {
          value: (value as { name?: string }).name || "anonymous",
          typeKind: "FunctionKind",
        };
      case "object":
        return encodeObject(value as object, depth, maxDepth, maxSize, seen);
      default:
        return { value: typeof value, typeKind: "Raw" };
    }
  } catch {
    return { value: "[encoding error]", typeKind: "Raw" };
  }
}

function encodeObject(
  obj: object,
  depth: number,
  maxDepth: number,
  maxSize: number,
  seen: WeakSet<object>,
): EncodedValue {
  if (seen.has(obj)) return { value: "[circular]", typeKind: "Raw" };
  if (depth >= maxDepth) return { value: "[depth limit]", typeKind: "Raw" };
  seen.add(obj);
  try {
    if (obj instanceof Date) {
      return { value: obj.toISOString(), typeKind: "Raw" };
    }
    if (obj instanceof RegExp) {
      return { value: obj.toString(), typeKind: "Raw" };
    }
    if (obj instanceof Error) {
      return { value: obj.message, typeKind: "Error" };
    }
    if (Array.isArray(obj)) {
      const total = obj.length;
      const limit = Math.min(total, maxSize);
      const elements: EncodedValue[] = [];
      for (let i = 0; i < limit; i++) {
        elements.push(encodeInner(obj[i], depth + 1, maxDepth, maxSize, seen));
      }
      if (total > maxSize) {
        elements.push({
          value: `[... ${total - maxSize} more]`,
          typeKind: "Raw",
        });
      }
      return { value: elements, typeKind: "Seq" };
    }
    let keys: string[];
    try {
      keys = Object.keys(obj);
    } catch {
      return { value: "[object]", typeKind: "Raw" };
    }
    const total = keys.length;
    const limit = Math.min(total, maxSize);
    const fields: Array<{ name: string; value: EncodedValue }> = [];
    for (let i = 0; i < limit; i++) {
      const key = keys[i];
      let val: unknown;
      try {
        val = (obj as Record<string, unknown>)[key];
      } catch {
        val = "[access error]";
      }
      fields.push({
        name: key,
        value: encodeInner(val, depth + 1, maxDepth, maxSize, seen),
      });
    }
    if (total > maxSize) {
      fields.push({
        name: `[... ${total - maxSize} more]`,
        value: { value: null, typeKind: "None" },
      });
    }
    return { value: { fields }, typeKind: "Struct" };
  } finally {
    seen.delete(obj);
  }
}

// ── Runtime ──────────────────────────────────────────────────────────────

/**
 * Public runtime interface — matches the Node `CtRuntime` shape closely
 * so instrumented code is transport-agnostic.  The only browser-specific
 * surface is `markCorrelation` (the M25 marker hook) which the user calls
 * explicitly at boundary-crossing sites.
 */
export interface CtBrowserRuntime {
  step(siteId: number): void;
  enter(fnId: number, argsLike: IArguments | unknown[]): void;
  ret(fnId: number, value?: unknown): unknown;
  write(siteId: number): void;
  value(name: string, value: unknown): void;
  /**
   * M25 user-placed correlation marker.  Mirrors the Python helpers from
   * `codetracer-specs/GUI/Debugging-Features/Correlation-Markers.md` §3.
   * No protocol shim runs — the user's own code calls this at the source
   * location where the value crosses a boundary.
   */
  markCorrelation(
    direction: "send" | "recv",
    boundary: string,
    key: unknown,
    payload?: unknown,
  ): void;
  /** Force any buffered events to be flushed to the transport. */
  flush(): void;
  /**
   * Tear the session down — emits the `SessionEnd` event and closes the
   * WebSocket.  Safe to call multiple times.
   */
  stop(): void;
  /** Currently-buffered event count (mostly for tests). */
  readonly bufferedCount: number;
  /** Endpoint URL the runtime is connected to (mostly for tests). */
  readonly endpoint: string;
}

export interface CreateBrowserRuntimeOptions extends BrowserRuntimeOptions {}

/**
 * Build a fresh `CtBrowserRuntime`.  The first event sent (after the
 * connection opens) is `SessionStart`; the optional `Manifest` event
 * follows.  All subsequent calls into `step` / `enter` / `ret` / `write`
 * push events onto the in-memory queue and flush when the threshold or
 * the visibility-change / `beforeunload` lifecycle hook fires.
 */
export function createBrowserRuntime(
  options: CreateBrowserRuntimeOptions = {},
): CtBrowserRuntime {
  const disabled = options.disabled === true;
  if (disabled) {
    return noopRuntime();
  }

  const endpoint = resolveEndpoint(options.endpoint);
  const threshold = options.flushThreshold ?? DEFAULT_FLUSH_THRESHOLD;
  const factory = options.transportFactory ?? defaultWebSocketFactory;

  let transport: BrowserTransport | null = null;
  try {
    transport = factory(endpoint);
  } catch {
    // Recording is best-effort.  When the transport cannot be built we
    // fall back to a no-op runtime — the program runs unmodified.
    return noopRuntime(endpoint);
  }

  // Buffer used both before the connection opens (the WHATWG WebSocket
  // reaches `OPEN` asynchronously) and between forced flushes.
  let queue: BrowserEvent[] = [];
  let stopped = false;

  function enqueue(event: BrowserEvent): void {
    if (stopped) return;
    queue.push(event);
    if (queue.length >= threshold) {
      flushNow();
    }
  }

  function flushNow(): void {
    if (!transport) return;
    // Per WHATWG, `readyState === 1` is OPEN.  When the socket is still
    // CONNECTING we keep buffering — `send()` would throw otherwise.
    if (transport.readyState !== 1) return;
    if (queue.length === 0) return;
    const lines = queue.map((evt) => JSON.stringify(evt)).join("\n");
    try {
      transport.send(lines + "\n");
    } catch {
      // Transport errors must not crash the host program.  We discard
      // the batch and keep going — the daemon may have torn the socket
      // down mid-recording.
    }
    queue = [];
  }

  // Seed the session.  We push the SessionStart + (optional) Manifest
  // events immediately so they reach the daemon as the very first lines.
  const program =
    options.program ??
    (typeof document !== "undefined" ? document.title || "browser" : "browser");
  enqueue({ kind: "SessionStart", program, args: options.args ?? [] });
  if (options.manifest != null) {
    enqueue({ kind: "Manifest", manifest: options.manifest });
  }

  function safeFlushOnLifecycle(): void {
    try {
      flushNow();
    } catch {
      // Lifecycle hooks must not propagate exceptions.
    }
  }

  // The `pagehide` event fires when the browser is about to discard the
  // page.  It is the only reliable hook on Safari — `beforeunload` does
  // not always fire on mobile Safari.
  if (typeof globalThis.addEventListener === "function") {
    try {
      globalThis.addEventListener("pagehide", safeFlushOnLifecycle);
      globalThis.addEventListener("beforeunload", safeFlushOnLifecycle);
      if (typeof document !== "undefined") {
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "hidden") {
            safeFlushOnLifecycle();
          }
        });
      }
    } catch {
      // Some sandboxed contexts disallow event subscription — ignore.
    }
  }

  // When the socket opens, drain whatever has been queued up.
  try {
    (transport as unknown as { onopen?: () => void }).onopen = () => {
      flushNow();
    };
  } catch {
    // Custom transports may not expose `onopen`; the explicit flush()
    // path still works for them.
  }

  const runtime: CtBrowserRuntime = {
    step(siteId: number): void {
      enqueue({ kind: "Step", siteId });
    },
    enter(fnId: number, argsLike: IArguments | unknown[]): void {
      const arr: unknown[] = [];
      for (let i = 0; i < (argsLike as ArrayLike<unknown>).length; i++) {
        arr.push((argsLike as ArrayLike<unknown>)[i]);
      }
      enqueue({
        kind: "Call",
        fnId,
        args: arr.map((a) => encodeValue(a)),
      });
    },
    ret(fnId: number, value?: unknown): unknown {
      enqueue({
        kind: "Return",
        fnId,
        returnValue: encodeValue(value),
      });
      return value;
    },
    write(siteId: number): void {
      enqueue({ kind: "Assignment", siteId });
    },
    value(name: string, value: unknown): void {
      enqueue({ kind: "Value", name, value: encodeValue(value) });
    },
    markCorrelation(
      direction: "send" | "recv",
      boundary: string,
      key: unknown,
      payload?: unknown,
    ): void {
      const evt: CorrelationMarkerEvent = {
        kind: "CorrelationMarker",
        direction,
        boundary,
        key,
      };
      if (payload !== undefined) evt.payload = payload;
      enqueue(evt);
    },
    flush(): void {
      flushNow();
    },
    stop(): void {
      if (stopped) return;
      enqueue({ kind: "SessionEnd" });
      flushNow();
      stopped = true;
      try {
        transport?.close();
      } catch {
        // Best-effort.
      }
    },
    get bufferedCount() {
      return queue.length;
    },
    get endpoint() {
      return endpoint;
    },
  };

  return runtime;
}

function noopRuntime(endpoint = ""): CtBrowserRuntime {
  return {
    step(): void {},
    enter(): void {},
    ret(_fnId: number, value?: unknown): unknown {
      return value;
    },
    write(): void {},
    value(): void {},
    markCorrelation(): void {},
    flush(): void {},
    stop(): void {},
    get bufferedCount() {
      return 0;
    },
    get endpoint() {
      return endpoint;
    },
  };
}

// ── Singleton ────────────────────────────────────────────────────────────

/**
 * Install the runtime on `globalThis` as `__ct`.  Instrumented code
 * references `__ct.step(...)` / `__ct.enter(...)` / `__ct.ret(...)`, the
 * same call shape the Node recorder uses.
 *
 * Idempotent: calling twice returns the same runtime.
 */
export function installBrowserRuntime(
  options: CreateBrowserRuntimeOptions = {},
): CtBrowserRuntime {
  const existing = (globalThis as { __ct?: CtBrowserRuntime }).__ct;
  if (existing) return existing;
  const runtime = createBrowserRuntime(options);
  (globalThis as { __ct?: CtBrowserRuntime }).__ct = runtime;
  return runtime;
}

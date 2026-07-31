/**
 * CodeTracer runtime — the `__ct` global that instrumented code calls.
 *
 * Responsibilities:
 *   1. Buffer step / enter / ret events in typed arrays (no per-event objects).
 *   2. Load the trace manifest so site/function metadata is available.
 *   3. Flush buffered events at configurable thresholds, on process exit,
 *      and on uncaught exceptions.
 *   4. Become a complete no-op when CODETRACER_JS_RECORDER_DISABLED=true.
 *   5. Optionally connect to the Rust N-API addon for trace writing.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import {
  EventBuffer,
  EVENT_STEP,
  EVENT_ENTER,
  EVENT_RET,
  EVENT_WRITE,
  EVENT_ASSIGNMENT,
  EVENT_MARKER,
} from "./buffer.js";
import type {
  FlushCallback,
  EventBatch,
  EncodedValue,
  WriteEntry,
  MarkerEntry,
} from "./buffer.js";
import { readConfig } from "./config.js";
import type { RuntimeConfig } from "./config.js";
import { installConsoleCapture, removeConsoleCapture } from "./io-capture.js";
import { AsyncContextTracker } from "./async-context.js";
import type { SpanMetadata, SpanSink, SpanStatus } from "./spans.js";

// ── Correlation keys ────────────────────────────────────────────────

/**
 * Render a correlation key as the string the pair index matches on.
 *
 * Marker pairing is string equality, so both sides of a boundary must
 * stringify the same logical identifier identically. Plain strings pass
 * through untouched (the overwhelmingly common case: a request id, an
 * order id, a `traceparent` header). Everything else goes through
 * `JSON.stringify` so a numeric id recorded as `42` on one side matches
 * a numeric id on the other — but a *string* `"42"` deliberately does
 * not collide with it, because those are different values in the
 * program and conflating them would pair unrelated crossings.
 */
function stringifyCorrelationKey(key: unknown): string {
  if (typeof key === "string") return key;
  if (key === undefined) return "undefined";
  try {
    return JSON.stringify(key) ?? String(key);
  } catch {
    // Circular or otherwise unserialisable — fall back to a coarse
    // description rather than throwing inside the user's program.
    return String(key);
  }
}

// ── Value encoding ──────────────────────────────────────────────────

/** Maximum string length before truncation. */
const MAX_STRING_LENGTH = 1000;

/** Default maximum depth for nested object/array encoding. */
const DEFAULT_MAX_DEPTH = 5;

/** Default maximum number of elements/fields captured per object/array. */
const DEFAULT_MAX_SIZE = 100;

/** Options for controlling deep value encoding behavior. */
export interface EncodeValueOptions {
  /** Maximum nesting depth before values are encoded as "[depth limit]". Default: 5. */
  maxDepth?: number;
  /** Maximum number of elements/fields per object/array. Default: 100. */
  maxSize?: number;
}

/**
 * Encode a JavaScript value into a serializable format with type annotation.
 *
 * Handles primitive types, arrays, plain objects, Map, Set, Error, RegExp,
 * Date, and functions. Supports depth limiting, circular reference detection,
 * and size limiting for safe serialization of complex values.
 *
 * This function never throws and never infinite-loops.
 */
export function encodeValue(
  value: unknown,
  options?: EncodeValueOptions,
): EncodedValue {
  const maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxSize = options?.maxSize ?? DEFAULT_MAX_SIZE;
  const seen = new WeakSet<object>();

  return encodeValueInner(value, 0, maxDepth, maxSize, seen);
}

/**
 * Inner recursive encoder with depth tracking and circular reference detection.
 */
function encodeValueInner(
  value: unknown,
  depth: number,
  maxDepth: number,
  maxSize: number,
  seen: WeakSet<object>,
): EncodedValue {
  try {
    // Primitives: null and undefined
    if (value === undefined) {
      return { value: null, typeKind: "None" };
    }
    if (value === null) {
      return { value: null, typeKind: "None" };
    }

    switch (typeof value) {
      case "boolean":
        return { value, typeKind: "Bool" };

      case "number":
        if (Number.isNaN(value)) {
          return { value: "NaN", typeKind: "Raw" };
        }
        if (!Number.isFinite(value)) {
          return {
            value: value > 0 ? "Infinity" : "-Infinity",
            typeKind: "Raw",
          };
        }
        if (Number.isInteger(value)) {
          return { value, typeKind: "Int" };
        }
        return { value, typeKind: "Float" };

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
          value: (value as Function).name || "anonymous",
          typeKind: "FunctionKind",
        };

      case "object":
        return encodeObject(value as object, depth, maxDepth, maxSize, seen);

      default:
        return { value: typeof value, typeKind: "Raw" };
    }
  } catch {
    // Safety net: never throw from encodeValue
    return { value: "[encoding error]", typeKind: "Raw" };
  }
}

/**
 * Encode an object value (arrays, plain objects, Map, Set, Error, RegExp, Date).
 */
function encodeObject(
  obj: object,
  depth: number,
  maxDepth: number,
  maxSize: number,
  seen: WeakSet<object>,
): EncodedValue {
  // Circular reference detection
  if (seen.has(obj)) {
    return { value: "[circular]", typeKind: "Raw" };
  }

  // Depth limit check
  if (depth >= maxDepth) {
    return { value: "[depth limit]", typeKind: "Raw" };
  }

  // Track this object for circular reference detection
  seen.add(obj);

  try {
    // Date (check before plain object)
    if (obj instanceof Date) {
      return { value: obj.toISOString(), typeKind: "Raw" };
    }

    // RegExp (check before plain object)
    if (obj instanceof RegExp) {
      return { value: obj.toString(), typeKind: "Raw" };
    }

    // Error (check before plain object)
    if (obj instanceof Error) {
      return { value: obj.message, typeKind: "Error" };
    }

    // Array
    if (Array.isArray(obj)) {
      return encodeArray(obj, depth, maxDepth, maxSize, seen);
    }

    // Map
    if (obj instanceof Map) {
      return encodeMap(obj, depth, maxDepth, maxSize, seen);
    }

    // Set
    if (obj instanceof Set) {
      return encodeSet(obj, depth, maxDepth, maxSize, seen);
    }

    // Plain object (or other object types)
    return encodeStruct(obj, depth, maxDepth, maxSize, seen);
  } finally {
    // Remove from seen set after encoding so the same object can appear
    // in different branches of the object graph (just not recursively)
    seen.delete(obj);
  }
}

/**
 * Encode an array as Seq typeKind.
 */
function encodeArray(
  arr: unknown[],
  depth: number,
  maxDepth: number,
  maxSize: number,
  seen: WeakSet<object>,
): EncodedValue {
  const total = arr.length;
  const limit = Math.min(total, maxSize);
  const elements: EncodedValue[] = [];

  for (let i = 0; i < limit; i++) {
    elements.push(encodeValueInner(arr[i], depth + 1, maxDepth, maxSize, seen));
  }

  if (total > maxSize) {
    elements.push({
      value: `[... ${total - maxSize} more]`,
      typeKind: "Raw",
    });
  }

  return { value: elements, typeKind: "Seq" };
}

/**
 * Encode a Map as TableKind typeKind.
 */
function encodeMap(
  map: Map<unknown, unknown>,
  depth: number,
  maxDepth: number,
  maxSize: number,
  seen: WeakSet<object>,
): EncodedValue {
  const total = map.size;
  const limit = Math.min(total, maxSize);
  const entries: Array<{ key: EncodedValue; value: EncodedValue }> = [];

  let count = 0;
  for (const [key, val] of map) {
    if (count >= limit) break;
    entries.push({
      key: encodeValueInner(key, depth + 1, maxDepth, maxSize, seen),
      value: encodeValueInner(val, depth + 1, maxDepth, maxSize, seen),
    });
    count++;
  }

  if (total > maxSize) {
    entries.push({
      key: { value: `[... ${total - maxSize} more]`, typeKind: "Raw" },
      value: { value: null, typeKind: "None" },
    });
  }

  return { value: entries, typeKind: "TableKind" };
}

/**
 * Encode a Set as Set typeKind.
 */
function encodeSet(
  set: Set<unknown>,
  depth: number,
  maxDepth: number,
  maxSize: number,
  seen: WeakSet<object>,
): EncodedValue {
  const total = set.size;
  const limit = Math.min(total, maxSize);
  const elements: EncodedValue[] = [];

  let count = 0;
  for (const val of set) {
    if (count >= limit) break;
    elements.push(encodeValueInner(val, depth + 1, maxDepth, maxSize, seen));
    count++;
  }

  if (total > maxSize) {
    elements.push({
      value: `[... ${total - maxSize} more]`,
      typeKind: "Raw",
    });
  }

  return { value: elements, typeKind: "Set" };
}

/**
 * Encode a plain object as Struct typeKind.
 */
function encodeStruct(
  obj: object,
  depth: number,
  maxDepth: number,
  maxSize: number,
  seen: WeakSet<object>,
): EncodedValue {
  let keys: string[];
  try {
    keys = Object.keys(obj);
  } catch {
    // Some exotic objects may throw on Object.keys
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
      value: encodeValueInner(val, depth + 1, maxDepth, maxSize, seen),
    });
  }

  if (total > maxSize) {
    fields.push({
      name: `[... ${total - maxSize} more]`,
      value: { value: null, typeKind: "None" },
    });
  }

  return { value: { fields }, typeKind: "Struct" };
}

// createRequire needs a base URL; in CJS __filename is available.
const _require = createRequire(__filename);

// ── Native addon interface ──────────────────────────────────────────

/**
 * Shape of the Rust N-API addon exports.
 *
 * Per `codetracer-specs/Recorder-CLI-Conventions.md` §4 the addon is
 * CTFS-only — there is no `format` parameter on `startRecording`.
 */
export interface NativeAddon {
  version(): string;
  startRecording(opts: {
    outDir: string;
    program: string;
    args: string[];
    manifestJson: string;
    /**
     * P2.6: opt the writer into column-aware step encoding (CTFS
     * `DeltaColumn` tag 0x07 + `paths.dat` Layout A line-length
     * tables).  Defaults to `true`; pass `false` to fall back to
     * line-only step encoding (matches the pre-P2 trace shape).
     * See `codetracer-specs/Planned-Features/
     * Column-Aware-Tracing-And-Deminification.milestones.org` §P2.
     */
    columnAware?: boolean;
  }): number;
  appendEvents(
    handle: number,
    eventKinds: Uint8Array,
    ids: Uint32Array,
    valuesJson: string,
    writesJson?: string,
    /**
     * M25 correlation markers for `EVENT_MARKER` slots, as a JSON array
     * of `MarkerEntry`. Optional so an older addon build keeps working
     * (it simply ignores the extra argument and the markers are lost).
     */
    markersJson?: string,
  ): void;
  flushAndStop(handle: number): string;
  /**
   * RS-M9: open a span at the current end of the addon's buffered event
   * stream.  The caller must have flushed its own buffer first — a span's
   * extent is a position in that stream, so an unflushed buffer would place
   * the boundary in the past.  `metadataJson` is a `[[key, value], ...]`
   * array; order is part of the wire contract.  Returns the new span id.
   */
  spanOpen(
    handle: number,
    spanType: string,
    label: string,
    metadataJson: string,
  ): number;
  /** RS-M9: settle a span opened by `spanOpen`.  Idempotent. */
  spanClose(
    handle: number,
    spanId: number,
    status: number,
    metadataJson: string,
  ): void;
  /**
   * RS-M9: decode a recorded container's span stream to JSON through the
   * canonical Nim reader — the same decoder `ct print -f http` uses.
   */
  readSpanStream(containerPath: string, settled: boolean): string;
}

/** Options for starting a recording session. */
export interface StartRecordingOptions {
  /** The runtime instance to connect to. */
  runtime: CtRuntime;
  /** Path to the native addon (.node file). */
  addonPath: string;
  /** Output directory for traces. */
  outDir: string;
  /** Program name (e.g., "app.js"). */
  program: string;
  /** Program arguments. */
  args?: string[];
  /** When true, do NOT register process.on('exit') for auto flush+stop. */
  skipProcessHooks?: boolean;
  /**
   * P2.6: opt the writer into column-aware step encoding.  Defaults to
   * `true` (matches the spec's recommended default).  Pass `false` to
   * fall back to line-only steps; the trace will be smaller but the
   * column-aware decoder will surface `column = None` for every step.
   */
  columnAware?: boolean;
}

/** Handle returned by startRecording, used to control the recording. */
export interface RecordingSession {
  /** The numeric handle used by the native addon. */
  handle: number;
  /** The native addon instance. */
  addon: NativeAddon;
  /** Flush remaining events and finalize the trace. Returns the trace directory path. */
  stop(): string;
}

// ── Manifest types ──────────────────────────────────────────────────

export interface ManifestFunctionEntry {
  name: string;
  pathIndex: number;
  line: number;
  col: number;
  params?: string[];
}

export interface ManifestSiteEntry {
  kind: string;
  pathIndex: number;
  line: number;
  col: number;
  fnId?: number;
}

export interface TraceManifest {
  formatVersion: number;
  paths: string[];
  functions: ManifestFunctionEntry[];
  sites: ManifestSiteEntry[];
}

// ── CtRuntime interface ─────────────────────────────────────────────

export interface CtRuntime {
  init(manifestPath: string): void;
  step(siteId: number): void;
  enter(fnId: number, argsLike: IArguments): void;
  ret(fnId: number, value?: unknown): unknown;
  /**
   * M16a: synthetic assignment event.
   *
   * Called by instrumented code after every recognised
   * simple-assignment shape (`const b = a`, `x = expr`, parameter
   * binding).  The runtime resolves the manifest entry for
   * `siteId`, mints a `BindVariable` event the first time it sees
   * the target name in the current scope, then a stamped
   * `Assignment` event whose `RValue` is taken from the manifest
   * write-site metadata.  See the SWC visitor
   * (`packages/instrumenter/src/visitor.ts`,
   * `collectAssignmentSitesFromStatement`) for the shape set.
   *
   * No-op when the manifest entry is absent (e.g. when running an
   * un-instrumented program against a stale manifest).  Never
   * throws — the runtime is designed to be transparent to the host
   * program even when its bookkeeping is wrong.
   */
  write(siteId: number, value?: unknown): void;

  /**
   * M25 correlation marker — record that a value crossed a process
   * boundary at this point in the program.
   *
   * This is the user-facing half of cross-process debugging. CodeTracer
   * deliberately runs no protocol shims: it does not hook `fetch`, HTTP
   * servers, message queues, or any other transport. Instead the
   * program itself declares the crossing at the source location where
   * it happens, which is the only place that reliably knows *which*
   * identifier correlates the two sides.
   *
   * Both processes must record a marker with the same `boundary` and
   * the same `key` — pairing is string equality — and opposite
   * directions:
   *
   * ```js
   * // sender
   * __ct.markCorrelation("send", "order-flow", orderId);
   * await fetch("/api/orders", { body: JSON.stringify({ orderId, ... }) });
   *
   * // receiver, in the other process
   * __ct.markCorrelation("recv", "order-flow", body.orderId);
   * ```
   *
   * With both recordings loaded as one session, an origin query on a
   * value derived from the request can then walk backwards out of the
   * receiving process and continue inside the sender.
   *
   * Never throws: a failed marker must not take the host program down.
   *
   * @param direction `"send"` where the value leaves, `"recv"` where it arrives.
   * @param boundary Identifier shared by both sides of the crossing.
   * @param key Correlation key; stringified before it goes on the wire.
   * @param payload Optional human-readable label for the boundary hop.
   * @param showText Name of the binding the value came from on this side.
   *   A chain crossing this boundary resumes its walk on this name, so
   *   supplying it is what makes the history beyond the boundary
   *   reachable.
   */
  markCorrelation(
    direction: "send" | "recv",
    boundary: string,
    key: unknown,
    payload?: unknown,
    showText?: string,
  ): void;

  /**
   * Enable async context tracking.
   *
   * Once enabled, the runtime will automatically emit ThreadStart and
   * ThreadSwitch events when execution moves between async contexts
   * (e.g., across await boundaries, setTimeout callbacks).
   */
  enableAsyncTracking(): void;

  /**
   * Disable async context tracking.
   */
  disableAsyncTracking(): void;

  /**
   * RS-M9: open a web-request span at this instant of the recording.
   *
   * Called by framework middleware (see `@codetracer/express`), never by
   * instrumented user code.  Returns the span id to pass to
   * `webRequestStop`, or 0 when no recording is active — in which case
   * `webRequestStop` is a no-op, so middleware can stay installed
   * unconditionally.
   *
   * Before the boundary is taken this checks the async context, so the exec
   * stream records which context (== container thread) the request entered
   * on, and flushes the event buffer, so the span's mark really is "the end
   * of everything recorded so far".
   */
  webRequestStart(label: string, metadata: SpanMetadata): number;

  /** RS-M9: settle a span opened by `webRequestStart`.  A 0 id is a no-op. */
  webRequestStop(
    spanId: number,
    status: SpanStatus,
    metadata: SpanMetadata,
  ): void;

  /**
   * Install (or clear, with `null`) the sink span boundaries are forwarded
   * to.  `startRecording` installs one backed by the native addon.
   */
  attachSpanSink(sink: SpanSink | null): void;

  // ── testing / inspection helpers ──
  /** The underlying event buffer (exposed for testing). */
  readonly buffer: EventBuffer;
  /** The loaded manifest, or null if init() has not been called yet. */
  readonly manifest: TraceManifest | null;
  /** The resolved configuration. */
  readonly config: RuntimeConfig;
  /** Whether the runtime has been initialized. */
  readonly initialized: boolean;
  /** The async context tracker (exposed for testing). */
  readonly asyncTracker: AsyncContextTracker;
  /** Manually flush remaining buffered events. */
  flush(): void;
}

// ── Factory ─────────────────────────────────────────────────────────

export interface CreateRuntimeOptions {
  /** Override buffer capacity (default 4096). */
  bufferCapacity?: number;
  /** Override flush callback (default: store in flushedBatches). */
  onFlush?: FlushCallback;
  /**
   * When true, the runtime will NOT register process.on('exit') etc.
   * Useful for unit tests that create many runtimes.
   */
  skipProcessHooks?: boolean;
}

/**
 * Create a new CtRuntime instance.
 *
 * Typically called once at startup; the returned object is the `__ct` global.
 */
export function createRuntime(opts: CreateRuntimeOptions = {}): CtRuntime {
  const config = readConfig();
  const buffer = new EventBuffer(opts.bufferCapacity ?? 4096);

  if (opts.onFlush) {
    buffer.onFlush = opts.onFlush;
  }

  let manifest: TraceManifest | null = null;
  let initialized = false;

  const asyncTracker = new AsyncContextTracker();

  /** Where web-request span boundaries go once a recording is active. */
  let spanSink: SpanSink | null = null;

  // ── Disabled mode ───────────────────────────────────────────────
  if (config.disabled) {
    const noop: CtRuntime = {
      init(_manifestPath: string): void {},
      step(_siteId: number): void {},
      enter(_fnId: number, _argsLike: IArguments): void {},
      ret(_fnId: number, value?: unknown): unknown {
        return value;
      },
      write(_siteId: number, _value?: unknown): void {},
      markCorrelation(
        _direction: "send" | "recv",
        _boundary: string,
        _key: unknown,
        _payload?: unknown,
        _showText?: string,
      ): void {},
      enableAsyncTracking(): void {},
      disableAsyncTracking(): void {},
      webRequestStart(_label: string, _metadata: SpanMetadata): number {
        return 0;
      },
      webRequestStop(
        _spanId: number,
        _status: SpanStatus,
        _metadata: SpanMetadata,
      ): void {},
      attachSpanSink(_sink: SpanSink | null): void {},
      get buffer() {
        return buffer;
      },
      get manifest() {
        return null;
      },
      get config() {
        return config;
      },
      get initialized() {
        return false;
      },
      get asyncTracker() {
        return asyncTracker;
      },
      flush(): void {},
    };
    return noop;
  }

  // ── Active runtime ──────────────────────────────────────────────

  function flush(): void {
    buffer.flush();
  }

  const runtime: CtRuntime = {
    init(manifestPath: string): void {
      if (initialized) return;
      initialized = true;

      // Load the manifest from disk.
      const resolved = path.resolve(manifestPath);
      const raw = fs.readFileSync(resolved, "utf-8");
      manifest = JSON.parse(raw) as TraceManifest;
    },

    step(siteId: number): void {
      try {
        asyncTracker.checkContext(buffer);
        buffer.push(EVENT_STEP, siteId);
      } catch {
        // Never crash the user's program
      }
    },

    enter(fnId: number, argsLike: IArguments): void {
      try {
        asyncTracker.checkContext(buffer);
        buffer.push(EVENT_ENTER, fnId);
        // Capture argument values in the side channel
        const encodedArgs: EncodedValue[] = [];
        for (let i = 0; i < argsLike.length; i++) {
          encodedArgs.push(encodeValue(argsLike[i]));
        }
        buffer.pushValue({
          eventIndex: buffer.length - 1,
          args: encodedArgs,
        });
      } catch {
        // Never crash the user's program
      }
    },

    ret(fnId: number, value?: unknown): unknown {
      try {
        asyncTracker.checkContext(buffer);
        buffer.push(EVENT_RET, fnId);
        // Capture return value in the side channel
        buffer.pushValue({
          eventIndex: buffer.length - 1,
          returnValue: encodeValue(value),
        });
      } catch {
        // Never crash the user's program
      }
      return value;
    },

    write(siteId: number, value?: unknown): void {
      // M16a: emit an EVENT_ASSIGNMENT for the site.  The native
      // addon resolves the manifest write-site entry for `siteId`
      // and lowers it into a `BindVariable + Assignment` pair on the
      // trace stream.  We do not attempt to read the live binding
      // here — the M14 spec carries the RValue description on the
      // Assignment event, and the corresponding `Value` event for
      // the target name is emitted independently by the existing
      // step-level value-snapshot pass.
      try {
        asyncTracker.checkContext(buffer);
        buffer.push(EVENT_ASSIGNMENT, siteId);
        buffer.pushValue({
          eventIndex: buffer.length - 1,
          assignmentValue: encodeValue(value),
        });
      } catch {
        // Never crash the user's program
      }
    },

    markCorrelation(
      direction: "send" | "recv",
      boundary: string,
      key: unknown,
      payload?: unknown,
      showText?: string,
    ): void {
      try {
        asyncTracker.checkContext(buffer);
        // The marker carries no site id of its own: its source position
        // comes from the enclosing step, which is exactly the line the
        // user wrote the call on. The native addon writes it as a
        // tracepoint Event, and the trace reader attributes that event
        // to the most recent Step — so the marker lands on the crossing
        // line without the instrumenter needing to mint a site for it.
        buffer.push(EVENT_MARKER, 0);
        buffer.pushMarker({
          eventIndex: buffer.length - 1,
          direction,
          boundary,
          key: stringifyCorrelationKey(key),
          payload:
            payload === undefined
              ? undefined
              : stringifyCorrelationKey(payload),
          showText,
        });
      } catch {
        // Never crash the user's program
      }
    },

    enableAsyncTracking(): void {
      asyncTracker.enable(buffer);
    },

    disableAsyncTracking(): void {
      asyncTracker.disable();
    },

    webRequestStart(label: string, metadata: SpanMetadata): number {
      if (!spanSink) return 0;
      try {
        // Record the async context the request entered on BEFORE the mark is
        // taken; otherwise the span binds to whichever context the last
        // instrumented event happened to run on, and the contiguity bit is
        // then measured against the wrong thread.
        asyncTracker.checkContext(buffer);
        flush();
        return spanSink.open("web-request", label, metadata);
      } catch {
        // A recorder failure must never change how a server answers.
        return 0;
      }
    },

    webRequestStop(
      spanId: number,
      status: SpanStatus,
      metadata: SpanMetadata,
    ): void {
      if (!spanSink || !spanId) return;
      try {
        asyncTracker.checkContext(buffer);
        flush();
        spanSink.close(spanId, status, metadata);
      } catch {
        // As above.
      }
    },

    attachSpanSink(sink: SpanSink | null): void {
      spanSink = sink;
    },

    get buffer() {
      return buffer;
    },
    get manifest() {
      return manifest;
    },
    get config() {
      return config;
    },
    get initialized() {
      return initialized;
    },
    get asyncTracker() {
      return asyncTracker;
    },

    flush,
  };

  // ── Lifecycle hooks ─────────────────────────────────────────────
  if (!opts.skipProcessHooks) {
    process.on("exit", () => {
      flush();
    });

    process.on("uncaughtException", (err) => {
      flush();
      // Re-throw so the default handler still fires.
      throw err;
    });

    process.on("unhandledRejection", (_reason) => {
      flush();
    });
  }

  return runtime;
}

// ── Recording integration ───────────────────────────────────────────

/**
 * Load the native addon from the given path.
 *
 * Uses createRequire to load the .node file as a CommonJS module,
 * which is how napi-rs addons are loaded.
 *
 * Returns null if the addon fails to load (graceful degradation).
 */
export function loadNativeAddon(addonPath: string): NativeAddon | null {
  try {
    const resolved = path.resolve(addonPath);
    return _require(resolved) as NativeAddon;
  } catch (err) {
    process.stderr.write(
      `[codetracer] Warning: failed to load native addon from '${addonPath}': ${err}\n`,
    );
    return null;
  }
}

/**
 * Start a recording session.
 *
 * This connects a CtRuntime to the Rust trace writer via the native addon:
 *   1. Loads the native addon
 *   2. Calls startRecording on it with the manifest
 *   3. Sets up the buffer's onFlush callback to forward events to appendEvents
 *   4. Optionally registers process exit hooks to auto-stop
 *
 * The runtime must already be initialized (init() called) so the manifest
 * is available.
 */
export function startRecording(
  opts: StartRecordingOptions,
): RecordingSession | null {
  const {
    runtime,
    addonPath,
    outDir,
    program,
    args = [],
    skipProcessHooks = false,
    columnAware = true,
  } = opts;

  if (!runtime.manifest) {
    throw new Error(
      "Runtime must be initialized (call runtime.init(manifestPath)) before startRecording",
    );
  }

  // Load the native addon — returns null on failure (graceful degradation)
  const addonOrNull = loadNativeAddon(addonPath);
  if (!addonOrNull) {
    process.stderr.write(
      "[codetracer] Warning: recording disabled — native addon failed to load. Program will run normally.\n",
    );
    return null;
  }
  const addon: NativeAddon = addonOrNull;

  // Serialize the manifest to JSON for the Rust side
  const manifestJson = JSON.stringify(runtime.manifest);

  let handle: number;
  try {
    // Start recording on the Rust side
    handle = addon.startRecording({
      outDir,
      program,
      args,
      manifestJson,
      columnAware,
    });
  } catch (err) {
    process.stderr.write(
      `[codetracer] Warning: failed to start recording: ${err}\n`,
    );
    return null;
  }

  let stopped = false;

  // Wire the buffer's onFlush callback to forward batches to the addon
  runtime.buffer.onFlush = (batch: EventBatch) => {
    if (!stopped) {
      try {
        const valuesJson =
          batch.values.length > 0 ? JSON.stringify(batch.values) : "[]";
        const writesJson =
          batch.writes.length > 0 ? JSON.stringify(batch.writes) : "[]";
        const markersJson =
          batch.markers.length > 0 ? JSON.stringify(batch.markers) : "[]";
        addon.appendEvents(
          handle,
          batch.eventKinds,
          batch.ids,
          valuesJson,
          writesJson,
          markersJson,
        );
      } catch (err) {
        process.stderr.write(
          `[codetracer] Warning: failed to append events: ${err}\n`,
        );
      }
    }
  };

  // RS-M9: forward web-request span boundaries into the container's span
  // stream.  Installed before async tracking is enabled so a middleware that
  // opens a span in the very first tick still lands.
  runtime.attachSpanSink({
    open(spanType: string, label: string, metadata: SpanMetadata): number {
      if (stopped) return 0;
      return addon.spanOpen(handle, spanType, label, JSON.stringify(metadata));
    },
    close(spanId: number, status: SpanStatus, metadata: SpanMetadata): void {
      if (stopped) return;
      addon.spanClose(handle, spanId, status, JSON.stringify(metadata));
    },
  });

  // Enable async context tracking for the recording session
  runtime.enableAsyncTracking();

  // Install console capture to record Write events
  installConsoleCapture((kind: string, content: string) => {
    try {
      runtime.buffer.push(EVENT_WRITE, 0);
      runtime.buffer.pushWrite({
        eventIndex: runtime.buffer.length - 1,
        kind,
        content,
      });
    } catch {
      // Never let capture errors affect the program
    }
  });

  function stop(): string {
    if (stopped) {
      throw new Error("Recording session already stopped");
    }

    // Remove console capture and disable async tracking before flushing
    removeConsoleCapture();
    runtime.disableAsyncTracking();
    runtime.attachSpanSink(null);

    // Flush any remaining buffered events first (while onFlush is still active)
    runtime.flush();

    // Mark as stopped after flushing so the onFlush callback runs
    stopped = true;

    // Finalize the trace on the Rust side
    try {
      return addon.flushAndStop(handle);
    } catch (err) {
      process.stderr.write(
        `[codetracer] Warning: failed to finalize trace: ${err}\n`,
      );
      return "";
    }
  }

  // Register process exit hooks to auto-stop
  if (!skipProcessHooks) {
    process.on("exit", () => {
      if (!stopped) {
        try {
          stop();
        } catch {
          // Never crash on exit
        }
      }
    });
  }

  return { handle, addon, stop };
}

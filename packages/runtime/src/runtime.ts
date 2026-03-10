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
} from "./buffer.js";
import type {
  FlushCallback,
  EventBatch,
  EncodedValue,
  WriteEntry,
} from "./buffer.js";
import { readConfig } from "./config.js";
import type { RuntimeConfig } from "./config.js";
import { installConsoleCapture, removeConsoleCapture } from "./io-capture.js";
import { AsyncContextTracker } from "./async-context.js";

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

/** Shape of the Rust N-API addon exports. */
export interface NativeAddon {
  version(): string;
  startRecording(opts: {
    outDir: string;
    program: string;
    args: string[];
    manifestJson: string;
    format: string;
  }): number;
  appendEvents(
    handle: number,
    eventKinds: Uint8Array,
    ids: Uint32Array,
    valuesJson: string,
    writesJson?: string,
  ): void;
  flushAndStop(handle: number): string;
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
  /** Trace format: "binary" or "json". */
  format?: "binary" | "json";
  /** When true, do NOT register process.on('exit') for auto flush+stop. */
  skipProcessHooks?: boolean;
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

  // ── Disabled mode ───────────────────────────────────────────────
  if (config.disabled) {
    const noop: CtRuntime = {
      init(_manifestPath: string): void {},
      step(_siteId: number): void {},
      enter(_fnId: number, _argsLike: IArguments): void {},
      ret(_fnId: number, value?: unknown): unknown {
        return value;
      },
      enableAsyncTracking(): void {},
      disableAsyncTracking(): void {},
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

    enableAsyncTracking(): void {
      asyncTracker.enable(buffer);
    },

    disableAsyncTracking(): void {
      asyncTracker.disable();
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
    format = "json",
    skipProcessHooks = false,
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
      format,
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
        addon.appendEvents(
          handle,
          batch.eventKinds,
          batch.ids,
          valuesJson,
          writesJson,
        );
      } catch (err) {
        process.stderr.write(
          `[codetracer] Warning: failed to append events: ${err}\n`,
        );
      }
    }
  };

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

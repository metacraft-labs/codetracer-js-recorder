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
import { EventBuffer, EVENT_STEP, EVENT_ENTER, EVENT_RET } from "./buffer.js";
import type { FlushCallback, EventBatch } from "./buffer.js";
import { readConfig } from "./config.js";
import type { RuntimeConfig } from "./config.js";

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
  appendEvents(handle: number, eventKinds: Uint8Array, ids: Uint32Array): void;
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

  // ── testing / inspection helpers ──
  /** The underlying event buffer (exposed for testing). */
  readonly buffer: EventBuffer;
  /** The loaded manifest, or null if init() has not been called yet. */
  readonly manifest: TraceManifest | null;
  /** The resolved configuration. */
  readonly config: RuntimeConfig;
  /** Whether the runtime has been initialized. */
  readonly initialized: boolean;
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

  // ── Disabled mode ───────────────────────────────────────────────
  if (config.disabled) {
    const noop: CtRuntime = {
      init(_manifestPath: string): void {},
      step(_siteId: number): void {},
      enter(_fnId: number, _argsLike: IArguments): void {},
      ret(_fnId: number, value?: unknown): unknown {
        return value;
      },
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
      buffer.push(EVENT_STEP, siteId);
    },

    enter(fnId: number, _argsLike: IArguments): void {
      buffer.push(EVENT_ENTER, fnId);
    },

    ret(fnId: number, value?: unknown): unknown {
      buffer.push(EVENT_RET, fnId);
      return value;
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
 */
export function loadNativeAddon(addonPath: string): NativeAddon {
  const resolved = path.resolve(addonPath);
  return _require(resolved) as NativeAddon;
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
export function startRecording(opts: StartRecordingOptions): RecordingSession {
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

  // Load the native addon
  const addon = loadNativeAddon(addonPath);

  // Serialize the manifest to JSON for the Rust side
  const manifestJson = JSON.stringify(runtime.manifest);

  // Start recording on the Rust side
  const handle = addon.startRecording({
    outDir,
    program,
    args,
    manifestJson,
    format,
  });

  let stopped = false;

  // Wire the buffer's onFlush callback to forward batches to the addon
  runtime.buffer.onFlush = (batch: EventBatch) => {
    if (!stopped) {
      addon.appendEvents(handle, batch.eventKinds, batch.ids);
    }
  };

  function stop(): string {
    if (stopped) {
      throw new Error("Recording session already stopped");
    }

    // Flush any remaining buffered events first (while onFlush is still active)
    runtime.flush();

    // Mark as stopped after flushing so the onFlush callback runs
    stopped = true;

    // Finalize the trace on the Rust side
    return addon.flushAndStop(handle);
  }

  // Register process exit hooks to auto-stop
  if (!skipProcessHooks) {
    process.on("exit", () => {
      if (!stopped) {
        stop();
      }
    });
  }

  return { handle, addon, stop };
}

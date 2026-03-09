/**
 * CodeTracer runtime — the `__ct` global that instrumented code calls.
 *
 * Responsibilities:
 *   1. Buffer step / enter / ret events in typed arrays (no per-event objects).
 *   2. Load the trace manifest so site/function metadata is available.
 *   3. Flush buffered events at configurable thresholds, on process exit,
 *      and on uncaught exceptions.
 *   4. Become a complete no-op when CODETRACER_JS_RECORDER_DISABLED=true.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { EventBuffer, EVENT_STEP, EVENT_ENTER, EVENT_RET } from "./buffer.js";
import type { FlushCallback } from "./buffer.js";
import { readConfig } from "./config.js";
import type { RuntimeConfig } from "./config.js";

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

/**
 * CodeTracer runtime library.
 *
 * Instrumented code calls these functions. Events are buffered in typed arrays
 * and flushed in batches (to the Rust N-API addon once M3 lands).
 *
 * Public surface:
 *   - `__ct`           — the singleton runtime instance
 *   - `createRuntime`  — factory for testing / advanced use
 *   - Config / Buffer types for inspection
 */

// ── Re-exports ──────────────────────────────────────────────────────

export { readConfig } from "./config.js";
export type { RuntimeConfig } from "./config.js";

export { EventBuffer, EVENT_STEP, EVENT_ENTER, EVENT_RET } from "./buffer.js";
export type { EventBatch, EventKind, FlushCallback } from "./buffer.js";

export { createRuntime } from "./runtime.js";
export type {
  CtRuntime,
  TraceManifest,
  ManifestFunctionEntry,
  ManifestSiteEntry,
  CreateRuntimeOptions,
} from "./runtime.js";

// ── Singleton ───────────────────────────────────────────────────────

import { createRuntime } from "./runtime.js";
import type { CtRuntime } from "./runtime.js";

/**
 * Global runtime instance.
 *
 * Instrumented code references `__ct.step()`, `__ct.enter()`, `__ct.ret()`.
 * The singleton registers process lifecycle hooks (exit, uncaughtException,
 * unhandledRejection) to ensure buffered events are flushed.
 */
export const __ct: CtRuntime = createRuntime();

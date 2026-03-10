/**
 * CodeTracer runtime library.
 *
 * Instrumented code calls these functions. Events are buffered in typed arrays
 * and flushed in batches to the Rust N-API trace writer addon.
 *
 * Public surface:
 *   - `__ct`              — the singleton runtime instance
 *   - `createRuntime`     — factory for testing / advanced use
 *   - `startRecording`    — connect runtime to Rust trace writer
 *   - `loadNativeAddon`   — load the native .node addon
 *   - Config / Buffer types for inspection
 */

// ── Re-exports ──────────────────────────────────────────────────────

export { readConfig } from "./config.js";
export type { RuntimeConfig } from "./config.js";

export {
  EventBuffer,
  EVENT_STEP,
  EVENT_ENTER,
  EVENT_RET,
  EVENT_WRITE,
  EVENT_THREAD_START,
  EVENT_THREAD_SWITCH,
  EVENT_THREAD_EXIT,
} from "./buffer.js";
export type {
  EventBatch,
  EventKind,
  FlushCallback,
  EncodedValue,
  ValueEntry,
  WriteEntry,
} from "./buffer.js";

export { encodeValue } from "./runtime.js";
export type { EncodeValueOptions } from "./runtime.js";

export { installConsoleCapture, removeConsoleCapture } from "./io-capture.js";

export { AsyncContextTracker } from "./async-context.js";

export { createRuntime, loadNativeAddon, startRecording } from "./runtime.js";
export type {
  CtRuntime,
  TraceManifest,
  ManifestFunctionEntry,
  ManifestSiteEntry,
  CreateRuntimeOptions,
  NativeAddon,
  StartRecordingOptions,
  RecordingSession,
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

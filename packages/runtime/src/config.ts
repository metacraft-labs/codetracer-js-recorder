/**
 * Environment variable configuration for the CodeTracer JS runtime.
 *
 * All values are read once at init() time and cached for the duration
 * of the process.
 *
 * Per `codetracer-specs/Recorder-CLI-Conventions.md` §4 the recorder is
 * CTFS-only — it never reads `CODETRACER_FORMAT` and never writes JSON.
 * Use `ct print` from `codetracer-trace-format-nim` to convert the
 * produced `.ct` bundle to human-readable JSON / text.
 */

export interface RuntimeConfig {
  /** Output directory for traces. Default: "./ct-traces/" */
  outDir: string;
  /** When true, all runtime methods become no-ops. */
  disabled: boolean;
  /** Include glob patterns from environment variable. */
  include: string[];
  /** Exclude glob patterns from environment variable. */
  exclude: string[];
}

/**
 * Read configuration from environment variables.
 *
 * - CODETRACER_JS_RECORDER_OUT_DIR — output directory (default: "./ct-traces/")
 * - CODETRACER_JS_RECORDER_DISABLED — if "true" / "1", runtime is disabled
 * - CODETRACER_JS_RECORDER_INCLUDE — comma-separated include glob patterns
 * - CODETRACER_JS_RECORDER_EXCLUDE — comma-separated exclude glob patterns
 *
 * `CODETRACER_FORMAT` is NOT read — recorders are CTFS-only per
 * Recorder-CLI-Conventions.md §4.  The legacy variable is intentionally
 * absent so accidental reliance on it surfaces as missing behaviour.
 */
export function readConfig(): RuntimeConfig {
  const outDir = process.env.CODETRACER_JS_RECORDER_OUT_DIR ?? "./ct-traces/";

  const disabledRaw = process.env.CODETRACER_JS_RECORDER_DISABLED;
  const disabled =
    disabledRaw === "true" || disabledRaw === "1" || disabledRaw === "TRUE";

  const includeRaw = process.env.CODETRACER_JS_RECORDER_INCLUDE ?? "";
  const include = includeRaw
    ? includeRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  const excludeRaw = process.env.CODETRACER_JS_RECORDER_EXCLUDE ?? "";
  const exclude = excludeRaw
    ? excludeRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  return { outDir, disabled, include, exclude };
}

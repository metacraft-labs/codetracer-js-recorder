/**
 * Environment variable configuration for the CodeTracer JS runtime.
 *
 * All values are read once at init() time and cached for the duration
 * of the process.
 */

export interface RuntimeConfig {
  /** Output directory for traces. Default: "./ct-traces/" */
  outDir: string;
  /** Output format: "binary" or "json". Default: "binary" */
  format: "binary" | "json";
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
 * - CODETRACER_FORMAT — "binary" or "json" (default: "binary")
 * - CODETRACER_JS_RECORDER_DISABLED — if "true", runtime is disabled
 * - CODETRACER_JS_RECORDER_INCLUDE — comma-separated include glob patterns
 * - CODETRACER_JS_RECORDER_EXCLUDE — comma-separated exclude glob patterns
 */
export function readConfig(): RuntimeConfig {
  const outDir = process.env.CODETRACER_JS_RECORDER_OUT_DIR ?? "./ct-traces/";
  const formatRaw = process.env.CODETRACER_FORMAT ?? "binary";
  const format: "binary" | "json" = formatRaw === "json" ? "json" : "binary";
  const disabled = process.env.CODETRACER_JS_RECORDER_DISABLED === "true";

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

  return { outDir, format, disabled, include, exclude };
}

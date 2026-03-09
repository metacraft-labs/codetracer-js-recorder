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
}

/**
 * Read configuration from environment variables.
 *
 * - CODETRACER_JS_RECORDER_OUT_DIR — output directory (default: "./ct-traces/")
 * - CODETRACER_FORMAT — "binary" or "json" (default: "binary")
 * - CODETRACER_JS_RECORDER_DISABLED — if "true", runtime is disabled
 */
export function readConfig(): RuntimeConfig {
  const outDir = process.env.CODETRACER_JS_RECORDER_OUT_DIR ?? "./ct-traces/";
  const formatRaw = process.env.CODETRACER_FORMAT ?? "binary";
  const format: "binary" | "json" = formatRaw === "json" ? "json" : "binary";
  const disabled = process.env.CODETRACER_JS_RECORDER_DISABLED === "true";

  return { outDir, format, disabled };
}

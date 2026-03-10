/**
 * File filtering for instrumentation using glob patterns.
 *
 * Provides include/exclude pattern matching to control which files
 * get instrumented.
 */

import { createRequire } from "node:module";

const _require = createRequire(__filename);

// picomatch v4 has no TypeScript type declarations, so we load it via require
const picomatch: {
  isMatch: (
    path: string,
    patterns: string | string[],
    options?: { dot?: boolean },
  ) => boolean;
} = _require("picomatch");

/** Default include patterns: all JS/TS files. */
export const DEFAULT_INCLUDE = ["**/*.{js,ts,jsx,tsx}"];

/** Default exclude patterns: node_modules. */
export const DEFAULT_EXCLUDE = ["**/node_modules/**"];

export interface FilterOptions {
  /** Glob patterns for files to include. Defaults to DEFAULT_INCLUDE. */
  include?: string[];
  /** Glob patterns for files to exclude. Defaults to DEFAULT_EXCLUDE. */
  exclude?: string[];
}

/**
 * Check if a file path should be instrumented based on include/exclude patterns.
 *
 * A file is included if it matches at least one include pattern AND
 * does not match any exclude pattern.
 *
 * @param filePath The file path to check (relative paths work best)
 * @param options Filter options with include/exclude glob patterns
 * @returns true if the file should be instrumented
 */
export function shouldInstrument(
  filePath: string,
  options: FilterOptions = {},
): boolean {
  const include = options.include ?? DEFAULT_INCLUDE;
  const exclude = options.exclude ?? DEFAULT_EXCLUDE;

  // Normalize backslashes to forward slashes for cross-platform matching
  const normalized = filePath.replace(/\\/g, "/");

  // Must match at least one include pattern
  const included = picomatch.isMatch(normalized, include, { dot: true });
  if (!included) return false;

  // Must not match any exclude pattern
  const excluded = picomatch.isMatch(normalized, exclude, { dot: true });
  if (excluded) return false;

  return true;
}

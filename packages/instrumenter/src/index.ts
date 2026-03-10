export { instrument } from "./instrument.js";

export interface InstrumentOptions {
  /** Source file path (used for manifest and source map resolution) */
  filename: string;
  /** Include/exclude globs for filtering */
  include?: string[];
  exclude?: string[];
  /**
   * Explicitly provide an input source map (as a JSON string or parsed object).
   * If not provided, the instrumenter will attempt to detect inline or external
   * source maps from the source code.
   */
  inputSourceMap?: string | object;
}

export interface InstrumentResult {
  /** Instrumented JavaScript source */
  code: string;
  /** Source map for the instrumented code (chained through any input source map) */
  map?: string;
  /** Manifest slice for this file (paths, functions, sites) */
  manifestSlice: ManifestSlice;
}

export interface ManifestSlice {
  paths: string[];
  functions: FunctionEntry[];
  sites: SiteEntry[];
  /**
   * Original source contents keyed by source path, extracted from
   * input source maps. Used by the native addon to write files/
   * even when original sources are not on disk.
   */
  sourcesContent?: Record<string, string>;
}

export interface FunctionEntry {
  name: string;
  pathIndex: number;
  line: number;
  col: number;
}

export interface SiteEntry {
  kind: "step" | "call" | "return";
  pathIndex: number;
  line: number;
  col: number;
  fnId?: number;
}

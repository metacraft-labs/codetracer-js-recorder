export { instrument } from "./instrument.js";

export interface InstrumentOptions {
  /** Source file path (used for manifest and source map resolution) */
  filename: string;
  /** Include/exclude globs for filtering */
  include?: string[];
  exclude?: string[];
}

export interface InstrumentResult {
  /** Instrumented JavaScript source */
  code: string;
  /** Source map for the instrumented code */
  map?: string;
  /** Manifest slice for this file (paths, functions, sites) */
  manifestSlice: ManifestSlice;
}

export interface ManifestSlice {
  paths: string[];
  functions: FunctionEntry[];
  sites: SiteEntry[];
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

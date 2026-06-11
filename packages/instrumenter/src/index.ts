export { instrument } from "./instrument.js";
export {
  shouldInstrument,
  DEFAULT_INCLUDE,
  DEFAULT_EXCLUDE,
} from "./filter.js";
export type { FilterOptions } from "./filter.js";
export {
  tryAutoformat,
  looksMinified,
  runPrettier,
  resolveBundledPrettier,
  generateInverseSourceMap,
  autoformatEnabledByEnv,
  DEFAULT_MINIFIED_THRESHOLD,
} from "./autoformat.js";
export type {
  AutoformatOutcome,
  AutoformatOptions,
  PrettierOutcome,
} from "./autoformat.js";

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
  /**
   * P2.3: per-source line-length tables keyed by source path.  Each
   * entry is an array of byte counts — `lineLengths[path][i]` is the
   * addressable column count of source line `i+1` (1-based line
   * numbering matching the CTFS spec).  Used by the native addon to
   * populate `paths.dat` Layout A line-length tables so the canonical
   * column-aware reader can resolve `(line, column)` ↔
   * `global_position_index` round-trips.
   *
   * Lengths are byte counts (UTF-8 code units), not character counts —
   * this matches the SWC instrumenter's column offsets (also byte
   * counts).  See
   * `codetracer-trace-format-spec/trace-events.md` §"paths.dat
   * per-line offset table — Layout A".
   */
  lineLengths?: Record<string, number[]>;
}

export interface FunctionEntry {
  name: string;
  pathIndex: number;
  line: number;
  col: number;
  params?: string[];
}

export interface SiteEntry {
  kind: "step" | "call" | "return" | "write";
  pathIndex: number;
  line: number;
  col: number;
  fnId?: number;
  /**
   * M16a: write-site metadata.
   *
   * For sites with `kind === "write"`, these fields describe the assignment
   * the runtime should serialise into a `BindVariable + Assignment` pair
   * (see `codetracer-specs/Trace-Files/Trace-Event-Types.md`).  The fields
   * are populated by the SWC visitor when it recognises a simple
   * assignment shape:
   *
   *   * `target`         — the LHS identifier the runtime should bind.
   *   * `rvalueKind`     — one of `"Literal" | "Simple" | "FieldAccess" |
   *                        "IndexAccess" | "FunctionReturn" | "Compound"`
   *                        matching the `RValue` variants defined in
   *                        `codetracer_trace_types`.
   *   * `rvalueSource`   — the source-identifier name for `Simple`,
   *                        `FieldAccess`, and `IndexAccess` shapes; the
   *                        runtime resolves it back to a `VariableId`.
   *   * `rvalueField`    — the field name for `FieldAccess`.
   *   * `rvalueIndex`    — the static integer index for `IndexAccess`.
   *
   * For non-write sites these fields are omitted to keep the JSON
   * manifest byte-for-byte compatible with pre-M16a recorders that
   * don't know about write-site metadata.
   */
  target?: string;
  rvalueKind?:
    | "Literal"
    | "Simple"
    | "FieldAccess"
    | "IndexAccess"
    | "FunctionReturn"
    | "Compound";
  rvalueSource?: string;
  rvalueField?: string;
  rvalueIndex?: number;
}

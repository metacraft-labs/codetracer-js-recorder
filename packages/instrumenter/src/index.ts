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
  /**
   * M37: capture the visible local bindings on every step.
   *
   * When enabled (the default) each `__ct.step` call carries an array of
   * the locals in scope at that point, so the trace records the full
   * frame state per step the way the Ruby and Python recorders do.
   * Disabling it restores the pre-M37 shape, where a binding's value is
   * only recorded on the step that writes it — useful for measuring the
   * size/throughput cost, and as an escape hatch if a program's locals
   * are pathologically expensive to encode.
   *
   * Defaults to `true`, overridable per-process with
   * `CODETRACER_JS_STEP_LOCALS=0`.
   */
  stepLocals?: boolean;
  /**
   * M37: upper bound on how many locals a single step may capture.
   *
   * Encoding is deep (objects, arrays, Maps — see `encodeValue`), so a
   * frame with a very large number of live bindings would pay for all of
   * them on every step.  The first `maxStepLocals` names in scope order
   * (parameters first, then declaration order) are captured and the rest
   * are dropped for that step; they still appear via their M16a write
   * events, so no binding becomes invisible, it merely stops being
   * point-in-time.
   *
   * Defaults to {@link DEFAULT_MAX_STEP_LOCALS}, overridable with
   * `CODETRACER_JS_MAX_STEP_LOCALS`.
   */
  maxStepLocals?: number;
}

/**
 * Default cap on locals captured per step.
 *
 * Chosen well above the size of a hand-written function frame (a few
 * dozen bindings at most) so it never truncates ordinary code, while
 * still bounding the worst case for machine-generated sources.
 */
export const DEFAULT_MAX_STEP_LOCALS = 64;

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
  /**
   * M37: per-step visible-locals capture list.
   *
   * For sites with `kind === "step"`, the ordered names of the local
   * bindings the instrumented `__ct.step(siteId, [...])` call passes as
   * its second argument.  The native addon zips this list against the
   * runtime-encoded values and emits one `Value` event per name, so the
   * trace answers "what is in scope here, and what does it hold" at any
   * step — the question the State panel asks, which the M16a
   * write-site events alone could not answer because they only land on
   * the step where a binding is written.
   *
   * Computed statically by `scopes.ts`; see that module for the scoping
   * rules and for what is deliberately excluded.  Omitted when empty so
   * manifests stay compatible with readers that predate M37.
   */
  vars?: string[];
}

import type { FunctionEntry, SiteEntry, ManifestSlice } from "./index.js";

/**
 * Builds a manifest slice for a single file being instrumented.
 * Tracks function entries and site entries, assigning sequential IDs.
 */
export class ManifestBuilder {
  private paths: string[] = [];
  private functions: FunctionEntry[] = [];
  private sites: SiteEntry[] = [];
  private pathIndexMap = new Map<string, number>();
  private _sourcesContent = new Map<string, string>();
  /**
   * P2.3: per-source line-length tables keyed by source path.  Each
   * value is an array of byte-lengths (excluding the trailing newline)
   * for every line in the source.  The native addon forwards this
   * through `register_path_with_line_lengths` so the CTFS writer's
   * `paths.dat` carries the Layout A line-length record the column-
   * aware reader needs.  See
   * `codetracer-trace-format-spec/trace-events.md` §"paths.dat
   * per-line offset table — Layout A".
   */
  private _lineLengths = new Map<string, number[]>();

  /**
   * Register a file path and return its index.
   */
  addPath(filePath: string): number {
    const existing = this.pathIndexMap.get(filePath);
    if (existing !== undefined) return existing;
    const idx = this.paths.length;
    this.paths.push(filePath);
    this.pathIndexMap.set(filePath, idx);
    return idx;
  }

  /**
   * Store original source content for a path (from source map sourcesContent).
   */
  setSourceContent(filePath: string, content: string): void {
    this._sourcesContent.set(filePath, content);
  }

  /**
   * P2.3: store the per-line byte-length table for a path.  Lengths
   * exclude the trailing newline; an entry of `N` means "line `i+1` is
   * `N` bytes long".  See `computeLineLengths` in `instrument.ts` for
   * the canonical computation from a source string.
   */
  setLineLengths(filePath: string, lengths: number[]): void {
    this._lineLengths.set(filePath, lengths);
  }

  /**
   * Register a function and return its fnId (index in the functions array).
   */
  addFunction(
    name: string,
    pathIndex: number,
    line: number,
    col: number,
    params?: string[],
  ): number {
    const fnId = this.functions.length;
    const entry: FunctionEntry = { name, pathIndex, line, col };
    if (params && params.length > 0) {
      entry.params = params;
    }
    this.functions.push(entry);
    return fnId;
  }

  /**
   * Register a step site and return its siteId (index in the sites array).
   *
   * M37: `vars` names the local bindings the instrumented `__ct.step`
   * call passes alongside the site id, in the same order.  The native
   * addon zips the two to emit one `Value` event per visible local on
   * every step, which is what makes the trace point-in-time queryable
   * (see `scopes.ts`).  It is omitted when the step captures nothing, so
   * manifests for programs with no locals stay byte-for-byte identical
   * to pre-M37 output.
   */
  addStepSite(
    pathIndex: number,
    line: number,
    col: number,
    vars?: string[],
  ): number {
    const siteId = this.sites.length;
    const entry: SiteEntry = { kind: "step", pathIndex, line, col };
    if (vars && vars.length > 0) {
      entry.vars = [...vars];
    }
    this.sites.push(entry);
    return siteId;
  }

  /**
   * Register a call (function enter) site and return its siteId.
   */
  addCallSite(
    fnId: number,
    pathIndex: number,
    line: number,
    col: number,
  ): number {
    const siteId = this.sites.length;
    this.sites.push({ kind: "call", fnId, pathIndex, line, col });
    return siteId;
  }

  /**
   * Register a return site and return its siteId.
   */
  addReturnSite(
    fnId: number,
    pathIndex: number,
    line: number,
    col: number,
  ): number {
    const siteId = this.sites.length;
    this.sites.push({ kind: "return", fnId, pathIndex, line, col });
    return siteId;
  }

  /**
   * M16a: register a write site and return its siteId.
   *
   * Write sites are the source-side description of a simple-assignment
   * shape the visitor recognised.  Each write site carries a target
   * identifier name (LHS) plus an `RValue` description (RHS) so the
   * runtime can synthesise the `BindVariable + Assignment` pair the
   * trace-format vocabulary expects.  See
   * `codetracer-specs/Trace-Files/Trace-Event-Types.md` §RValue for the
   * shape set.
   */
  addWriteSite(
    pathIndex: number,
    line: number,
    col: number,
    target: string,
    rvalueKind:
      | "Literal"
      | "Simple"
      | "FieldAccess"
      | "IndexAccess"
      | "FunctionReturn"
      | "Compound",
    rvalueExtras?: {
      source?: string;
      field?: string;
      index?: number;
    },
  ): number {
    const siteId = this.sites.length;
    const entry: SiteEntry = {
      kind: "write",
      pathIndex,
      line,
      col,
      target,
      rvalueKind,
    };
    if (rvalueExtras) {
      if (rvalueExtras.source !== undefined) {
        entry.rvalueSource = rvalueExtras.source;
      }
      if (rvalueExtras.field !== undefined) {
        entry.rvalueField = rvalueExtras.field;
      }
      if (rvalueExtras.index !== undefined) {
        entry.rvalueIndex = rvalueExtras.index;
      }
    }
    this.sites.push(entry);
    return siteId;
  }

  /**
   * Build the final manifest slice.
   */
  build(): ManifestSlice {
    const result: ManifestSlice = {
      paths: [...this.paths],
      functions: [...this.functions],
      sites: [...this.sites],
    };

    if (this._sourcesContent.size > 0) {
      const sourcesContent: Record<string, string> = {};
      for (const [k, v] of this._sourcesContent) {
        sourcesContent[k] = v;
      }
      result.sourcesContent = sourcesContent;
    }

    if (this._lineLengths.size > 0) {
      const lineLengths: Record<string, number[]> = {};
      for (const [k, v] of this._lineLengths) {
        // Copy the array so callers can't mutate our state through the
        // returned manifest slice.
        lineLengths[k] = v.slice();
      }
      result.lineLengths = lineLengths;
    }

    return result;
  }
}

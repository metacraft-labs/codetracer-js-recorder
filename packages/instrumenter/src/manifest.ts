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
   * Register a function and return its fnId (index in the functions array).
   */
  addFunction(
    name: string,
    pathIndex: number,
    line: number,
    col: number,
  ): number {
    const fnId = this.functions.length;
    this.functions.push({ name, pathIndex, line, col });
    return fnId;
  }

  /**
   * Register a step site and return its siteId (index in the sites array).
   */
  addStepSite(pathIndex: number, line: number, col: number): number {
    const siteId = this.sites.length;
    this.sites.push({ kind: "step", pathIndex, line, col });
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

    return result;
  }
}

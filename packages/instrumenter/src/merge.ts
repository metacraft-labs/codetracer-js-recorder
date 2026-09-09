/**
 * The single implementation of "fold per-file {@link ManifestSlice}s into
 * one manifest".
 *
 * # Why the id numbering is a contract, not a detail
 *
 * The runtime reports execution as flat integers — `__ct.step(siteId)`,
 * `__ct.enter(fnId)` — and the recorder resolves each one by indexing
 * straight into the merged manifest's `sites` / `functions` arrays.
 * Those integers are **numeric literals baked into the instrumented
 * source**, so the merge cannot renumber them: by the time slices are
 * merged, the code that reports them has already been written to disk
 * (or handed back to a bundler).
 *
 * The consequence is that each slice must be *instrumented* knowing
 * where it will land — that is what {@link ManifestIdBases} carries and
 * what {@link nextManifestIdBases} computes. This function's job is then
 * to place each slice at exactly the base it was minted with, and to
 * fail loudly if it cannot.
 *
 * Historically that contract was violated: slices were always minted
 * from zero and the merge tried to repair it by offsetting `fnId`
 * references *inside* the manifest. That fixes the manifest's internal
 * consistency and nothing else — the emitted `__ct.step(k)` in the
 * second file still resolved against the FIRST file's site `k`, so every
 * step and call recorded outside the first instrumented file was
 * attributed to some unrelated line of that first file. It produced no
 * error, just a trace that pointed at the wrong source. The invariant
 * is pinned by `tests/transform/manifest-id-spaces.test.ts`.
 *
 * Cross-references:
 *   * `codetracer-specs/Planned-Features/Value-Origin-Tracking.milestones.org` M26.
 *   * `codetracer/src/backend-manager/src/browser_stream_host.rs`
 *     (`InstrumentationManifest`) — the consuming decoder.
 */

import type {
  FunctionEntry,
  ManifestIdBases,
  ManifestSlice,
  SiteEntry,
} from "./index.js";

/**
 * A merged manifest: the JSON document shipped to the recorder (the
 * `codetracer.manifest.json` the CLI writes, or the `Manifest` browser
 * event the bundler plugins send).
 *
 * Field names are the wire contract with
 * `browser_stream_host.rs::InstrumentationManifest`; they are
 * `camelCase` on both sides.
 */
export interface MergedManifest {
  paths: string[];
  functions: FunctionEntry[];
  sites: SiteEntry[];
  sourcesContent?: Record<string, string>;
  lineLengths?: Record<string, number[]>;
}

/**
 * The {@link ManifestIdBases} the NEXT slice must be instrumented with,
 * given the slices already collected (in merge order).
 *
 * Callers instrument in a loop and merge afterwards, so this is the
 * running total of everything accumulated so far:
 *
 * ```ts
 * for (const file of files) {
 *   const result = instrument(read(file), {
 *     filename: file,
 *     idBases: nextManifestIdBases(slices),
 *   });
 *   slices.push(result.manifestSlice);
 * }
 * const manifest = mergeManifestSlices(slices);
 * ```
 */
export function nextManifestIdBases(
  slices: readonly ManifestSlice[],
): ManifestIdBases {
  let functionIdBase = 0;
  let siteIdBase = 0;
  for (const slice of slices) {
    functionIdBase += slice.functions.length;
    siteIdBase += slice.sites.length;
  }
  return { functionIdBase, siteIdBase };
}

/**
 * Thrown when a slice cannot be placed at the base it was instrumented
 * with. The ids are already in the emitted code, so there is no
 * recovery: merging anyway would silently mis-attribute every step in
 * that file.
 */
export class ManifestIdBaseMismatchError extends Error {
  constructor(
    readonly kind: "function" | "site",
    readonly expected: number,
    readonly actual: number,
    readonly sliceIndex: number,
  ) {
    super(
      `manifest slice #${sliceIndex} was instrumented with ${kind}IdBase=${actual} ` +
        `but is being merged at index ${expected}. The ids are baked into the ` +
        `instrumented source, so merging would attribute this file's steps to ` +
        `another file. Instrument slices with nextManifestIdBases() in the same ` +
        `order they are merged.`,
    );
    this.name = "ManifestIdBaseMismatchError";
  }
}

/**
 * Fold slices into a single manifest.
 *
 * Merge rules:
 *   * `paths` are de-duplicated by string; first sight wins the index,
 *     and each slice's `pathIndex` references are re-mapped onto it.
 *     (Path indices are manifest-internal — the runtime never reports
 *     one — so unlike site/function ids they CAN be renumbered here.)
 *   * `functions` and `sites` are concatenated in slice order and must
 *     land exactly at the bases they were minted with; `fnId` references
 *     are already global and are carried through untouched.
 *   * `sourcesContent` / `lineLengths` merge by key, first write wins
 *     (re-instrumenting a file yields identical content, so the choice
 *     is immaterial).
 *
 * @throws ManifestIdBaseMismatchError if a slice's declared base does
 *   not match where it lands.
 */
export function mergeManifestSlices(
  slices: readonly ManifestSlice[],
): MergedManifest {
  const paths: string[] = [];
  const functions: FunctionEntry[] = [];
  const sites: SiteEntry[] = [];
  const sourcesContent: Record<string, string> = {};
  const lineLengths: Record<string, number[]> = {};
  const globalPathIndex = new Map<string, number>();

  let sliceIndex = 0;
  for (const slice of slices) {
    // A slice from a pre-`idBases` build reports no base; treating it as
    // 0 keeps the single-slice case working and makes a multi-slice one
    // fail here rather than silently mis-attribute.
    const functionIdBase = slice.functionIdBase ?? 0;
    const siteIdBase = slice.siteIdBase ?? 0;
    if (functionIdBase !== functions.length) {
      throw new ManifestIdBaseMismatchError(
        "function",
        functions.length,
        functionIdBase,
        sliceIndex,
      );
    }
    if (siteIdBase !== sites.length) {
      throw new ManifestIdBaseMismatchError(
        "site",
        sites.length,
        siteIdBase,
        sliceIndex,
      );
    }

    // Map this slice's local path indices onto the global table.
    const localToGlobal: number[] = [];
    for (const p of slice.paths) {
      let idx = globalPathIndex.get(p);
      if (idx === undefined) {
        idx = paths.length;
        paths.push(p);
        globalPathIndex.set(p, idx);
      }
      localToGlobal.push(idx);
    }

    for (const fn of slice.functions) {
      functions.push({ ...fn, pathIndex: localToGlobal[fn.pathIndex] ?? 0 });
    }
    for (const site of slice.sites) {
      // `fnId` is deliberately NOT offset: the builder already minted it
      // in the merged numbering, and it is the same integer the emitted
      // `__ct.enter` / `__ct.ret` calls report.
      sites.push({ ...site, pathIndex: localToGlobal[site.pathIndex] ?? 0 });
    }

    if (slice.sourcesContent) {
      for (const [key, value] of Object.entries(slice.sourcesContent)) {
        if (!(key in sourcesContent)) sourcesContent[key] = value;
      }
    }
    if (slice.lineLengths) {
      for (const [key, value] of Object.entries(slice.lineLengths)) {
        if (!(key in lineLengths)) lineLengths[key] = value.slice();
      }
    }
    sliceIndex += 1;
  }

  const merged: MergedManifest = { paths, functions, sites };
  if (Object.keys(sourcesContent).length > 0) {
    merged.sourcesContent = sourcesContent;
  }
  if (Object.keys(lineLengths).length > 0) {
    merged.lineLengths = lineLengths;
  }
  return merged;
}

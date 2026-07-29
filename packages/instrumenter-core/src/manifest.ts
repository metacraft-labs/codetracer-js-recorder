/**
 * Shared manifest merging for consumers that instrument many modules and
 * must ship **one** manifest describing all of them.
 *
 * The SWC visitor emits a `ManifestSlice` per file, with `pathIndex` and
 * `fnId` numbering local to that file. Any consumer that aggregates
 * slices — the CLI's `instrument` / `record` commands, the bundler
 * plugins — has to re-index those local numbers into a single global
 * namespace before the runtime can use them. This module is the one
 * implementation of that re-indexing.
 *
 * Why it matters that this is shared: the runtime reports execution as
 * flat `siteId` / `fnId` integers, and the receiving daemon resolves
 * them back to `(path, line)` purely by indexing into the manifest's
 * `sites` / `functions` arrays. If two consumers merged slices with
 * even slightly different ordering, identical page code would produce
 * traces whose steps point at the wrong source lines. Keeping exactly
 * one merge implementation is what makes the numbering a contract
 * rather than a coincidence.
 *
 * Cross-references:
 *   * `codetracer-specs/Planned-Features/Value-Origin-Tracking.milestones.org` M26.
 *   * `codetracer/src/backend-manager/src/browser_stream_host.rs`
 *     (`InstrumentationManifest`) — the consuming decoder.
 */

import type {
  ManifestSlice,
  FunctionEntry,
  SiteEntry,
} from "@codetracer/instrumenter";

/**
 * A merged manifest: the JSON document the runtime ships to the
 * recording daemon as the `Manifest` browser event.
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
 * Incremental accumulator over per-file `ManifestSlice`s.
 *
 * Bundler plugins discover modules one `transform()` call at a time and
 * cannot know the full module graph up front, so the merge has to be
 * incremental rather than a one-shot fold over a complete array.
 *
 * Re-adding a slice for a file that was already accumulated (the HMR
 * case: Vite re-runs `transform` on every edit) **replaces** that
 * file's contribution instead of appending a duplicate. Without that,
 * a long dev session would grow the manifest without bound and every
 * re-instrumented module would shift the global site numbering out from
 * under the ids the already-loaded page is still reporting.
 */
export class ManifestAccumulator {
  /** Per-source-file slices, keyed by the module id passed to `add`. */
  private readonly slices = new Map<string, ManifestSlice>();

  /**
   * Record (or replace) the slice produced for `moduleId`.
   *
   * @param moduleId Stable identity for the module — the bundler's
   *   resolved id. Only used for de-duplication; it never reaches the
   *   merged output.
   */
  add(moduleId: string, slice: ManifestSlice): void {
    this.slices.set(moduleId, slice);
  }

  /** Number of distinct modules accumulated so far. */
  get size(): number {
    return this.slices.size;
  }

  /** Drop every accumulated slice. */
  clear(): void {
    this.slices.clear();
  }

  /**
   * Fold every accumulated slice into a single manifest.
   *
   * Merge rules (identical to the CLI's):
   *   * `paths` are de-duplicated by string; first sight wins the index.
   *   * `functions` are concatenated in module order; each slice's
   *     `fnId` references are offset by the running function count.
   *   * `sites` are concatenated, with `pathIndex` re-mapped and `fnId`
   *     offset to match.
   *   * `sourcesContent` / `lineLengths` merge by key, first write wins
   *     (re-instrumenting a file yields identical content, so the
   *     choice is immaterial).
   *
   * Iteration order is `Map` insertion order, which is the order the
   * bundler first transformed each module — deterministic for a given
   * module graph and entry point.
   */
  merge(): MergedManifest {
    const paths: string[] = [];
    const functions: FunctionEntry[] = [];
    const sites: SiteEntry[] = [];
    const sourcesContent: Record<string, string> = {};
    const lineLengths: Record<string, number[]> = {};
    const globalPathIndex = new Map<string, number>();

    for (const slice of this.slices.values()) {
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

      // `fnId`s in this slice's sites are local; shift them past the
      // functions already merged from earlier slices.
      const fnIdOffset = functions.length;
      for (const fn of slice.functions) {
        functions.push({ ...fn, pathIndex: localToGlobal[fn.pathIndex] ?? 0 });
      }
      for (const site of slice.sites) {
        const reindexed: SiteEntry = {
          ...site,
          pathIndex: localToGlobal[site.pathIndex] ?? 0,
        };
        if (reindexed.fnId !== undefined) {
          reindexed.fnId = reindexed.fnId + fnIdOffset;
        }
        sites.push(reindexed);
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
}

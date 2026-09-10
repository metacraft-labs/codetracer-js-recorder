/**
 * Incremental manifest accumulation for consumers that instrument many
 * modules and must ship **one** manifest describing all of them.
 *
 * The fold itself lives in `@codetracer/instrumenter`
 * (`mergeManifestSlices`) — this module only adds the incremental
 * bookkeeping bundler plugins need, because they discover modules one
 * `transform()` call at a time and cannot fold a complete array up
 * front.
 *
 * Why the merge is shared rather than re-implemented here: the runtime
 * reports execution as flat `siteId` / `fnId` integers baked into the
 * instrumented source, and the receiving daemon resolves them back to
 * `(path, line)` purely by indexing into the manifest's `sites` /
 * `functions` arrays. If two consumers numbered slices differently,
 * identical page code would produce traces whose steps point at the
 * wrong source lines. One implementation is what makes the numbering a
 * contract rather than a coincidence.
 *
 * Cross-references:
 *   * `codetracer-specs/Planned-Features/Value-Origin-Tracking.milestones.org` M26.
 *   * `codetracer/src/backend-manager/src/browser_stream_host.rs`
 *     (`InstrumentationManifest`) — the consuming decoder.
 */

import {
  mergeManifestSlices,
  nextManifestIdBases,
} from "@codetracer/instrumenter";
import type {
  ManifestIdBases,
  ManifestSlice,
  MergedManifest,
} from "@codetracer/instrumenter";

export type { MergedManifest };

/**
 * Incremental accumulator over per-file `ManifestSlice`s.
 *
 * Usage is a two-step per module, and the order matters: ask for the id
 * bases FIRST, instrument with them, then hand the slice back.
 *
 * ```ts
 * const result = instrument(code, {
 *   filename: path,
 *   idBases: manifest.idBasesFor(path),
 * });
 * manifest.add(path, result.manifestSlice);
 * ```
 *
 * Re-adding a slice for a file that was already accumulated (the HMR
 * case: Vite re-runs `transform` on every edit) **replaces** that file's
 * contribution instead of appending a duplicate, and
 * {@link ManifestAccumulator.idBasesFor} hands back the same block the
 * module already owns so its neighbours' numbering does not move —
 * unless the re-instrumented module changed size, which shifts every
 * later module and is reported by {@link ManifestAccumulator.merge}
 * rather than absorbed silently.
 */
export class ManifestAccumulator {
  /** Per-source-file slices, keyed by the module id passed to `add`. */
  private readonly slices = new Map<string, ManifestSlice>();

  /**
   * The {@link ManifestIdBases} `moduleId` must be instrumented with.
   *
   * For a module not yet seen this is the running total of everything
   * accumulated so far — it will be appended. For a module being
   * re-instrumented it is the base of the block it already occupies, so
   * the ids the already-loaded page is still reporting keep resolving.
   */
  idBasesFor(moduleId: string): ManifestIdBases {
    const preceding: ManifestSlice[] = [];
    for (const [id, slice] of this.slices) {
      if (id === moduleId) break;
      preceding.push(slice);
    }
    return nextManifestIdBases(preceding);
  }

  /**
   * Record (or replace) the slice produced for `moduleId`.
   *
   * @param moduleId Stable identity for the module — the bundler's
   *   resolved id. Only used for de-duplication and for
   *   {@link idBasesFor}; it never reaches the merged output.
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
   * Iteration order is `Map` insertion order, which is the order the
   * bundler first transformed each module — deterministic for a given
   * module graph and entry point, and the same order
   * {@link idBasesFor} assumed.
   *
   * @throws ManifestIdBaseMismatchError if a module was re-instrumented
   *   into a differently-sized slice, which moves every later module's
   *   block out from under the ids already baked into its code. The
   *   caller's remedy is to re-instrument the whole graph
   *   ({@link clear} + reload), never to merge anyway.
   */
  merge(): MergedManifest {
    return mergeManifestSlices([...this.slices.values()]);
  }
}

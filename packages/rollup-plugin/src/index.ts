/**
 * `@codetracer/rollup-plugin` — Rollup plugin that wires the CodeTracer
 * SWC instrumenter into the Rollup transform pipeline.
 *
 * Rollup plugin shape is `{ name, buildStart, shouldTransformCachedModule,
 * transform(code, id), generateBundle }`.  We implement it as a structural type so the package
 * builds without a `rollup` dependency in the dev shell.
 *
 * `transform` returns the instrumented code with its source map, which
 * Rollup chains into the bundle's map (`output.sourcemap`). The plugin
 * also owns the build's **manifest**: each module is instrumented with the
 * id bases of the block it will occupy in the merged manifest (the ids are
 * baked into its code), and `generateBundle` emits the merged manifest as
 * the asset `codetracer.manifest.json`.  Instrumenting each module from
 * zero (what this plugin did before) attributed every step outside the
 * first module to a line of the first one, and with no manifest emitted
 * nothing could resolve the ids at all.
 */

import {
  instrument,
  shouldInstrument,
  ManifestAccumulator,
  MANIFEST_FILE_NAME,
  manifestFileContents,
} from "@codetracer/instrumenter-core";
import type {
  FilterOptions,
  MergedManifest,
} from "@codetracer/instrumenter-core";

export interface CodetracerRollupOptions {
  endpoint?: string;
  include?: string[];
  exclude?: string[];
  /** File name of the emitted manifest asset. Defaults to `codetracer.manifest.json`. */
  manifestFileName?: string;
}

/** The slice of Rollup's plugin context `generateBundle` uses. */
export interface RollupEmitContext {
  emitFile(file: { type: "asset"; fileName: string; source: string }): string;
}

export interface CodetracerRollupPlugin {
  name: string;
  buildStart(): void;
  shouldTransformCachedModule(): boolean;
  transform(code: string, id: string): { code: string; map?: string } | null;
  generateBundle(this: RollupEmitContext): void;
  /** The manifest merged from every module instrumented so far. */
  mergedManifest(): MergedManifest;
}

export function codetracerRollupPlugin(
  options: CodetracerRollupOptions = {},
): CodetracerRollupPlugin {
  const filter: FilterOptions = {
    include: options.include,
    exclude: options.exclude,
  };
  const manifestFileName = options.manifestFileName ?? MANIFEST_FILE_NAME;
  const manifest = new ManifestAccumulator();
  return {
    name: "codetracer:instrument",
    buildStart() {
      // Every build numbers its modules from an empty manifest; see
      // `shouldTransformCachedModule` for why every module is transformed
      // again.
      manifest.clear();
    },
    shouldTransformCachedModule() {
      // A rebuild from Rollup's cache (watch mode, or the `cache` option)
      // skips `transform` for every module whose source is unchanged, so
      // the manifest cleared above would lose those modules while their
      // code still carries the ids of the previous build. Transforming
      // every module again rebuilds the manifest whole.
      // https://rollupjs.org/plugin-development/#shouldtransformcachedmodule
      return true;
    },
    transform(code: string, id: string) {
      const path = id.split("?")[0];
      if (!shouldInstrument(path, filter)) return null;
      try {
        const result = instrument(code, {
          filename: path,
          idBases: manifest.idBasesFor(path),
        });
        manifest.add(path, result.manifestSlice);
        return { code: result.code, map: result.map };
      } catch {
        return null;
      }
    },
    generateBundle() {
      if (manifest.size === 0) return;
      this.emitFile({
        type: "asset",
        fileName: manifestFileName,
        source: manifestFileContents(manifest.merge()),
      });
    },
    mergedManifest() {
      return manifest.merge();
    },
  };
}

export default codetracerRollupPlugin;

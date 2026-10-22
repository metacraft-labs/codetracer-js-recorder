/**
 * `@codetracer/webpack-plugin` — Webpack loader + plugin pair that wires
 * the CodeTracer instrumenter into the Webpack transform pipeline.
 *
 * Webpack's transform API is two-layered: a *loader* runs on each
 * matched module, and the *plugin* gives the loader access to the
 * Webpack compilation lifecycle.  Here we provide:
 *
 *   * `CodetracerWebpackPlugin` — the plugin.  `apply(compiler)` adds a
 *     `pre` rule that runs this package's loader (`dist/loader.js`) on
 *     JavaScript / TypeScript modules, hands every loader call the plugin
 *     instance, and emits the merged manifest as the asset
 *     `codetracer.manifest.json` when the compilation's assets are
 *     processed.
 *   * `codetracerWebpackLoader` — the transform the loader runs:
 *     `(source, filename, options, manifest) -> { code, map }`.  With a
 *     manifest accumulator it instruments the module with the id bases of
 *     the block it will occupy in the merged manifest (the ids are baked
 *     into its code) and records its slice; the map is handed to Webpack,
 *     which chains it into the bundle's map (`devtool: "source-map"`).
 *
 * Before, the loader instrumented each module from zero and no manifest
 * was emitted: every step outside the first module was attributed to a
 * line of the first one, and nothing could resolve the ids at all.
 *
 * Both wrap the same `@codetracer/instrumenter-core` visitor used by
 * the Vite plugin so behaviour is byte-for-byte identical.  The compiler
 * surface is duck-typed so the package builds without `webpack`.
 */

import * as path from "node:path";
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

export interface CodetracerWebpackOptions {
  /** WebSocket endpoint injected via `window.__codetracer_endpoint`. */
  endpoint?: string;
  /** Include globs (default: all JS/TS files). */
  include?: string[];
  /** Exclude globs (default: `node_modules/**`). */
  exclude?: string[];
  /** File name of the emitted manifest asset. Defaults to `codetracer.manifest.json`. */
  manifestFileName?: string;
}

export interface WebpackLoaderResult {
  code: string;
  map?: string;
}

/** Property of a loader context through which the loader finds its plugin. */
export const PLUGIN_KEY = "__codetracerWebpackPlugin";

/** Absolute path of the loader module the plugin's rule runs. */
export const LOADER_PATH = path.join(__dirname, "loader.js");

/** Modules the plugin's rule sends to the loader. */
const MODULE_TEST = /\.(?:tsx?|m?jsx?)$/;

/**
 * Apply the instrumenter to a single Webpack module.  Returns `null`
 * when the file is filtered out — Webpack convention is that returning
 * the original source unchanged also works, but `null` lets the host
 * decide whether to short-circuit.
 *
 * Pass `manifest` whenever more than one module is instrumented into one
 * build: the module is then numbered after everything already in it and
 * its slice recorded.  Without it the module is numbered from zero, which
 * is right only when it is the whole program.
 */
export function codetracerWebpackLoader(
  source: string,
  filename: string,
  options: CodetracerWebpackOptions = {},
  manifest?: ManifestAccumulator,
  inputSourceMap?: string | object,
): WebpackLoaderResult | null {
  const filter: FilterOptions = {
    include: options.include,
    exclude: options.exclude,
  };
  if (!shouldInstrument(filename, filter)) return null;
  try {
    const result = instrument(source, {
      filename,
      ...(manifest ? { idBases: manifest.idBasesFor(filename) } : {}),
      ...(inputSourceMap ? { inputSourceMap } : {}),
    });
    manifest?.add(filename, result.manifestSlice);
    return { code: result.code, map: result.map };
  } catch {
    return null;
  }
}

/** The slice of Webpack's compiler the plugin touches. */
interface CompilerLike {
  options: { module: { rules: unknown[] } };
  webpack: {
    NormalModule: {
      getCompilationHooks(compilation: unknown): {
        loader: {
          tap(
            name: string,
            fn: (context: Record<string, unknown>) => void,
          ): void;
        };
      };
    };
    Compilation: { PROCESS_ASSETS_STAGE_ADDITIONAL: number };
    sources: { RawSource: new (source: string) => unknown };
  };
  hooks: {
    thisCompilation: {
      tap(name: string, fn: (compilation: CompilationLike) => void): void;
    };
  };
}

interface CompilationLike {
  hooks: {
    processAssets: {
      tap(options: { name: string; stage: number }, fn: () => void): void;
    };
  };
  emitAsset(file: string, source: unknown): void;
}

const PLUGIN_NAME = "CodetracerWebpackPlugin";

/** Webpack `Plugin`-shaped class: instruments modules and emits the manifest. */
export class CodetracerWebpackPlugin {
  /** The manifest of the current compilation. */
  readonly manifest = new ManifestAccumulator();

  constructor(public options: CodetracerWebpackOptions = {}) {}

  /** The manifest merged from every module instrumented so far. */
  mergedManifest(): MergedManifest {
    return this.manifest.merge();
  }

  /**
   * Webpack calls `apply(compiler)` once at construction.  The compiler
   * interface is duck-typed (Webpack accepts any object with `apply`), so
   * the package builds without pulling Webpack's types into the shell.
   */
  apply(compiler: unknown): void {
    const c = compiler as CompilerLike;
    if (!c?.options?.module?.rules || !c.webpack || !c.hooks?.thisCompilation) {
      throw new Error(
        `${PLUGIN_NAME} needs webpack 5 (compiler.webpack and compiler.hooks.thisCompilation)`,
      );
    }
    c.options.module.rules.push({
      test: MODULE_TEST,
      // Before other loaders (a TypeScript loader, Babel): the
      // instrumenter maps positions in the source the author wrote.
      enforce: "pre",
      use: [{ loader: LOADER_PATH }],
    });
    const manifestFileName =
      this.options.manifestFileName ?? MANIFEST_FILE_NAME;
    const { NormalModule, Compilation, sources } = c.webpack;
    c.hooks.thisCompilation.tap(PLUGIN_NAME, (compilation) => {
      // A watch rebuild is a new compilation, and its manifest starts
      // empty; the loader marks every module not cacheable, so the
      // compilation loads (and numbers) every module it keeps again.
      this.manifest.clear();
      NormalModule.getCompilationHooks(compilation).loader.tap(
        PLUGIN_NAME,
        (loaderContext) => {
          loaderContext[PLUGIN_KEY] = this;
        },
      );
      compilation.hooks.processAssets.tap(
        {
          name: PLUGIN_NAME,
          stage: Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL,
        },
        () => {
          if (this.manifest.size === 0) return;
          compilation.emitAsset(
            manifestFileName,
            new sources.RawSource(manifestFileContents(this.manifest.merge())),
          );
        },
      );
    });
  }
}

export default CodetracerWebpackPlugin;

/**
 * `@codetracer/esbuild-plugin` — esbuild plugin that wires the
 * CodeTracer SWC instrumenter into the esbuild transform pipeline.
 *
 * esbuild's plugin shape is `{ name, setup(build) }`.  Inside `setup`
 * we register an `onLoad` callback that reads each matching module from
 * disk, hands it to the instrumenter, and returns the rewritten source
 * with its source map inline, so esbuild chains it into the map it emits
 * (`sourcemap: true`) and positions in the bundle map back to the
 * original module.  The plugin is duck-typed so the package builds
 * without `esbuild` installed in the dev shell.  (esbuild refuses a plugin
 * object with any key besides `name` and `setup`, so the manifest is
 * reachable only as the file it writes.)
 *
 * It also owns the build's **manifest**, the table the runtime's
 * `siteId` / `fnId` integers are resolved through.  Those ids are baked
 * into each module's code, so every module is instrumented with the id
 * bases of the block it will occupy in the merged manifest
 * (`ManifestAccumulator.idBasesFor`), and at the end of the build the
 * merged manifest is written beside the output as
 * `codetracer.manifest.json`.  Instrumenting each module from zero (what
 * this plugin did before) attributed every step outside the first module
 * to a line of the first one, and with no manifest emitted nothing could
 * resolve the ids at all.
 */

import { promises as fs, writeFileSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import {
  instrument,
  shouldInstrument,
  ManifestAccumulator,
  MANIFEST_FILE_NAME,
  manifestFileContents,
} from "@codetracer/instrumenter-core";
import type { FilterOptions } from "@codetracer/instrumenter-core";

export interface CodetracerEsbuildOptions {
  endpoint?: string;
  include?: string[];
  exclude?: string[];
  /**
   * File name of the manifest written into the build's output directory
   * (`outdir`, or the directory of `outfile`). Defaults to
   * `codetracer.manifest.json`.
   */
  manifestFileName?: string;
}

/** The slice of esbuild's `OutputFile` the plugin produces when `write: false`. */
export interface EsbuildOutputFileLike {
  path: string;
  contents: Uint8Array;
  readonly text: string;
}

/**
 * Minimal structural type for the esbuild plugin shape so this package
 * builds without an `esbuild` dependency.  `onStart`, `onEnd` and
 * `initialOptions` are optional in the type only so that a host offering
 * just `onLoad` (an older esbuild, or a test double) still works; every
 * esbuild since 0.11 provides them.
 */
export interface CodetracerEsbuildPlugin {
  name: string;
  setup(build: {
    initialOptions?: {
      outdir?: string;
      outfile?: string;
      write?: boolean;
      absWorkingDir?: string;
    };
    onStart?: (cb: () => void) => void;
    onLoad: (
      filter: { filter: RegExp },
      cb: (args: { path: string }) => Promise<{
        contents: string;
        loader: string;
      } | null>,
    ) => void;
    onEnd?: (
      cb: (result: {
        errors: unknown[];
        outputFiles?: EsbuildOutputFileLike[];
      }) => void,
    ) => void;
  }): void;
}

const DEFAULT_FILTER = /\.(?:tsx?|m?jsx?)$/;

/** esbuild's loader for a module path. */
function loaderFor(file: string): string {
  if (file.endsWith(".tsx")) return "tsx";
  if (file.endsWith(".ts")) return "ts";
  if (file.endsWith(".jsx")) return "jsx";
  return "js";
}

/** An inline source-map comment esbuild reads from loaded contents. */
function inlineSourceMap(map: string): string {
  return `//# sourceMappingURL=data:application/json;base64,${Buffer.from(map, "utf-8").toString("base64")}`;
}

/**
 * Build the esbuild plugin object.  Consumers pass the result into the
 * esbuild config's `plugins: [...]` array.
 */
export function codetracerEsbuildPlugin(
  options: CodetracerEsbuildOptions = {},
): CodetracerEsbuildPlugin {
  const filter: FilterOptions = {
    include: options.include,
    exclude: options.exclude,
  };
  const manifestFileName = options.manifestFileName ?? MANIFEST_FILE_NAME;
  const manifest = new ManifestAccumulator();
  return {
    name: "codetracer:instrument",
    setup(build) {
      // A watch or incremental rebuild starts from an empty manifest:
      // every module of the new build is loaded (and numbered) again.
      build.onStart?.(() => manifest.clear());
      build.onLoad({ filter: DEFAULT_FILTER }, async ({ path: file }) => {
        if (!shouldInstrument(file, filter)) return null;
        let source: string;
        try {
          source = await fs.readFile(file, "utf-8");
        } catch {
          return null;
        }
        try {
          // Ask for the id bases and record the slice with no await in
          // between: onLoad callbacks run concurrently, and the block a
          // module is minted in must be the one it is merged at.
          const result = instrument(source, {
            filename: file,
            idBases: manifest.idBasesFor(file),
          });
          manifest.add(file, result.manifestSlice);
          // esbuild's `loader` is inferred from the extension when not
          // specified; we set it explicitly so the rewritten source is
          // parsed as TS / JS exactly as the original.
          const contents = result.map
            ? `${result.code}${inlineSourceMap(result.map)}\n`
            : result.code;
          return { contents, loader: loaderFor(file) };
        } catch {
          return null;
        }
      });
      build.onEnd?.((result) => {
        if (result.errors.length > 0 || manifest.size === 0) return;
        const opts = build.initialOptions ?? {};
        const cwd = opts.absWorkingDir ?? process.cwd();
        const outDir = opts.outdir
          ? path.resolve(cwd, opts.outdir)
          : opts.outfile
            ? path.dirname(path.resolve(cwd, opts.outfile))
            : undefined;
        if (outDir === undefined) return;
        const target = path.join(outDir, manifestFileName);
        const text = manifestFileContents(manifest.merge());
        if (opts.write === false) {
          // Nothing is written to disk in this mode; hand the manifest
          // back with the other output files.
          const contents = new Uint8Array(Buffer.from(text, "utf-8"));
          result.outputFiles?.push({ path: target, contents, text });
          return;
        }
        mkdirSync(outDir, { recursive: true });
        writeFileSync(target, text);
      });
    },
  };
}

export default codetracerEsbuildPlugin;

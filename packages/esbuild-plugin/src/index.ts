/**
 * `@codetracer/esbuild-plugin` — esbuild plugin that wires the
 * CodeTracer SWC instrumenter into the esbuild transform pipeline.
 *
 * esbuild's plugin shape is `{ name, setup(build) }`.  Inside `setup`
 * we register an `onLoad` callback that reads each matching module from
 * disk, hands it to the instrumenter, and returns the rewritten source
 * + sourcemap.  The plugin is duck-typed so the package builds without
 * `esbuild` installed in the dev shell.
 */

import { promises as fs } from "node:fs";
import { instrument, shouldInstrument } from "@codetracer/instrumenter-core";
import type { FilterOptions } from "@codetracer/instrumenter-core";

export interface CodetracerEsbuildOptions {
  endpoint?: string;
  include?: string[];
  exclude?: string[];
}

/**
 * Minimal structural type for the esbuild plugin shape so this package
 * builds without an `esbuild` dependency.
 */
export interface CodetracerEsbuildPlugin {
  name: string;
  setup(build: {
    onLoad: (
      filter: { filter: RegExp },
      cb: (args: { path: string }) => Promise<{
        contents: string;
        loader: string;
      } | null>,
    ) => void;
  }): void;
}

const DEFAULT_FILTER = /\.(?:tsx?|m?jsx?)$/;

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
  return {
    name: "codetracer:instrument",
    setup(build) {
      build.onLoad({ filter: DEFAULT_FILTER }, async ({ path }) => {
        if (!shouldInstrument(path, filter)) return null;
        let source: string;
        try {
          source = await fs.readFile(path, "utf-8");
        } catch {
          return null;
        }
        try {
          const result = instrument(source, { filename: path });
          // esbuild's `loader` is inferred from the extension when not
          // specified; we set it explicitly so the rewritten source is
          // parsed as TS / JS exactly as the original.
          const loader = path.endsWith(".tsx")
            ? "tsx"
            : path.endsWith(".ts")
              ? "ts"
              : path.endsWith(".jsx")
                ? "jsx"
                : "js";
          return { contents: result.code, loader };
        } catch {
          return null;
        }
      });
    },
  };
}

export default codetracerEsbuildPlugin;

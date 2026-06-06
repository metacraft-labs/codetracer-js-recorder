/**
 * `@codetracer/rollup-plugin` — Rollup plugin that wires the CodeTracer
 * SWC instrumenter into the Rollup transform pipeline.
 *
 * Rollup plugin shape is `{ name, transform(code, id) }`.  We implement
 * it as a structural type so the package builds without a `rollup`
 * dependency in the dev shell.
 */

import { instrument, shouldInstrument } from "@codetracer/instrumenter-core";
import type { FilterOptions } from "@codetracer/instrumenter-core";

export interface CodetracerRollupOptions {
  endpoint?: string;
  include?: string[];
  exclude?: string[];
}

export interface CodetracerRollupPlugin {
  name: string;
  transform(code: string, id: string): { code: string; map?: string } | null;
}

export function codetracerRollupPlugin(
  options: CodetracerRollupOptions = {},
): CodetracerRollupPlugin {
  const filter: FilterOptions = {
    include: options.include,
    exclude: options.exclude,
  };
  return {
    name: "codetracer:instrument",
    transform(code: string, id: string) {
      const path = id.split("?")[0];
      if (!shouldInstrument(path, filter)) return null;
      try {
        const result = instrument(code, { filename: path });
        return { code: result.code, map: result.map };
      } catch {
        return null;
      }
    },
  };
}

export default codetracerRollupPlugin;

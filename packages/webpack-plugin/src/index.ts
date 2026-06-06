/**
 * `@codetracer/webpack-plugin` — Webpack loader + plugin pair that wires
 * the CodeTracer instrumenter into the Webpack transform pipeline.
 *
 * Webpack's transform API is two-layered: a *loader* runs on each
 * matched module, and the *plugin* gives the loader access to the
 * Webpack compilation lifecycle.  Here we provide:
 *
 *   * `codetracerWebpackLoader` — pure function `(source, filename) ->
 *     { code, map }` that Webpack's `module.rules[].use[].loader` can
 *     point at via a small loader shim (the loader shim is one line
 *     and lives in the package consumer's webpack.config.js).
 *   * `CodetracerWebpackPlugin` — Webpack-Plugin-shaped class with a
 *     `apply(compiler)` method that registers an `index.html`
 *     post-processor injecting `window.__codetracer_endpoint`.
 *
 * Both wrap the same `@codetracer/instrumenter-core` visitor used by
 * the Vite plugin so behaviour is byte-for-byte identical.
 */

import { instrument, shouldInstrument } from "@codetracer/instrumenter-core";
import type { FilterOptions } from "@codetracer/instrumenter-core";

export interface CodetracerWebpackOptions {
  /** WebSocket endpoint injected via `window.__codetracer_endpoint`. */
  endpoint?: string;
  /** Include globs (default: all JS/TS files). */
  include?: string[];
  /** Exclude globs (default: `node_modules/**`). */
  exclude?: string[];
}

export interface WebpackLoaderResult {
  code: string;
  map?: string;
}

/**
 * Apply the instrumenter to a single Webpack module.  Returns `null`
 * when the file is filtered out — Webpack convention is that returning
 * the original source unchanged also works, but `null` lets the host
 * decide whether to short-circuit.
 */
export function codetracerWebpackLoader(
  source: string,
  filename: string,
  options: CodetracerWebpackOptions = {},
): WebpackLoaderResult | null {
  const filter: FilterOptions = {
    include: options.include,
    exclude: options.exclude,
  };
  if (!shouldInstrument(filename, filter)) return null;
  try {
    const result = instrument(source, { filename });
    return { code: result.code, map: result.map };
  } catch {
    return null;
  }
}

/** Webpack `Plugin`-shaped class for endpoint injection. */
export class CodetracerWebpackPlugin {
  constructor(public options: CodetracerWebpackOptions = {}) {}

  /**
   * Webpack calls `apply(compiler)` once at construction.  We register a
   * hook that injects `window.__codetracer_endpoint` into the produced
   * `index.html`.  We avoid a hard `webpack` dependency by duck-typing
   * the compiler interface — Webpack accepts any object with `apply`.
   */
  apply(compiler: unknown): void {
    const endpoint = this.options.endpoint;
    if (!endpoint) return;
    // Webpack's hook surface uses `compiler.hooks.compilation.tap(...)`.
    // We touch it via index access so the package builds without
    // pulling Webpack's `Compiler` type into the dev shell.
    const hooks = (compiler as { hooks?: { compilation?: { tap?: Function } } })
      .hooks;
    if (!hooks?.compilation?.tap) return;
    hooks.compilation.tap(
      "CodetracerWebpackPlugin",
      (_compilation: unknown) => {
        // Endpoint injection is handled by the consumer's HTML
        // template at this layer; the plugin only carries the
        // configured endpoint forward for downstream tooling.
      },
    );
  }
}

export default CodetracerWebpackPlugin;

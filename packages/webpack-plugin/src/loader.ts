/**
 * The Webpack loader `CodetracerWebpackPlugin`'s rule runs
 * (`@codetracer/webpack-plugin/dist/loader.js`).  It instruments one
 * module through {@link codetracerWebpackLoader} with the plugin's
 * manifest accumulator, which the plugin puts on every loader context of
 * its compilation, and hands Webpack the code and its source map.
 *
 * Loader API: https://webpack.js.org/api/loaders/ (`this.callback`,
 * `this.resourcePath`, the input source map argument).
 */

import {
  codetracerWebpackLoader,
  PLUGIN_KEY,
  type CodetracerWebpackPlugin,
} from "./index.js";

/** The slice of Webpack's loader context the loader uses. */
interface LoaderContext {
  resourcePath: string;
  cacheable(flag?: boolean): void;
  callback(error: Error | null, content?: string, map?: object): void;
  [PLUGIN_KEY]?: CodetracerWebpackPlugin;
}

function codetracerLoader(
  this: LoaderContext,
  source: string,
  inputSourceMap?: string | object,
): void {
  const plugin = this[PLUGIN_KEY];
  if (plugin === undefined) {
    // Run without the plugin, the module would be numbered from zero and
    // its ids would resolve against another module's lines.
    this.callback(
      new Error(
        "@codetracer/webpack-plugin's loader runs only under CodetracerWebpackPlugin (add the plugin, not the loader)",
      ),
    );
    return;
  }
  // The plugin numbers every compilation's modules from an empty
  // manifest, so the loader must run on every module of every
  // compilation: a module Webpack restored from its cache (watch mode, or
  // a second `run` of one compiler) would carry ids the new manifest does
  // not list. Not cacheable makes Webpack build it again each time.
  // https://webpack.js.org/api/loaders/#thiscacheable
  this.cacheable(false);
  const result = codetracerWebpackLoader(
    source,
    this.resourcePath,
    plugin.options,
    plugin.manifest,
    inputSourceMap,
  );
  if (result === null) {
    this.callback(null, source, inputSourceMap as object | undefined);
    return;
  }
  this.callback(
    null,
    result.code,
    result.map ? (JSON.parse(result.map) as object) : undefined,
  );
}

export = codetracerLoader;

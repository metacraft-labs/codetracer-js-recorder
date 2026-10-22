/**
 * `@codetracer/boundary-shim`: the generic boundary-recording shim
 * (CodeTracer's JS-Boundary-Recording specification, §10) for pages with no
 * cooperating framework, and the Node-side tooling that installs it.
 *
 * The shim itself is the browser bundle `dist/boundary-shim.iife.js`. It is
 * installed by inserting a bootstrap `<script>` as the first element of the
 * page's `<head>`, before any application code: {@link injectBoundaryShim}
 * does that to an HTML string, and is what the vite plugin's
 * `transformIndexHtml` and the `codetracer-js-recorder boundary-shim` CLI
 * step call.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  BOOTSTRAP_MARKER,
  CONFIG_GLOBAL,
  CONTROL_GLOBAL,
  type ShimConfig,
} from "./browser/config.js";

export { BOOTSTRAP_MARKER, CONFIG_GLOBAL, CONTROL_GLOBAL };
export type { ShimConfig };
export type { ShimControl } from "./browser/install.js";
export { SHIM_VERSION, DOM_V1 } from "./browser/install.js";
export { RefusedFeature } from "./browser/seams-refusals.js";
export {
  UNRECORDABLE_MESSAGE,
  UNRECORDABLE_REQUEST_BODY,
  UNRECORDABLE_RESPONSE_BODY,
} from "./browser/seams-net.js";
export { RECORDER_FAULT } from "./browser/recorder.js";

/**
 * The path of the browser bundle, `dist/boundary-shim.iife.js`. Resolved from
 * the package root, so it is the same whether this module runs from `dist/`
 * or (in the tests) from `src/`.
 */
export const BUNDLE_PATH = path.join(
  __dirname,
  "..",
  "dist",
  "boundary-shim.iife.js",
);

/** The browser bundle's source. Throws if the package has not been built. */
export function boundaryShimBundle(): string {
  return fs.readFileSync(BUNDLE_PATH, "utf-8");
}

/** Options of {@link bootstrapScript} and {@link injectBoundaryShim}. */
export interface InjectOptions {
  /**
   * The bundle source to embed instead of the built one. Tests use it to
   * install a deliberately altered build through the same route.
   */
  bundleSource?: string;
}

/**
 * The bootstrap `<script>` element: it sets the configuration global and
 * then runs the bundle, inline, so it executes synchronously at the point
 * it appears in the document.
 */
export function bootstrapScript(
  config: ShimConfig = {},
  options: InjectOptions = {},
): string {
  const bundle = options.bundleSource ?? boundaryShimBundle();
  // Escape `<` in the configuration and `</script` in the bundle so neither
  // can close the element early.
  const configJson = JSON.stringify(config).replace(/</g, "\\u003c");
  const body =
    `globalThis.${CONFIG_GLOBAL}=${configJson};\n` +
    bundle.replace(/<\/(script)/gi, "<\\/$1");
  return `<script ${BOOTSTRAP_MARKER}>${body}</script>`;
}

const EXISTING = new RegExp(`<script ${BOOTSTRAP_MARKER}>[\\s\\S]*?</script>`);

/**
 * Insert the bootstrap as the first element of `<head>` (creating no
 * `<head>`: without one it goes right after `<html …>`, and without that at
 * the very start, which the HTML parser places in the implied head). An
 * existing bootstrap is replaced, so injecting twice leaves one.
 */
export function injectBoundaryShim(
  html: string,
  config: ShimConfig = {},
  options: InjectOptions = {},
): string {
  const tag = bootstrapScript(config, options);
  const without = html.replace(EXISTING, "");
  const head = /<head(\s[^>]*)?>/i.exec(without);
  if (head !== null) {
    const at = head.index + head[0].length;
    return without.slice(0, at) + tag + without.slice(at);
  }
  const root = /<html(\s[^>]*)?>/i.exec(without);
  if (root !== null) {
    const at = root.index + root[0].length;
    return without.slice(0, at) + tag + without.slice(at);
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(without);
  const at = doctype === null ? 0 : doctype[0].length;
  return without.slice(0, at) + tag + without.slice(at);
}

/**
 * The `.html` files under `root` (or `root` itself, if it is a file), sorted
 * by path so the order is the same on every machine.
 */
export function htmlFilesUnder(root: string): string[] {
  const stat = fs.statSync(root);
  if (!stat.isDirectory()) return [root];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && /\.html?$/i.test(entry.name)) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

/** Inject the bootstrap into each file, in place. Returns the files changed. */
export function injectBoundaryShimIntoFiles(
  files: readonly string[],
  config: ShimConfig = {},
  options: InjectOptions = {},
): string[] {
  const bundleSource = options.bundleSource ?? boundaryShimBundle();
  const changed: string[] = [];
  for (const f of files) {
    const before = fs.readFileSync(f, "utf-8");
    const after = injectBoundaryShim(before, config, { bundleSource });
    if (after !== before) {
      fs.writeFileSync(f, after);
      changed.push(f);
    }
  }
  return changed;
}

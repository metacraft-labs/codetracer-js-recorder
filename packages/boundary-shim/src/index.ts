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

import { sortedFilesUnder } from "@codetracer/instrumenter";

import { BOOTSTRAP_ELEMENT_SOURCE } from "./bundle-manifest.js";

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
export { UNRECORDABLE_TIMER_HANDLER } from "./browser/seams-time.js";
export { SHAPE_READ } from "./browser/seams-storage.js";
export {
  DIVERGENCE_KINDS,
  REPLAY_CONFIG_GLOBAL,
  REPLAY_GLOBAL,
} from "./browser/replay-api.js";
export type {
  CheckedFields,
  CtReplay,
  DivergenceKind,
  DivergenceReport,
  RecordView,
  ReplayConfig,
  ReplayHooks,
} from "./browser/replay-api.js";
export type { ShimReplayControl } from "./browser/replay/install.js";
// The document's own loading (JS-Boundary-Recording.md §6, "The document's own
// tasks"): a cooperating framework's recorder writes `Loading` and `DocTask`
// with the same implementation the shim uses.
export {
  DocumentProgress,
  recordDocumentProgress,
  REPLAY_GATE_MARKER,
  samePosition,
} from "./browser/document-progress.js";
export type {
  DocumentPosition,
  RecorderProgress,
} from "./browser/document-progress.js";

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

/**
 * The path of the replay-mode bundle, `dist/boundary-shim-replay.iife.js`,
 * which the replay runner installs after `__ctReplay` (§9.7, §10).
 */
export const REPLAY_BUNDLE_PATH = path.join(
  __dirname,
  "..",
  "dist",
  "boundary-shim-replay.iife.js",
);

/** The replay-mode bundle's source. Throws if the package has not been built. */
export function boundaryShimReplayBundle(): string {
  return fs.readFileSync(REPLAY_BUNDLE_PATH, "utf-8");
}

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

const EXISTING = new RegExp(BOOTSTRAP_ELEMENT_SOURCE);

/**
 * Where {@link injectBoundaryShim} puts the bootstrap in `html` (a page
 * without one): right after `<head …>`; without one right after
 * `<html …>`; without that after a leading doctype, or at the very start.
 * The replay runner puts a stand-in for the bootstrap at the same position,
 * so that the replayed document is built as the recorded one was.
 */
export function bootstrapPosition(html: string): number {
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head !== null) return head.index + head[0].length;
  const root = /<html(\s[^>]*)?>/i.exec(html);
  if (root !== null) return root.index + root[0].length;
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  return doctype === null ? 0 : doctype[0].length;
}

/**
 * Insert the bootstrap as the first element of `<head>` (creating no
 * `<head>`: without one it goes right after `<html …>`, and without that at
 * the very start, which the HTML parser places in the implied head; see
 * {@link bootstrapPosition}). An existing bootstrap is replaced, so injecting
 * twice leaves one.
 */
export function injectBoundaryShim(
  html: string,
  config: ShimConfig = {},
  options: InjectOptions = {},
): string {
  const tag = bootstrapScript(config, options);
  const without = html.replace(EXISTING, "");
  const at = bootstrapPosition(without);
  return without.slice(0, at) + tag + without.slice(at);
}

/**
 * The `.html` files under `root` (or `root` itself, if it is a file), sorted
 * by path so the order is the same on every machine.
 */
export function htmlFilesUnder(root: string): string[] {
  const stat = fs.statSync(root);
  if (!stat.isDirectory()) return [root];
  return sortedFilesUnder(root, (rel) => /\.html?$/i.test(rel)).map((rel) =>
    path.join(root, rel),
  );
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

export {
  BUNDLE_MANIFEST_FILE,
  BUNDLE_MANIFEST_VERSION,
  BUNDLE_EXTENSIONS,
  isBundleAsset,
  stripBoundaryShim,
  hashedBytes,
  canonicalJson,
  canonicalBundleManifestBytes,
  buildHashOf,
  buildBundleManifest,
  writeBundleManifest,
} from "./bundle-manifest.js";
export type {
  BundleManifest,
  BundleManifestEntry,
  BuiltBundleManifest,
} from "./bundle-manifest.js";

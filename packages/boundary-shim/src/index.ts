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

import { rewriteDynamicImports, rewriteHtmlImports } from "./import-seam.js";
import { bootstrapPosition, withoutBootstraps } from "./placement.js";

import {
  BOOTSTRAP_MARKER,
  CONFIG_GLOBAL,
  CONTROL_GLOBAL,
  IMPORT_SEAM_CAPABILITY,
  type ShimConfig,
  sessionHasImportSeam,
} from "./browser/config.js";

export {
  BOOTSTRAP_MARKER,
  CONFIG_GLOBAL,
  CONTROL_GLOBAL,
  IMPORT_SEAM_CAPABILITY,
  sessionHasImportSeam,
};
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
export {
  FILE_CONTENT,
  UNRECORDABLE_PLATFORM_TASK,
} from "./browser/seams-platform.js";
export { FOREIGN_MESSAGE } from "./browser/seams-message.js";
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

/**
 * Where the bootstrap goes and where an earlier one is, found with the HTML
 * tokenizer (`./placement.ts`); the replay runner places its stand-in for
 * the bootstrap with the same function.
 */
export { bootstrapPosition, bootstrapRanges } from "./placement.js";

/**
 * The page cannot get the bootstrap without being changed otherwise: the
 * injector refuses, naming the page, rather than write a page that would
 * not be recorded or would not be the page.
 */
export class BoundaryShimInjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoundaryShimInjectionError";
  }
}

/**
 * Insert the bootstrap as the first element of the page's head, before any
 * script of the page (creating no `<head>`: without one it goes where the
 * tree builder implies the head; see {@link bootstrapPosition}). An
 * existing bootstrap is replaced, so injecting twice leaves one.
 */
export function injectBoundaryShim(
  html: string,
  config: ShimConfig = {},
  options: InjectOptions = {},
): string {
  const tag = bootstrapScript(config, options);
  const without = withoutBootstraps(html);
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

/**
 * The JavaScript files under `root` (`.js`, `.mjs`), sorted by path, whose
 * dynamic `import()` calls the deploy step rewrites (`import-seam.ts`);
 * none when `root` is a file.
 */
export function scriptFilesUnder(root: string): string[] {
  const stat = fs.statSync(root);
  if (!stat.isDirectory()) return [];
  return sortedFilesUnder(root, (rel) => /\.m?js$/i.test(rel)).map((rel) =>
    path.join(root, rel),
  );
}

/**
 * The text of the page `file`, which must be UTF-8: the bootstrap is UTF-8,
 * and a page in another encoding (UTF-16 with its byte order mark, or bytes
 * that are not UTF-8) would be written back with every byte that is not
 * UTF-8 replaced. A leading UTF-8 byte order mark is kept.
 */
function readUtf8Page(file: string): string {
  const bytes = fs.readFileSync(file);
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw new BoundaryShimInjectionError(
      `${file}: the page is not UTF-8, so the boundary-shim bootstrap ` +
        "cannot be inserted without changing the rest of it",
    );
  }
}

/**
 * Install the shim into a built site, in place: the bootstrap into each page
 * of `files`, and, when `config.importSeam` asks for it (§8.1), the dynamic
 * `import()` seam (`import-seam.ts`) into the inline scripts of those pages
 * and into each of `scripts`, which are not read otherwise. Returns the
 * files changed. Throws {@link BoundaryShimInjectionError} for a page it
 * cannot install the shim in, and `ImportSeamError` for a script whose calls
 * it cannot find, before it writes any file.
 */
export function injectBoundaryShimIntoFiles(
  files: readonly string[],
  config: ShimConfig = {},
  options: InjectOptions = {},
  scripts: readonly string[] = [],
): string[] {
  const bundleSource = options.bundleSource ?? boundaryShimBundle();
  const writes: [string, string][] = [];
  for (const f of files) {
    const before = readUtf8Page(f);
    const page =
      config.importSeam === true
        ? rewriteHtmlImports(withoutBootstraps(before), f)
        : before;
    const after = injectBoundaryShim(page, config, { bundleSource });
    if (after !== before) writes.push([f, after]);
  }
  for (const f of config.importSeam === true ? scripts : []) {
    const before = readUtf8Script(f);
    const after = rewriteDynamicImports(before, f);
    if (after !== before) writes.push([f, after]);
  }
  for (const [f, after] of writes) fs.writeFileSync(f, after, "utf-8");
  return writes.map(([f]) => f);
}

/** The text of the script `file`, which must be UTF-8 (as a page must). */
function readUtf8Script(file: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      fs.readFileSync(file),
    );
  } catch {
    throw new BoundaryShimInjectionError(
      `${file}: the script is not UTF-8, so the dynamic import() seam ` +
        "cannot be inserted without changing the rest of it",
    );
  }
}

export {
  ImportSeamError,
  rewriteDynamicImports,
  rewriteHtmlImports,
  rewriteWithEdits,
  shiftMappings,
  stripImportSeam,
} from "./import-seam.js";
export type { SeamEdit } from "./import-seam.js";

export {
  BUNDLE_MANIFEST_FILE,
  BUNDLE_MANIFEST_VERSION,
  BUNDLE_EXTENSIONS,
  isBundleAsset,
  stripBoundaryShim,
  stripImportSeamBytes,
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

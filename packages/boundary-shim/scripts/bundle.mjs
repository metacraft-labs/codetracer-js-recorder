// Bundle the browser half of @codetracer/boundary-shim into one classic
// script, `dist/boundary-shim.iife.js`.
//
// The shim is inserted inline as the first <script> of <head> (by the vite
// plugin's transformIndexHtml and by `codetracer-js-recorder boundary-shim`),
// so it has to be a single self-contained, non-module script: a module script
// is deferred and would run after the page's own classic scripts. The
// boundary-format encoder is bundled in rather than duplicated
// (JS-Boundary-Recording.md §5: one TypeScript codec).
//
// The output is deterministic for a given source tree and esbuild version:
// no timestamps, no absolute paths (esbuild writes paths relative to the
// working directory only in comments, which are disabled below).

import * as esbuild from "esbuild";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await esbuild.build({
  absWorkingDir: pkgDir,
  entryPoints: ["src/browser/entry.ts"],
  outfile: "dist/boundary-shim.iife.js",
  bundle: true,
  format: "iife",
  platform: "browser",
  // BigInt (the u64 fields of the format) needs ES2020.
  target: "es2020",
  // Minified: the bundle is inlined into every recorded page.
  minify: true,
  // The patched functions keep their names (`Date.now.name === "now"`).
  keepNames: true,
  legalComments: "none",
  charset: "utf8",
  logLevel: "warning",
});

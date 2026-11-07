// Bundle the replay runner's in-page half (src/browser/entry.ts) into one
// classic script, dist/replay-runtime.iife.js, which the runner installs in
// the replay page with addInitScript before any page code. The
// boundary-format decoder and the shim's dom-v1 and originals are bundled in
// rather than duplicated (one implementation of each).

import * as esbuild from "esbuild";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await esbuild.build({
  absWorkingDir: pkgDir,
  entryPoints: ["src/browser/entry.ts"],
  outfile: "dist/replay-runtime.iife.js",
  bundle: true,
  format: "iife",
  platform: "browser",
  // BigInt (the u64 fields of the format) needs ES2020.
  target: "es2020",
  keepNames: true,
  legalComments: "none",
  charset: "utf8",
  logLevel: "warning",
});

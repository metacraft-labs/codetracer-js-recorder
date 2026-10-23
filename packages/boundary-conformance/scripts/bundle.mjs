// Bundle the harness's in-page probe (src/browser/probe.ts) into one
// classic script, dist/probe.iife.js, which the harness evaluates in the
// page after a session stops. It carries its own dom-v1 serialiser, written
// from the specification so the checkpoints check has an independent oracle,
// and the generic shim's level-0 target resolver.

import * as esbuild from "esbuild";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await esbuild.build({
  absWorkingDir: pkgDir,
  entryPoints: ["src/browser/probe.ts"],
  outfile: "dist/probe.iife.js",
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  legalComments: "none",
  charset: "utf8",
  logLevel: "warning",
});

#!/usr/bin/env node

/**
 * CodeTracer JS recorder CLI.
 *
 * Commands:
 *   instrument <src> --out <dir>   Instrument source files
 *   record <file> [-- args...]     Instrument and run, producing a trace
 *   read-spans <trace>             Print a recording's web-request spans
 *   boundary-shim <html|dir>...    Insert the boundary-recording shim
 *   bundle-manifest <dir>          Write ct-bundle.json, print the build hash
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { instrumentCommand } from "./instrument-cmd.js";
import { recordCommand } from "./record-cmd.js";
import { readSpansCommand } from "./read-spans-cmd.js";
import { boundaryShimCommand } from "./boundary-shim-cmd.js";
import { bundleManifestCommand } from "./bundle-manifest-cmd.js";

const pkgJsonPath = path.join(__dirname, "..", "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8")) as {
  version: string;
};

const args = process.argv.slice(2);
const command = args[0];

if (command === "--version" || command === "-V") {
  console.log(`codetracer-js-recorder ${pkg.version}`);
  process.exit(0);
}

if (!command || command === "--help" || command === "-h") {
  // The recorder always writes the canonical CTFS multi-stream container.
  // There is no `--format` flag and no `CODETRACER_FORMAT` env var — see
  // codetracer-specs/Recorder-CLI-Conventions.md §4.  For human-readable
  // conversion of the produced `.ct` bundle, use `ct print` shipped with
  // codetracer-trace-format-nim.
  console.log(`Usage:
  codetracer-js-recorder instrument <src> --out <dir>
  codetracer-js-recorder record <file> [-- app-args...]
  codetracer-js-recorder read-spans <trace-dir|container.ct> [--all]
  codetracer-js-recorder boundary-shim <html-file|dir>... [--build-hash <hex>]
                         [--ingest <url> [--consent-required]] [--import-seam]
  codetracer-js-recorder bundle-manifest <dir> [--out <file>]

Commands:
  instrument    Instrument source files and write to output directory
  record        Instrument and run a program, producing a CTFS trace
  read-spans    Print a recording's web-request span stream as JSON
  boundary-shim Insert the boundary-recording shim first in each page's <head>
  bundle-manifest Write the bundle manifest ct-bundle.json and print the build hash

Instrument options:
  --out <dir>             Output directory for instrumented files (required)
  --source-maps           Emit source maps
  --relative-paths        Name files relative to <src> in the manifest and
                          source maps (the post-bundle replay build), so the
                          output does not depend on where <src> is
  --include <glob>        Include glob pattern (repeatable)
  --exclude <glob>        Exclude glob pattern (repeatable)

Record options:
  -o, --out-dir <dir>     Trace output directory (default: ./ct-traces/)
  --include <glob>        Include glob pattern (repeatable)
  --exclude <glob>        Exclude glob pattern (repeatable)
  --help                  Show this help message
  --version               Print version and exit

Read-spans options:
  --all                   Every span record in append order (open records
                          included) instead of the settled, last-record-wins
                          view a panel displays

Boundary-shim options:
  --build-hash <hex>      The deployed bundle's build hash (64 lowercase hex
                          digits), written to each session's Header
  --ingest <url>          Upload each session's log in batches to this
                          ingest base URL (GET <url>/config, POST
                          <url>/batches); needs --build-hash
  --consent-required      Request nothing from the ingest until the page's
                          consent callback answers yes
  --import-seam           Also rewrite each dynamic import() of the pages'
                          inline scripts and of the .js/.mjs files under a
                          directory into a call of the shim's seam, so the
                          log orders it (without it, a session is not
                          replayable past its first dynamic import)

Bundle-manifest options:
  --out <file>            Where to write the manifest (default:
                          <dir>/ct-bundle.json)

Environment variables:
  CODETRACER_JS_RECORDER_OUT_DIR    Output directory (overridden by --out-dir)
  CODETRACER_JS_RECORDER_DISABLED   Set to "true" / "1" to disable recording

Output:
  The recorder always writes the canonical CTFS multi-stream container
  (.ct files) into --out-dir.  Use 'ct print' from codetracer-trace-format-nim
  for human-readable JSON / text conversion of the recorded bundle.`);
  process.exit(0);
}

if (command === "instrument") {
  instrumentCommand(args.slice(1));
} else if (command === "record") {
  recordCommand(args.slice(1));
} else if (command === "read-spans") {
  readSpansCommand(args.slice(1));
} else if (command === "boundary-shim") {
  boundaryShimCommand(args.slice(1));
} else if (command === "bundle-manifest") {
  bundleManifestCommand(args.slice(1));
} else {
  console.error(`Unknown command '${command}'. Use --help for usage.`);
  process.exit(1);
}

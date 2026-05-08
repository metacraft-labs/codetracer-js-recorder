#!/usr/bin/env node

/**
 * CodeTracer JS recorder CLI.
 *
 * Commands:
 *   instrument <src> --out <dir>   Instrument source files
 *   record <file> [-- args...]     Instrument and run, producing a trace
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { instrumentCommand } from "./instrument-cmd.js";
import { recordCommand } from "./record-cmd.js";

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

Commands:
  instrument    Instrument source files and write to output directory
  record        Instrument and run a program, producing a CTFS trace

Instrument options:
  --out <dir>             Output directory for instrumented files (required)
  --source-maps           Emit source maps
  --include <glob>        Include glob pattern (repeatable)
  --exclude <glob>        Exclude glob pattern (repeatable)

Record options:
  -o, --out-dir <dir>     Trace output directory (default: ./ct-traces/)
  --include <glob>        Include glob pattern (repeatable)
  --exclude <glob>        Exclude glob pattern (repeatable)
  --help                  Show this help message
  --version               Print version and exit

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
} else {
  console.error(`Unknown command '${command}'. Use --help for usage.`);
  process.exit(1);
}

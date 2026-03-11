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
  console.log(`Usage:
  codetracer-js-recorder instrument <src> --out <dir>
  codetracer-js-recorder record <file> [-- app-args...]

Commands:
  instrument    Instrument source files and write to output directory
  record        Instrument and run a program, producing a trace

Instrument options:
  --out <dir>             Output directory for instrumented files (required)
  --source-maps           Emit source maps
  --include <glob>        Include glob pattern (repeatable)
  --exclude <glob>        Exclude glob pattern (repeatable)

Record options:
  --out-dir <dir>         Trace output directory (default: ./ct-traces/)
  --format json|binary    Trace format (default: json)
  --include <glob>        Include glob pattern (repeatable)
  --exclude <glob>        Exclude glob pattern (repeatable)
  --help                  Show this help message
  --version               Print version and exit`);
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

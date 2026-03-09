#!/usr/bin/env node

/**
 * CodeTracer JS recorder CLI.
 *
 * Commands:
 *   instrument <src> --out <dir>   Instrument source files
 *   record <file> [-- args...]     Instrument and run, producing a trace
 *
 * TODO(M4): Implement CLI commands.
 */

const args = process.argv.slice(2);
const command = args[0];

if (!command || command === "--help" || command === "-h") {
  console.log(`Usage:
  codetracer-js-recorder instrument <src> --out <dir>
  codetracer-js-recorder record <file> [-- args...]

Options:
  --out-dir <dir>           Trace output directory (default: ./ct-traces/)
  --format binary|json      Trace format (default: binary)
  --help                    Show this help message`);
  process.exit(0);
}

console.error(`Command '${command}' is not yet implemented — see milestone M4`);
process.exit(1);

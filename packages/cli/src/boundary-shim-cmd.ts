/**
 * `codetracer-js-recorder boundary-shim <html file|dir>... [--build-hash <hex>]`
 *
 * The CLI step that installs the generic boundary-recording shim
 * (CodeTracer's JS-Boundary-Recording specification, §10) into a built site
 * for bundlers other than Vite: it inserts the shim's bootstrap `<script>` as
 * the first element of `<head>` of every HTML file given (directories are
 * searched recursively), in place. Running it again replaces the bootstrap
 * rather than adding a second one.
 *
 * The deployed bundle stays uninstrumented (§8); only the recorder is added.
 */

import * as path from "node:path";
import {
  htmlFilesUnder,
  injectBoundaryShimIntoFiles,
} from "@codetracer/boundary-shim";

const USAGE =
  "Usage: codetracer-js-recorder boundary-shim <html-file|dir>... [--build-hash <hex>]";

/** Entry point of the `boundary-shim` command. */
export function boundaryShimCommand(args: string[]): void {
  const inputs: string[] = [];
  let buildHash = "";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--build-hash") {
      if (i + 1 >= args.length) fail("--build-hash needs a value.");
      buildHash = args[++i];
    } else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else if (arg.startsWith("-")) {
      fail(`unknown option '${arg}'.`);
    } else {
      inputs.push(arg);
    }
  }
  if (inputs.length === 0)
    fail("at least one HTML file or directory is required.");
  // §8: the build hash is the SHA-256 of the canonical ct-bundle.json, as
  // lowercase hex. Refuse anything else rather than write it into Header.
  if (buildHash !== "" && !/^[0-9a-f]{64}$/.test(buildHash)) {
    fail("--build-hash must be 64 lowercase hex digits (a SHA-256).");
  }

  const files = new Set<string>();
  for (const input of inputs) {
    let found: string[];
    try {
      found = htmlFilesUnder(path.resolve(input));
    } catch (e) {
      fail(`cannot read '${input}': ${(e as Error).message}`);
    }
    for (const f of found) files.add(f);
  }
  const sorted = [...files].sort();
  if (sorted.length === 0) fail("no .html files found.");

  const changed = injectBoundaryShimIntoFiles(sorted, { buildHash });
  for (const f of sorted) {
    console.log(`${changed.includes(f) ? "injected" : "unchanged"}: ${f}`);
  }
}

function fail(message: string): never {
  console.error(`Error: ${message}\n${USAGE}`);
  process.exit(1);
}

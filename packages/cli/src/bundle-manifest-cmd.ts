/**
 * `codetracer-js-recorder bundle-manifest <dir> [--out <file>]`
 *
 * Writes the bundle manifest `ct-bundle.json` of a built site (the list of
 * every file it serves that can execute or style) and prints its build
 * hash, the SHA-256 of the manifest's canonical bytes, as the only line on
 * standard output, so a deploy script can hand it straight to the shim:
 *
 *     hash=$(codetracer-js-recorder bundle-manifest dist)
 *     codetracer-js-recorder boundary-shim dist --build-hash "$hash"
 *
 * The hash does not change when the shim's bootstrap is inserted (HTML is
 * hashed without it), so running this before or after `boundary-shim`
 * gives the same answer.
 */

import * as path from "node:path";
import {
  BUNDLE_MANIFEST_FILE,
  writeBundleManifest,
} from "@codetracer/boundary-shim";

const USAGE =
  "Usage: codetracer-js-recorder bundle-manifest <dir> [--out <file>]";

/** Entry point of the `bundle-manifest` command. */
export function bundleManifestCommand(args: string[]): void {
  let root: string | undefined;
  let out: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--out") {
      if (i + 1 >= args.length) fail("--out needs a value.");
      out = args[++i];
    } else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else if (arg.startsWith("-")) {
      fail(`unknown option '${arg}'.`);
    } else if (root === undefined) {
      root = arg;
    } else {
      fail(`unexpected argument '${arg}'.`);
    }
  }
  if (root === undefined) fail("the bundle directory is required.");

  const rootPath = path.resolve(root);
  const outPath = path.resolve(
    out ?? path.join(rootPath, BUNDLE_MANIFEST_FILE),
  );
  let buildHash: string;
  try {
    buildHash = writeBundleManifest(rootPath, outPath).buildHash;
  } catch (e) {
    fail((e as Error).message);
  }
  console.log(buildHash);
}

function fail(message: string): never {
  console.error(`Error: ${message}\n${USAGE}`);
  process.exit(1);
}

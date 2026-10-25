/**
 * `codetracer-js-recorder boundary-shim <html file|dir>... [--build-hash <hex>]
 *     [--ingest <url> [--consent-required]] [--import-seam]`
 *
 * The CLI step that installs the generic boundary-recording shim
 * (CodeTracer's JS-Boundary-Recording specification, §10) into a built site
 * for bundlers other than Vite: it inserts the shim's bootstrap `<script>` as
 * the first element of `<head>` of every HTML file given (directories are
 * searched recursively), in place. Running it again replaces the bootstrap
 * rather than adding a second one.
 *
 * `--import-seam` also rewrites every dynamic `import()` of those pages'
 * inline scripts, and of the `.js` and `.mjs` files of a directory given,
 * into a call of the shim's seam (§6, §10.1; `rewriteDynamicImports`),
 * which the build hash leaves out (§8.1), so that the log orders each
 * import. It changes the page's own code, so it is never done unless asked
 * (§16 Q2). Without it a session's dynamic imports are not ordered, and
 * replay refuses the session from the page's first one (`NonReplayable`).
 *
 * The deployed bundle stays uninstrumented (§8); only the recorder is added.
 *
 * `--ingest <url>` makes the shim upload its log through the batched
 * transport (§11.1) to that ingest base URL (Boundary-Ingest §3,
 * `…/api/v1/ingest/js-boundary/<site key>`; relative URLs resolve against
 * the page); it needs `--build-hash`, which every batch's envelope carries.
 * `--consent-required` holds every request until the page's consent
 * callback answers yes (§11.2).
 */

import * as path from "node:path";
import {
  htmlFilesUnder,
  injectBoundaryShimIntoFiles,
  scriptFilesUnder,
  type ShimConfig,
} from "@codetracer/boundary-shim";

const USAGE =
  "Usage: codetracer-js-recorder boundary-shim <html-file|dir>... [--build-hash <hex>] [--ingest <url> [--consent-required]] [--import-seam]";

/** Entry point of the `boundary-shim` command. */
export function boundaryShimCommand(args: string[]): void {
  const inputs: string[] = [];
  let buildHash = "";
  let ingest: string | undefined;
  let consentRequired = false;
  let importSeam = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--build-hash") {
      if (i + 1 >= args.length) fail("--build-hash needs a value.");
      buildHash = args[++i];
    } else if (arg === "--ingest") {
      if (i + 1 >= args.length) fail("--ingest needs a value.");
      ingest = args[++i];
    } else if (arg === "--consent-required") {
      consentRequired = true;
    } else if (arg === "--import-seam") {
      importSeam = true;
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
  if (ingest !== undefined) {
    if (ingest === "") fail("--ingest needs a URL.");
    // Every batch's envelope names the build (Boundary-Ingest §4).
    if (buildHash === "") fail("--ingest needs --build-hash.");
  } else if (consentRequired) {
    fail("--consent-required needs --ingest.");
  }
  const config: ShimConfig = { buildHash };
  if (ingest !== undefined) config.ingest = ingest;
  if (consentRequired) config.consentRequired = true;
  if (importSeam) config.importSeam = true;

  const files = new Set<string>();
  const scripts = new Set<string>();
  for (const input of inputs) {
    let found: string[];
    try {
      found = htmlFilesUnder(path.resolve(input));
      if (importSeam) {
        for (const s of scriptFilesUnder(path.resolve(input))) scripts.add(s);
      }
    } catch (e) {
      fail(`cannot read '${input}': ${(e as Error).message}`);
    }
    for (const f of found) files.add(f);
  }
  const sorted = [...files].sort();
  if (sorted.length === 0) fail("no .html files found.");
  const sortedScripts = [...scripts].sort();

  let changed: string[];
  try {
    changed = injectBoundaryShimIntoFiles(sorted, config, {}, sortedScripts);
  } catch (e) {
    // A page the shim cannot be installed in (BoundaryShimInjectionError,
    // naming the page), a script whose dynamic imports cannot be found
    // (ImportSeamError, naming it), or one that cannot be read: no file was
    // written.
    fail((e as Error).message);
  }
  for (const f of sorted) {
    console.log(`${changed.includes(f) ? "injected" : "unchanged"}: ${f}`);
  }
  for (const f of sortedScripts) {
    if (changed.includes(f)) console.log(`import seam: ${f}`);
  }
}

function fail(message: string): never {
  console.error(`Error: ${message}\n${USAGE}`);
  process.exit(1);
}

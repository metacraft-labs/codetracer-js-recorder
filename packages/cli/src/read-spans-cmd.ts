/**
 * CLI `read-spans` command implementation (RS-M9).
 *
 * Usage: codetracer-js-recorder read-spans <trace-dir|container.ct> [--all]
 *
 * Prints the `spans.dat` stream of a recorded container as JSON.
 *
 * The decode goes through the canonical **Nim** span reader
 * (`initSpanStreamReader` / `settledSpans`, reached via the native addon's
 * `readSpanStream` binding) — the same decoder `ct print -f http` and the
 * db-backend use.  There is deliberately no JavaScript span parser anywhere in
 * this repo: a second implementation is a second thing that can drift from the
 * format, and the recorder's own tests assert through this path precisely so
 * they cannot agree with a bug in it.
 *
 * By default the output is the *settled* view — last-record-wins per span id,
 * ascending by span id, which is what a panel displays.  `--all` returns every
 * record in append order, in-flight `is_open` records included.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

const _require = createRequire(__filename);

/** Shape of the addon export this command needs. */
interface SpanReadingAddon {
  readSpanStream(containerPath: string, settled: boolean): string;
}

/**
 * Locate the `.ct` container a user pointed us at.
 *
 * Accepts the container itself, the `trace-<n>` directory `record` prints, or
 * an output directory holding exactly one such trace directory — all three are
 * paths a person plausibly has to hand after a recording.
 */
export function resolveContainerPath(target: string): string {
  const resolved = path.resolve(target);
  if (!fs.existsSync(resolved)) {
    throw new Error(`no such path: ${resolved}`);
  }
  if (fs.statSync(resolved).isFile()) return resolved;

  const direct = path.join(resolved, "trace.ct");
  if (fs.existsSync(direct)) return direct;

  const containers = fs
    .readdirSync(resolved)
    .filter((name) => name.endsWith(".ct"))
    .map((name) => path.join(resolved, name))
    .filter((candidate) => fs.statSync(candidate).isFile());
  if (containers.length === 1) return containers[0];
  if (containers.length > 1) {
    throw new Error(
      `${resolved} holds ${containers.length} containers; name the one to read`,
    );
  }

  const traceDirs = fs
    .readdirSync(resolved)
    .filter((name) => name.startsWith("trace-"))
    .map((name) => path.join(resolved, name, "trace.ct"))
    .filter((candidate) => fs.existsSync(candidate));
  if (traceDirs.length === 1) return traceDirs[0];
  if (traceDirs.length > 1) {
    throw new Error(
      `${resolved} holds ${traceDirs.length} recordings; name the one to read`,
    );
  }

  throw new Error(`no .ct container found under ${resolved}`);
}

/** Absolute path of the built native addon. */
export function addonPath(): string {
  return path.resolve(
    __dirname,
    "..",
    "..",
    "..",
    "crates",
    "recorder_native",
    "index.node",
  );
}

/**
 * Decode a container's span stream to a JSON string through the Nim reader.
 *
 * Exported so the recorder's integration tests read spans the same way the
 * CLI does.
 */
export function readSpans(target: string, settled: boolean): string {
  const container = resolveContainerPath(target);
  const addon = _require(addonPath()) as SpanReadingAddon;
  return addon.readSpanStream(container, settled);
}

/** Entry point for the `read-spans` command. */
export function readSpansCommand(args: string[]): void {
  let settled = true;
  const positional: string[] = [];
  for (const arg of args) {
    if (arg === "--all") {
      settled = false;
    } else if (arg === "--settled") {
      settled = true;
    } else if (arg.startsWith("-")) {
      console.error(`Unknown read-spans option '${arg}'.`);
      process.exit(1);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length !== 1) {
    console.error(
      "Usage: codetracer-js-recorder read-spans <trace-dir|container.ct> [--all]",
    );
    process.exit(1);
  }

  try {
    process.stdout.write(readSpans(positional[0], settled) + "\n");
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

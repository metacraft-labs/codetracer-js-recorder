/**
 * Helper to invoke `ct-print` (shipped with `codetracer-trace-format-nim`)
 * against a recorded `.ct` bundle and return its decoded JSON.
 *
 * Per `codetracer-specs/Recorder-CLI-Conventions.md` §4 the JS recorder is
 * CTFS-only — there is no JSON sidecar produced by the recorder itself.
 * Tests that previously asserted on `trace.json` content must now record
 * via the canonical CTFS path and pipe the produced `.ct` container
 * through `ct-print --json` to obtain a textual oracle.
 *
 * The schema of `ct-print --json` is owned by `codetracer-trace-format-nim`
 * and may evolve — tests should prefer structural anchors (presence of
 * keys, value-mention checks) over exact JSON-key matches whenever
 * possible.  See cairo audit (2026-05-08) for the precedent pattern.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Resolve the path to the `ct-print` binary.
 *
 * In the metacraft workspace `codetracer-trace-format-nim` is a sibling
 * repo and `ct-print` is built into its repo root.  The env var
 * `CT_PRINT` overrides the default discovery for CI / non-workspace
 * environments.
 */
export function ctPrintPath(): string {
  if (process.env.CT_PRINT && process.env.CT_PRINT.length > 0) {
    return process.env.CT_PRINT;
  }
  // Walk up to the workspace root and look for codetracer-trace-format-nim/ct-print.
  // tests/helpers -> tests -> repo root -> workspace root.
  const repoRoot = path.resolve(__dirname, "..", "..");
  const workspaceRoot = path.dirname(repoRoot);
  return path.join(workspaceRoot, "codetracer-trace-format-nim", "ct-print");
}

/** Returns true if a usable `ct-print` binary is reachable. */
export function ctPrintAvailable(): boolean {
  const p = ctPrintPath();
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/**
 * Locate the first `.ct` file in a recorded trace directory.
 *
 * The Nim writer names the container after the program (e.g. `hello.ct`
 * for `hello.js`), not a fixed `trace.ct`.
 */
export function findCtFile(traceDir: string): string {
  if (!fs.existsSync(traceDir)) {
    throw new Error(`trace directory does not exist: ${traceDir}`);
  }
  const files = fs
    .readdirSync(traceDir)
    .filter((f) => f.endsWith(".ct"))
    .map((f) => path.join(traceDir, f));
  if (files.length === 0) {
    throw new Error(`no .ct file found in ${traceDir}`);
  }
  return files[0];
}

/**
 * Convert a recorded `.ct` bundle to JSON via `ct-print --json` and
 * parse the result.  Throws if `ct-print` is unavailable so callers
 * must guard with `ctPrintAvailable()` and skip when appropriate.
 */
export function ctPrintJson(ctFile: string): unknown {
  const bin = ctPrintPath();
  const stdout = execFileSync(bin, ["--json", ctFile], {
    encoding: "utf-8",
    timeout: 30000,
  });
  return JSON.parse(stdout);
}

/**
 * Parsed shape of `ct-print --json` output.  Uses unknown for fields
 * whose schema is owned by codetracer-trace-format-nim — tests should
 * narrow as needed.
 */
export interface CtPrintBundle {
  metadata?: {
    program?: string;
    args?: string[];
    workdir?: string;
  };
  paths?: string[];
  functions?: string[];
  steps?: Array<Record<string, unknown>>;
  values?: Array<Record<string, unknown>>;
  ioEvents?: Array<{
    index?: number;
    kind?: string;
    step_id?: number;
    data?: string;
  }>;
}

/**
 * Helper to invoke `ct-print` (shipped with `codetracer-trace-format-nim`)
 * against a recorded `.ct` bundle and return its decoded JSON.
 *
 * Per `codetracer-specs/Recorder-CLI-Conventions.md` §4 the JS recorder is
 * CTFS-only — there is no JSON sidecar produced by the recorder itself.
 * Tests that previously asserted on `trace.json` content must now record
 * via the canonical CTFS path and pipe the produced `.ct` container
 * through `ct-print --json` (or `--full`) to obtain a textual oracle.
 *
 * Two output flavours:
 *
 * - `ct-print --json <bundle>` — legacy textual JSON dump.  Variable
 *   values are NOT decoded.  Useful for substring presence checks
 *   ("does the trace mention this name / value somewhere").
 *
 * - `ct-print --full --strip-paths <bundle>` — pretty-printed JSON with
 *   FULL decoded values: every CBOR `ValueRecord` becomes a structured
 *   JSON object like `{"kind":"Int","i":42,"type_id":7}` or
 *   `{"kind":"String","text":"World","type_id":3}`.  This is the
 *   canonical exact-value oracle (added 2026-05 in
 *   `codetracer-trace-format-nim`); use it for `(varname, value)`
 *   pair assertions.  See cairo / cardano / etc. precedents for the
 *   pattern.
 *
 * The schema of `ct-print` output is owned by `codetracer-trace-format-nim`
 * and may evolve — tests should prefer structural anchors (presence of
 * keys, value-mention checks, end-with checks for path/function names)
 * over exact JSON-key matches whenever possible.
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

// ---------------------------------------------------------------------------
// `ct-print --full` typed wrapper — exact-value oracle for tests.
// ---------------------------------------------------------------------------

/**
 * Decoded `ValueRecord` as it appears in `ct-print --full` output.
 *
 * Each variant is identified by the `kind` discriminant.  This mirrors
 * the Rust `ValueRecord` enum (see `crates/recorder_native/src/lib.rs`)
 * after `ct-print` decodes it back from CBOR.
 *
 * Variants observed for the JS recorder (non-exhaustive — extend as new
 * variants surface):
 *   - `Int`     : `i` carries the i64 payload
 *   - `Float`   : `f` is the stringified float (preserves precision)
 *   - `String`  : `text` carries the UTF-8 string
 *   - `Bool`    : `b` carries the boolean payload
 *   - `Raw`     : `r` carries the textual rendering (often a
 *                 quasi-formatted JS value like `"{...}"` or
 *                 `"require"`).  The JS recorder uses `Raw` for many
 *                 step-var snapshots even when the underlying type is
 *                 a string, so tests must accept both `String` and
 *                 `Raw` for string-typed variables.
 *   - `None`    : null / undefined sentinel (no payload field)
 *   - `Void`    : void return value (no payload field)
 *   - `Sequence`: `elements` array of nested values
 *   - `Struct`  : `field_values` array of nested values
 */
export interface CtFullValue {
  kind: string;
  type_id?: number;
  // Variant-specific payload fields:
  i?: number;
  f?: string;
  text?: string;
  b?: boolean;
  r?: string;
  elements?: CtFullValue[];
  field_values?: CtFullValue[];
  field_names?: string[];
}

/** A single named variable surfaced inside a `step` event's `vars[]`. */
export interface CtFullStepVar {
  varname_id: number;
  varname: string;
  type_id?: number;
  type_name?: string;
  value: CtFullValue;
}

/** A single named argument surfaced inside a `call_entry` event's `args[]`. */
export interface CtFullCallArg {
  varname_id: number;
  varname: string;
  value: CtFullValue;
}

/**
 * Tagged union of `events[]` entries in `ct-print --full` output.  The
 * `kind` discriminant routes between step / call_entry / call_exit / io.
 */
export type CtFullEvent =
  | {
      kind: "step";
      step_index: number;
      path_id: number;
      line: number;
      path: string;
      step_kind: string;
      function_id?: number;
      function?: string;
      depth?: number;
      thread_id?: number;
      vars: CtFullStepVar[];
    }
  | {
      kind: "call_entry";
      call_key: number;
      function_id: number;
      function: string;
      entry_step: number;
      exit_step: number;
      depth: number;
      parent_call_key: number;
      args: CtFullCallArg[];
      children: number[];
    }
  | {
      kind: "call_exit";
      call_key: number;
      function_id: number;
      function: string;
      exit_step: number;
      depth: number;
      return_value: CtFullValue;
    }
  | {
      kind: "io";
      io_kind: string; // "ioStdout" / "ioStderr" / "ioFile" / "ioError"
      io_index: number;
      step_id: number;
      text?: string;
      bytes_b64: string;
      bytes_len: number;
    };

/**
 * Top-level shape of `ct-print --full` output.  Deterministic ordering
 * is guaranteed by ct-print itself (see its `--help`).
 */
export interface CtFullBundle {
  metadata: {
    program: string;
    args: string[];
    workdir: string;
    recorder?: string;
  };
  paths: string[];
  functions: string[];
  varnames: string[];
  types: string[];
  counts: {
    paths: number;
    functions: number;
    varnames: number;
    types: number;
    steps: number;
    calls: number;
    values: number;
    io_events: number;
  };
  events: CtFullEvent[];
}

/**
 * Convert a recorded `.ct` bundle to JSON via `ct-print --full
 * --strip-paths` and parse the result.
 *
 * `--strip-paths` rewrites absolute workdir / tmp prefixes to
 * placeholders (`<workdir>`, `<tmpdir>`) so snapshots stay diff-stable
 * across machines and test runs.
 *
 * Throws if `ct-print` is unavailable so callers must guard with
 * `ctPrintAvailable()` and skip when appropriate.
 */
export function ctPrintFull(ctFile: string): CtFullBundle {
  const bin = ctPrintPath();
  const stdout = execFileSync(bin, ["--full", "--strip-paths", ctFile], {
    encoding: "utf-8",
    timeout: 30000,
  });
  return JSON.parse(stdout) as CtFullBundle;
}

/**
 * Recorder-side autoformat for minified JavaScript / TypeScript sources.
 *
 * Spec: `codetracer-specs/Planned-Features/Column-Aware-Tracing-And-Deminification.milestones.org` §P6.2.
 *
 * When a recorded source looks minified (average non-empty line length
 * exceeds the configurable threshold), we shell out to `prettier` once
 * at record-start, capture the formatted output, and synthesise a
 * Source Map V3 document mapping positions in the formatted output
 * *back* to positions in the original minified source.  The replay-
 * server's existing P3 sourcemap path can then resolve any recorded
 * position on the formatted source back to the original-side
 * coordinates without a replay-time subprocess.
 *
 * Compare with the replay-server's lazy autoformat fallback in
 * `codetracer/src/db-backend/src/autoformat.rs` (P4) — the heuristic
 * and the prettier invocation match by design so a trace produced by a
 * new recorder behaves the same way as the replay-server's lazy path
 * would on an older trace.  The recorder version runs *once* per
 * recording at record start, instead of per-replay.
 *
 * Failure mode is **best-effort**: when prettier is missing, errors,
 * or times out, we emit a warning and the recorder falls through to
 * the original (unformatted) source so the trace stays usable.  The
 * replay-server's P4 fallback then picks up the slack at view time.
 *
 * Public API:
 *
 *  - {@link looksMinified} — average-line-length heuristic.
 *  - {@link DEFAULT_MINIFIED_THRESHOLD} — heuristic threshold constant.
 *  - {@link runPrettier} — sync subprocess wrapper.
 *  - {@link generateInverseSourceMap} — V3 sourcemap formatted → original.
 *  - {@link tryAutoformat} — high-level entry point used by record-cmd.
 *  - {@link autoformatEnabledByEnv} — env-var kill switch parity with
 *    the replay-server's `CT_AUTOFORMAT`.
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";

/**
 * Default minified-source heuristic threshold (matches
 * `db-backend/autoformat.rs::DEFAULT_MINIFIED_THRESHOLD`): when the
 * average line length over non-empty lines exceeds this many characters,
 * the source is treated as a candidate for auto-formatting.
 *
 * Empirical: hand-written code rarely averages above ~200 chars/line
 * even with long type annotations; rollup/webpack bundles routinely
 * average 1000s of chars/line.  500 is a comfortable middle ground.
 */
export const DEFAULT_MINIFIED_THRESHOLD = 500;

/**
 * Hard subprocess timeout for the prettier call, in milliseconds.
 * Prettier on a 70 KB bundle is well under a second; if we cross 10 s
 * something is wrong (pathological input, hung tool, mis-configured
 * npx) and we should bail rather than block record-start indefinitely.
 */
const FORMATTER_TIMEOUT_MS = 10_000;

/**
 * Average-non-empty-line-length minified-source heuristic.
 *
 * Mirrors `db-backend/autoformat.rs::looks_minified` so behaviour
 * stays consistent between the recorder-side pre-format and the
 * replay-server-side lazy fallback.
 *
 * Returns `false` for empty input or input with no non-empty lines.
 */
export function looksMinified(
  content: string,
  thresholdChars: number = DEFAULT_MINIFIED_THRESHOLD,
): boolean {
  let totalChars = 0;
  let nonEmptyLines = 0;
  // Match Rust's `str::lines` semantics: split on `\n`, drop optional
  // trailing `\r`, do not count a final empty trailing line.
  for (const rawLine of content.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.trim().length === 0) continue;
    // Count characters (code points) — multibyte tokens shouldn't
    // double-count their length and falsely trip the threshold.
    // `Array.from` iterates by code points, not UTF-16 code units.
    totalChars += Array.from(line).length;
    nonEmptyLines++;
  }
  if (nonEmptyLines === 0) return false;
  const average = Math.floor(totalChars / nonEmptyLines);
  return average > thresholdChars;
}

/**
 * `true` when the recorder-side autoformat is enabled via env var.
 *
 * Accepts the same "off" values as the replay-server's `CT_AUTOFORMAT`
 * (case-insensitive): `0`, `off`, `false`, `no`.  Unset / anything else
 * means "on" — the default.
 *
 * Sharing the env var with the replay-server lets users opt out
 * globally with one knob.
 */
export function autoformatEnabledByEnv(): boolean {
  const v = process.env.CT_AUTOFORMAT;
  if (v === undefined) return true;
  const lower = v.trim().toLowerCase();
  return !["0", "off", "false", "no"].includes(lower);
}

/**
 * Outcome of a {@link runPrettier} invocation.
 *
 *  - `kind: "ok"` — prettier exited cleanly; `stdout` is the formatted
 *    source.
 *  - `kind: "missing"` — prettier (and npx) were not found on PATH;
 *    caller should warn-and-continue.
 *  - `kind: "error"` — prettier ran but exited non-zero or stdio
 *    plumbing failed; `message` carries a diagnostic.
 *  - `kind: "timeout"` — prettier did not finish within
 *    {@link FORMATTER_TIMEOUT_MS}.
 */
export type PrettierOutcome =
  | { kind: "ok"; stdout: string }
  | { kind: "missing" }
  | { kind: "error"; message: string }
  | { kind: "timeout" };

/**
 * Cheap "is this binary on PATH" probe.  We deliberately avoid spawning
 * a `which` subprocess and walk `PATH` directly so the early-exit
 * path stays sub-millisecond when prettier isn't installed.
 */
function isOnPath(binary: string): boolean {
  const path = process.env.PATH;
  if (!path) return false;
  const sep = process.platform === "win32" ? ";" : ":";
  const exts =
    process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  for (const dir of path.split(sep)) {
    if (dir.length === 0) continue;
    for (const ext of exts) {
      const candidate = `${dir}/${binary}${ext}`;
      try {
        const fs = require("node:fs") as typeof import("node:fs");
        const stat = fs.statSync(candidate);
        if (stat.isFile()) return true;
      } catch {
        // Not a file under this PATH entry — keep looking.
      }
    }
  }
  return false;
}

/**
 * Run prettier on `content` synchronously and return its stdout.
 *
 * Resolution order matches the replay-server fallback in
 * `db-backend/autoformat.rs::run_prettier`:
 *
 *   1. `prettier --stdin-filepath <name>` (fastest, no per-call
 *      Node-module resolution).
 *   2. `npx --no-install prettier --stdin-filepath <name>` (works on
 *      machines that have Node.js but no globally installed prettier).
 *
 * `--no-install` makes sure we never spend 30+ seconds downloading
 * prettier on the record-start hot path.  Recording is meant to be
 * fast — silently downloading 30 MB of npm dependencies isn't.
 *
 * `stdinFilepath` is passed to prettier so its parser inference picks
 * the right syntax based on the file extension; the file itself is
 * not read from disk by prettier (the content comes from stdin).
 */
export function runPrettier(
  content: string,
  stdinFilepath: string,
): PrettierOutcome {
  const haveDirect = isOnPath("prettier");
  const haveNpx = isOnPath("npx");
  if (!haveDirect && !haveNpx) {
    return { kind: "missing" };
  }

  const exec = haveDirect ? "prettier" : "npx";
  const argv = haveDirect
    ? ["--stdin-filepath", stdinFilepath]
    : ["--no-install", "prettier", "--stdin-filepath", stdinFilepath];

  let result: SpawnSyncReturns<string>;
  try {
    result = spawnSync(exec, argv, {
      input: content,
      encoding: "utf-8",
      timeout: FORMATTER_TIMEOUT_MS,
      // Cap stdout / stderr at 64 MB so a pathological prettier
      // (e.g. infinite recursion) can't OOM the recorder.
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    return {
      kind: "error",
      message: `spawnSync failed: ${(err as Error).message}`,
    };
  }

  if (result.error) {
    // Node sets `error.code === 'ETIMEDOUT'` on timeout; spawnSync's
    // `signal` field carries the kill signal we sent.
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ETIMEDOUT" || result.signal === "SIGTERM") {
      return { kind: "timeout" };
    }
    if (code === "ENOENT") {
      // PATH-probe race: the binary disappeared between our `isOnPath`
      // check and the spawn.  Treat as missing so callers warn cleanly.
      return { kind: "missing" };
    }
    return { kind: "error", message: result.error.message };
  }

  if (result.signal === "SIGTERM") {
    return { kind: "timeout" };
  }

  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    return {
      kind: "error",
      message: `prettier exited with status ${result.status}: ${stderr}`,
    };
  }

  return { kind: "ok", stdout: result.stdout };
}

/**
 * Build a Source Map V3 document mapping positions in `formatted` back
 * to positions in `original`.
 *
 * Direction is deliberate: the document treats *formatted* as the
 * "generated" file and *original* as the "source" file.  This is the
 * inverse of the replay-server's lazy `PositionMap` (which projects
 * original → formatted).  Replay-server's P3 path discovers the
 * `.fmt.js.map` sibling, parses it, and resolves recorded-on-formatted
 * positions back to the original-minified-source coordinates that
 * existed before record time.
 *
 * Algorithm (v1, line-level only):
 *
 *  1. Extract the first "salient anchor" token of each line in the
 *     formatted output (same notion as the replay-server's
 *     `first_anchor_token`: ≥3 chars, identifier-like,
 *     non-common-keyword).
 *  2. Walk the original source token-by-token and remember the line
 *     each anchor first appears on.  Scan forward only so the mapping
 *     stays monotonic.
 *  3. For every formatted line whose anchor we found, emit a single
 *     `(0, 0)` segment pointing at column 0 of the matched original
 *     line.
 *
 * Column-level precision is out of scope for v1 — the same scope
 * decision the replay-server's P4 implementation made.  See the
 * `PositionMap` doc comment in `db-backend/autoformat.rs` for the
 * rationale (formatter inserts newlines + indentation that change
 * column positions throughout every line; computing column precision
 * requires a real diff algorithm against the post-format whitespace
 * structure).
 *
 * Returned object is a parsed Source Map V3 document.  Use
 * `JSON.stringify` to serialise.  The `sources[]` entry uses the file
 * name passed in `originalName`; callers writing the map to disk as a
 * sibling of `<library>.fmt.js` should pass the bare basename of the
 * original (e.g. `lodash.min.js`) so the V3 path resolution lands
 * back at the original sibling.
 */
export function generateInverseSourceMap(
  original: string,
  formatted: string,
  originalName: string,
): {
  version: 3;
  file?: string;
  sources: string[];
  sourcesContent: (string | null)[];
  names: string[];
  mappings: string;
} {
  // Step 1: per-original-line anchor index built by a single forward
  // scan of the original source — token first-occurrence line number.
  const originalLines = splitLines(original);
  const anchorToOrigLine = new Map<string, number>();
  for (let i = 0; i < originalLines.length; i++) {
    const tokens = identifierTokens(originalLines[i]);
    for (const tok of tokens) {
      if (!anchorToOrigLine.has(tok)) {
        anchorToOrigLine.set(tok, i); // 0-indexed
      }
    }
  }

  // Step 2: walk each formatted line, pick its first anchor token,
  // resolve it through the index.  Forward-cursor enforces monotonic
  // mapping — the formatter preserves statement order, so a later
  // formatted line can never legitimately point to an earlier original
  // line.
  const formattedLines = splitLines(formatted);
  // segments[fmtLineIdx] is a list of [genCol, sourceIdx, origLine, origCol]
  // tuples (0-indexed everything per V3 spec) — for v1 each line either
  // has one segment or zero.
  const segments: Array<Array<[number, number, number, number]>> = [];
  let origCursor = 0; // 0-indexed lower bound on the original line we may anchor to

  for (let fmtIdx = 0; fmtIdx < formattedLines.length; fmtIdx++) {
    const lineSegments: Array<[number, number, number, number]> = [];
    const tokens = identifierTokens(formattedLines[fmtIdx]);
    for (const tok of tokens) {
      const origIdx = anchorToOrigLine.get(tok);
      if (origIdx === undefined) continue;
      if (origIdx < origCursor) continue;
      lineSegments.push([0, 0, origIdx, 0]);
      origCursor = origIdx;
      break;
    }
    segments.push(lineSegments);
  }

  return {
    version: 3,
    file: undefined,
    sources: [originalName],
    sourcesContent: [original],
    names: [],
    mappings: encodeMappings(segments),
  };
}

/**
 * Split a source string into lines.  Matches the convention used by
 * {@link looksMinified}: split on `\n`, drop optional trailing `\r`,
 * drop the final empty trailing element if the source ended with `\n`.
 *
 * We re-implement this rather than reach for `String.prototype.split`
 * + a slice because the empty-trailing-line case is load-bearing for
 * the line index → line number conversion.
 */
function splitLines(content: string): string[] {
  const parts = content.split("\n");
  // If the source ends with `\n`, `split` produces a trailing empty
  // string.  Drop it so `lines.length` matches the number of source
  // lines — matching Rust's `str::lines` and the writer's
  // `paths.dat` Layout A line counts.
  if (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts.map((p) => (p.endsWith("\r") ? p.slice(0, -1) : p));
}

/**
 * Extract identifier-like tokens from a single line — used by both
 * the anchor-index builder and the per-formatted-line lookup in
 * {@link generateInverseSourceMap}.
 *
 * Returned tokens are at least 3 chars long, made up entirely of
 * `[A-Za-z0-9_$]`, and exclude common keywords (mirrors the replay-
 * server's `is_common_keyword` list — see
 * `db-backend/autoformat.rs::is_common_keyword`).  Skipping common
 * keywords prevents `var`, `return`, etc. from anchoring random lines
 * (they occur on dozens of lines in a typical bundle and would pick
 * the first occurrence rather than the matching one).
 */
function identifierTokens(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line.charCodeAt(i);
    const isIdent =
      (ch >= 0x30 && ch <= 0x39) || // 0-9
      (ch >= 0x41 && ch <= 0x5a) || // A-Z
      (ch >= 0x61 && ch <= 0x7a) || // a-z
      ch === 0x5f /* _ */ ||
      ch === 0x24; /* $ */
    if (isIdent) {
      current += line[i];
    } else {
      if (current.length >= 3 && !COMMON_KEYWORDS.has(current)) {
        tokens.push(current);
      }
      current = "";
    }
  }
  if (current.length >= 3 && !COMMON_KEYWORDS.has(current)) {
    tokens.push(current);
  }
  return tokens;
}

/**
 * Common JS / TS / Python keywords that occur too often to anchor a
 * line uniquely.  Matches the replay-server's `is_common_keyword`
 * list so the recorder's pre-format and the lazy fallback agree on
 * the anchor selection (load-bearing for round-trip consistency).
 */
const COMMON_KEYWORDS = new Set([
  "var",
  "let",
  "const",
  "function",
  "return",
  "if",
  "else",
  "for",
  "while",
  "do",
  "switch",
  "case",
  "default",
  "break",
  "continue",
  "this",
  "new",
  "delete",
  "typeof",
  "instanceof",
  "void",
  "null",
  "true",
  "false",
  "import",
  "export",
  "from",
  "class",
  "extends",
  "super",
  "static",
  "async",
  "await",
  "yield",
  "try",
  "catch",
  "finally",
  "throw",
  "def",
  "lambda",
  "pass",
  "and",
  "not",
  "with",
]);

/**
 * Encode an array-of-arrays of segments into the Source Map V3 VLQ
 * `mappings` field.
 *
 * Each line's segments are encoded relative to the previous segment
 * (deltas), and lines are separated by `;`.  Within a line, segments
 * are separated by `,`.
 *
 * We do this by hand rather than depending on `@jridgewell/gen-mapping`
 * to keep the bundle slim — the inverse sourcemap is line-level only,
 * so a 4-field VLQ segment is all we need.  See
 * <https://sourcemaps.info/spec.html#h.lmz475t4mvbx> for the wire
 * format.
 */
function encodeMappings(
  lines: Array<Array<[number, number, number, number]>>,
): string {
  let prevSrcIdx = 0;
  let prevOrigLine = 0;
  let prevOrigCol = 0;
  const out: string[] = [];
  for (const lineSegs of lines) {
    let prevGenCol = 0;
    const segParts: string[] = [];
    for (const [genCol, srcIdx, origLine, origCol] of lineSegs) {
      const part =
        encodeVlq(genCol - prevGenCol) +
        encodeVlq(srcIdx - prevSrcIdx) +
        encodeVlq(origLine - prevOrigLine) +
        encodeVlq(origCol - prevOrigCol);
      segParts.push(part);
      prevGenCol = genCol;
      prevSrcIdx = srcIdx;
      prevOrigLine = origLine;
      prevOrigCol = origCol;
    }
    out.push(segParts.join(","));
  }
  return out.join(";");
}

/**
 * Encode a single signed integer as Source Map V3 base64 VLQ.
 *
 * The encoding stores the sign bit as the least-significant bit of
 * the first 5-bit group and uses the continuation bit (bit 5) to
 * signal more groups.  Reference: V3 spec §"Base 64 VLQ".
 */
function encodeVlq(value: number): string {
  let vlq = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = "";
  do {
    let digit = vlq & 0x1f;
    vlq >>>= 5;
    if (vlq > 0) digit |= 0x20;
    out += BASE64_ALPHABET[digit];
  } while (vlq > 0);
  return out;
}

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * High-level entry point used by the `record` command.
 *
 * Behaviour:
 *
 *  - If `enabled === false` (CLI's `--no-autoformat` or
 *    `CT_AUTOFORMAT=off`): returns `{ kind: "skipped" }` — caller
 *    keeps the original source.
 *  - If the source does not look minified: returns
 *    `{ kind: "not-minified" }`.
 *  - If prettier is not on PATH: returns `{ kind: "tool-missing" }`
 *    — caller logs a warning and falls through.
 *  - If prettier errored / timed out: returns
 *    `{ kind: "tool-error", message }`.
 *  - If the output is no shorter than the input (prettier didn't
 *    actually break the line up): returns `{ kind: "no-change" }`.
 *    This guards against pre-formatted "minified-looking" files that
 *    are simply long single-line JSON-encoded blobs that prettier
 *    doesn't touch.
 *  - Otherwise returns `{ kind: "ok", formatted, sourceMap }` — caller
 *    materialises both, updates the manifest path to reference the
 *    formatted file, and proceeds with instrumentation against the
 *    formatted view.
 *
 * The `originalName` parameter is used both for prettier's
 * `--stdin-filepath` (parser inference) and as the `sources[0]` entry
 * in the generated sourcemap.
 */
export type AutoformatOutcome =
  | { kind: "skipped" }
  | { kind: "not-minified" }
  | { kind: "tool-missing" }
  | { kind: "tool-error"; message: string }
  | { kind: "no-change" }
  | {
      kind: "ok";
      /** Prettier's stdout — the formatted source. */
      formatted: string;
      /** Source Map V3 JSON document (parsed). */
      sourceMap: ReturnType<typeof generateInverseSourceMap>;
    };

export interface AutoformatOptions {
  /**
   * Master enable / disable switch.  Defaults to `true`; the CLI's
   * `--no-autoformat` flag passes `false`.  When `false`, returns
   * `{ kind: "skipped" }` without reading any environment.
   */
  enabled?: boolean;
  /**
   * Heuristic threshold override.  Defaults to
   * {@link DEFAULT_MINIFIED_THRESHOLD}.  Mirrors
   * `CT_AUTOFORMAT_THRESHOLD` on the replay-server side.
   */
  threshold?: number;
}

export function tryAutoformat(
  content: string,
  originalName: string,
  opts: AutoformatOptions = {},
): AutoformatOutcome {
  const enabled = opts.enabled ?? autoformatEnabledByEnv();
  if (!enabled) return { kind: "skipped" };

  const threshold =
    opts.threshold ?? thresholdFromEnv() ?? DEFAULT_MINIFIED_THRESHOLD;
  if (!looksMinified(content, threshold)) {
    return { kind: "not-minified" };
  }

  const outcome = runPrettier(content, originalName);
  if (outcome.kind === "missing") return { kind: "tool-missing" };
  if (outcome.kind === "timeout") {
    return { kind: "tool-error", message: "prettier timed out" };
  }
  if (outcome.kind === "error") {
    return { kind: "tool-error", message: outcome.message };
  }

  const formatted = outcome.stdout;
  // Guard: if prettier didn't actually break the source up (same line
  // count), don't claim success — the trace would carry a redundant
  // copy and a degenerate sourcemap.  Tests assert STRICT inequality.
  const origLineCount = splitLines(content).length;
  const fmtLineCount = splitLines(formatted).length;
  if (fmtLineCount <= origLineCount) {
    return { kind: "no-change" };
  }

  const sourceMap = generateInverseSourceMap(content, formatted, originalName);
  return { kind: "ok", formatted, sourceMap };
}

/**
 * Read `CT_AUTOFORMAT_THRESHOLD` and parse it as a positive integer.
 * Returns `undefined` on unset / unparseable values; mirrors the
 * replay-server's `minified_threshold` helper so both sides agree on
 * the env-driven threshold.
 */
function thresholdFromEnv(): number | undefined {
  const raw = process.env.CT_AUTOFORMAT_THRESHOLD;
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

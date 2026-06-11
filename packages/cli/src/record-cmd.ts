/**
 * CLI `record` command implementation.
 *
 * Usage: codetracer-js-recorder record <file> [-o|--out-dir <dir>] [-- app-args...]
 *
 * 1. Instruments the entry file (and directory siblings if entry is a dir).
 * 2. Creates a temp directory with:
 *    - Instrumented source code
 *    - codetracer.manifest.json
 *    - __ct_runner.js — a bootstrap script that sets up the runtime + addon
 * 3. Executes __ct_runner.js with Node.js as a child process.
 * 4. Reports the trace directory path on completion.
 *
 * The recorder always writes the canonical CTFS multi-stream container into
 * --out-dir.  There is no `--format` flag and no `CODETRACER_FORMAT` env
 * var — see codetracer-specs/Recorder-CLI-Conventions.md §4.  For
 * human-readable conversion of the produced bundle, use `ct print` from
 * codetracer-trace-format-nim.
 *
 * Environment variables (per Recorder-CLI-Conventions.md §5):
 *   CODETRACER_JS_RECORDER_OUT_DIR    Fallback for --out-dir.
 *   CODETRACER_JS_RECORDER_DISABLED   When set to "1" / "true", skip recording
 *                                     entirely and exit 0 without running the
 *                                     target program.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import {
  instrument,
  shouldInstrument,
  tryAutoformat,
} from "@codetracer/instrumenter";
import type {
  ManifestSlice,
  FunctionEntry,
  SiteEntry,
  FilterOptions,
  AutoformatOutcome,
} from "@codetracer/instrumenter";

/**
 * Recursively collect all instrumentable files under a directory.
 *
 * Uses glob-based include/exclude filtering via picomatch.
 * By default, includes all JS/TS files and excludes node_modules.
 */
function collectFiles(dir: string, filterOpts?: FilterOptions): string[] {
  const results: string[] = [];

  function walk(current: string): void {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        // Use relative path for glob matching
        const relPath = path.relative(dir, fullPath);
        if (shouldInstrument(relPath, filterOpts)) {
          results.push(fullPath);
        }
      }
    }
  }

  walk(dir);
  return results;
}

/**
 * Merge multiple manifest slices into a single manifest, re-indexing
 * paths, functions, and sites so IDs are globally unique.
 */
function mergeManifestSlices(
  slices: Array<{ slice: ManifestSlice; originalFile: string }>,
): {
  paths: string[];
  functions: FunctionEntry[];
  sites: SiteEntry[];
  sourcesContent?: Record<string, string>;
  lineLengths?: Record<string, number[]>;
} {
  const paths: string[] = [];
  const functions: FunctionEntry[] = [];
  const sites: SiteEntry[] = [];
  const sourcesContent: Record<string, string> = {};
  // P2.3: merged per-source line-length tables keyed by source path
  // (mirror of instrument-cmd.ts).  The native addon ships these
  // through `register_path_with_line_lengths` so the CTFS writer's
  // `paths.dat` carries the Layout A line-length record.
  const lineLengths: Record<string, number[]> = {};

  const globalPathMap = new Map<string, number>();

  for (const { slice } of slices) {
    const localToGlobal: number[] = [];
    for (const p of slice.paths) {
      let globalIdx = globalPathMap.get(p);
      if (globalIdx === undefined) {
        globalIdx = paths.length;
        paths.push(p);
        globalPathMap.set(p, globalIdx);
      }
      localToGlobal.push(globalIdx);
    }

    const fnIdOffset = functions.length;
    for (const fn of slice.functions) {
      functions.push({
        ...fn,
        pathIndex: localToGlobal[fn.pathIndex],
      });
    }

    for (const site of slice.sites) {
      const reindexed: SiteEntry = {
        ...site,
        pathIndex: localToGlobal[site.pathIndex],
      };
      if (reindexed.fnId !== undefined) {
        reindexed.fnId = reindexed.fnId + fnIdOffset;
      }
      sites.push(reindexed);
    }

    // Merge sourcesContent
    if (slice.sourcesContent) {
      for (const [key, value] of Object.entries(slice.sourcesContent)) {
        sourcesContent[key] = value;
      }
    }

    // P2.3: merge per-source line-length tables.  First slice wins on
    // duplicate keys — re-instrumenting the same file always produces
    // the same byte counts, so the choice is inert.
    if (slice.lineLengths) {
      for (const [key, value] of Object.entries(slice.lineLengths)) {
        if (!(key in lineLengths)) {
          lineLengths[key] = value.slice();
        }
      }
    }
  }

  const result: {
    paths: string[];
    functions: FunctionEntry[];
    sites: SiteEntry[];
    sourcesContent?: Record<string, string>;
    lineLengths?: Record<string, number[]>;
  } = { paths, functions, sites };

  if (Object.keys(sourcesContent).length > 0) {
    result.sourcesContent = sourcesContent;
  }
  if (Object.keys(lineLengths).length > 0) {
    result.lineLengths = lineLengths;
  }

  return result;
}

/**
 * Parse command-line arguments for the record command.
 *
 * Output-directory resolution order (per Recorder-CLI-Conventions.md §5):
 *   1. `--out-dir` / `-o` CLI flag (highest precedence)
 *   2. `CODETRACER_JS_RECORDER_OUT_DIR` env var
 *   3. `./ct-traces/` (default)
 *
 * Unknown flags (including the now-removed `--format`) are rejected with a
 * "unexpected argument" diagnostic so accidental use of legacy invocations
 * fails loudly rather than silently being interpreted as the entry file.
 */
function parseArgs(args: string[]): {
  entryFile: string;
  outDir: string;
  appArgs: string[];
  include: string[];
  exclude: string[];
  /**
   * P2.6: opt the writer into column-aware step encoding.  Defaults to
   * `true` per the milestone spec — pass `--no-column-aware` to fall
   * back to line-only step encoding.
   */
  columnAware: boolean;
  /**
   * P6.2: enable / disable recorder-side autoformat of minified
   * sources.  Defaults to `true`; `--no-autoformat` disables.  Also
   * respects the `CT_AUTOFORMAT` env var (shared with replay-server,
   * see `db-backend/autoformat.rs::autoformat_enabled`).
   */
  autoformat: boolean;
} {
  let entryFile: string | undefined;
  let outDirFromFlag: string | undefined;
  const appArgs: string[] = [];
  const include: string[] = [];
  const exclude: string[] = [];
  let seenDashDash = false;
  // P2.6: column-aware step encoding defaults ON.  The companion
  // `--no-column-aware` flag forces the legacy line-only path for
  // bisection / back-compat testing.
  let columnAware = true;
  // P6.2: recorder-side autoformat defaults ON; `--no-autoformat`
  // disables.  When disabled, minified sources are recorded as-is
  // and the replay-server's lazy P4 fallback formats them at view
  // time (slower but still correct).
  let autoformat = true;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (seenDashDash) {
      appArgs.push(arg);
      continue;
    }

    if (arg === "--") {
      seenDashDash = true;
      continue;
    }

    if ((arg === "--out-dir" || arg === "-o") && i + 1 < args.length) {
      outDirFromFlag = args[++i];
    } else if (arg === "--include" && i + 1 < args.length) {
      include.push(args[++i]);
    } else if (arg === "--exclude" && i + 1 < args.length) {
      exclude.push(args[++i]);
    } else if (arg === "--column-aware") {
      columnAware = true;
    } else if (arg === "--no-column-aware") {
      columnAware = false;
    } else if (arg === "--autoformat") {
      autoformat = true;
    } else if (arg === "--no-autoformat") {
      autoformat = false;
    } else if (arg === "--help" || arg === "-h") {
      // Per Recorder-CLI-Conventions.md §4 the recorder is CTFS-only:
      // there is no `--format` flag and no `CODETRACER_FORMAT` env var.
      // Use `ct print` from codetracer-trace-format-nim to convert the
      // produced .ct bundle to JSON / text.
      console.log(
        `Usage: codetracer-js-recorder record <file> [-o|--out-dir <dir>] [--include <glob>] [--exclude <glob>] [--no-column-aware] [--no-autoformat] [-- app-args...]

Options:
  -o, --out-dir <dir>     Trace output directory (default: ./ct-traces/)
  --include <glob>        Include glob pattern (repeatable)
  --exclude <glob>        Exclude glob pattern (repeatable)
  --column-aware          Emit column-aware step encoding (default: on)
  --no-column-aware       Fall back to line-only step encoding
  --autoformat            Pre-format minified sources at record time (default: on)
  --no-autoformat         Record minified sources unformatted (replay-server
                          P4 fallback formats them at view time instead)

Environment variables:
  CODETRACER_JS_RECORDER_OUT_DIR    Output directory (overridden by --out-dir)
  CODETRACER_JS_RECORDER_DISABLED   Set to "true" / "1" to disable recording
  CT_AUTOFORMAT                     Set to 0/off/false/no to disable autoformat
                                    (shared with replay-server's P4 fallback)
  CT_AUTOFORMAT_THRESHOLD           Override the minified-line-length heuristic
                                    threshold (default 500 chars/line)

The recorder always writes the canonical CTFS multi-stream container.
Use 'ct print' from codetracer-trace-format-nim for human-readable
JSON / text conversion of the produced bundle.`,
      );
      process.exit(0);
    } else if (!entryFile && !arg.startsWith("-")) {
      entryFile = arg;
    } else if (arg.startsWith("-")) {
      // Reject unknown flags loudly — protects the CTFS-only contract by
      // preventing the legacy `--format` from being silently consumed as
      // the positional <file> argument.
      console.error(
        `Error: unexpected argument '${arg}' (use --help for usage).`,
      );
      process.exit(2);
    }
  }

  if (!entryFile) {
    console.error("Error: <file> argument is required.");
    process.exit(1);
  }

  // Resolve --out-dir with env-var fallback per convention §5.
  const envOutDir = process.env.CODETRACER_JS_RECORDER_OUT_DIR;
  const outDir =
    outDirFromFlag ??
    (envOutDir && envOutDir.length > 0 ? envOutDir : "./ct-traces/");

  return {
    entryFile: entryFile!,
    outDir,
    appArgs,
    include,
    exclude,
    columnAware,
    autoformat,
  };
}

/**
 * Generate the runner script content.
 *
 * The runner is a standalone CommonJS script that:
 * 1. Loads the native addon
 * 2. Reads the manifest
 * 3. Starts recording via the addon
 * 4. Sets up globalThis.__ct to buffer events and forward to the addon
 * 5. Requires the instrumented entry file
 * 6. Flushes and stops on process exit
 */
function generateRunner(opts: {
  addonPath: string;
  manifestPath: string;
  instrumentedEntry: string;
  outDir: string;
  program: string;
  appArgs: string[];
  /**
   * P2.6: when true, the recorder emits column-aware step events
   * (CTFS `DeltaColumn` tag 0x07 + `paths.dat` Layout A line-length
   * tables).  Mirrors the `--column-aware` / `--no-column-aware` CLI
   * flag.
   */
  columnAware: boolean;
}): string {
  // Escape paths for embedding in JS strings (handle backslashes on Windows)
  const esc = (s: string) => JSON.stringify(s);

  // The recorder always writes CTFS — no `format` parameter is passed to
  // the addon (see Recorder-CLI-Conventions.md §4).
  return `// Auto-generated CodeTracer runner script.
// This file is created by "codetracer-js-recorder record" and is not meant to be edited.
"use strict";

var addon = require(${esc(opts.addonPath)});
var fs = require("fs");
var async_hooks = require("async_hooks");

// Read the manifest
var manifestJson = fs.readFileSync(${esc(opts.manifestPath)}, "utf-8");
var manifest = JSON.parse(manifestJson);

// Start recording
var handle = addon.startRecording({
  outDir: ${esc(opts.outDir)},
  program: ${esc(opts.program)},
  args: ${JSON.stringify(opts.appArgs)},
  manifestJson: manifestJson,
  columnAware: ${JSON.stringify(opts.columnAware)},
});

// Deep value encoding with depth/circular/size limits
var MAX_STRING_LENGTH = 1000;
var DEFAULT_MAX_DEPTH = 5;
var DEFAULT_MAX_SIZE = 100;

function encodeValue(value, depth, seen) {
  if (depth === undefined) depth = 0;
  if (seen === undefined) seen = new WeakSet();
  try {
    if (value === undefined) return { value: null, typeKind: "None" };
    if (value === null) return { value: null, typeKind: "None" };
    switch (typeof value) {
      case "boolean": return { value: value, typeKind: "Bool" };
      case "number":
        if (value !== value) return { value: "NaN", typeKind: "Raw" };
        if (!isFinite(value)) return { value: value > 0 ? "Infinity" : "-Infinity", typeKind: "Raw" };
        if (Number.isInteger(value)) return { value: value, typeKind: "Int" };
        return { value: value, typeKind: "Float" };
      case "string":
        return { value: value.length > MAX_STRING_LENGTH ? value.slice(0, MAX_STRING_LENGTH) : value, typeKind: "String" };
      case "bigint": return { value: value.toString(), typeKind: "BigInt" };
      case "symbol": return { value: value.toString(), typeKind: "Raw" };
      case "function": return { value: value.name || "anonymous", typeKind: "FunctionKind" };
      case "object": {
        if (seen.has(value)) return { value: "[circular]", typeKind: "Raw" };
        if (depth >= DEFAULT_MAX_DEPTH) return { value: "[depth limit]", typeKind: "Raw" };
        seen.add(value);
        try {
          if (value instanceof Date) return { value: value.toISOString(), typeKind: "Raw" };
          if (value instanceof RegExp) return { value: value.toString(), typeKind: "Raw" };
          if (value instanceof Error) return { value: value.message, typeKind: "Error" };
          if (Array.isArray(value)) {
            var total = value.length;
            var limit = Math.min(total, DEFAULT_MAX_SIZE);
            var elements = [];
            for (var i = 0; i < limit; i++) elements.push(encodeValue(value[i], depth + 1, seen));
            if (total > DEFAULT_MAX_SIZE) elements.push({ value: "[... " + (total - DEFAULT_MAX_SIZE) + " more]", typeKind: "Raw" });
            return { value: elements, typeKind: "Seq" };
          }
          if (value instanceof Map) {
            var mapTotal = value.size;
            var mapLimit = Math.min(mapTotal, DEFAULT_MAX_SIZE);
            var mapEntries = [];
            var mapCount = 0;
            value.forEach(function(v, k) {
              if (mapCount < mapLimit) {
                mapEntries.push({ key: encodeValue(k, depth + 1, seen), value: encodeValue(v, depth + 1, seen) });
                mapCount++;
              }
            });
            if (mapTotal > DEFAULT_MAX_SIZE) mapEntries.push({ key: { value: "[... " + (mapTotal - DEFAULT_MAX_SIZE) + " more]", typeKind: "Raw" }, value: { value: null, typeKind: "None" } });
            return { value: mapEntries, typeKind: "TableKind" };
          }
          if (value instanceof Set) {
            var setTotal = value.size;
            var setLimit = Math.min(setTotal, DEFAULT_MAX_SIZE);
            var setElements = [];
            var setCount = 0;
            value.forEach(function(v) {
              if (setCount < setLimit) {
                setElements.push(encodeValue(v, depth + 1, seen));
                setCount++;
              }
            });
            if (setTotal > DEFAULT_MAX_SIZE) setElements.push({ value: "[... " + (setTotal - DEFAULT_MAX_SIZE) + " more]", typeKind: "Raw" });
            return { value: setElements, typeKind: "Set" };
          }
          // Plain object
          var keys;
          try { keys = Object.keys(value); } catch(e) { return { value: "[object]", typeKind: "Raw" }; }
          var objTotal = keys.length;
          var objLimit = Math.min(objTotal, DEFAULT_MAX_SIZE);
          var fields = [];
          for (var j = 0; j < objLimit; j++) {
            var k = keys[j];
            var v;
            try { v = value[k]; } catch(e) { v = "[access error]"; }
            fields.push({ name: k, value: encodeValue(v, depth + 1, seen) });
          }
          if (objTotal > DEFAULT_MAX_SIZE) fields.push({ name: "[... " + (objTotal - DEFAULT_MAX_SIZE) + " more]", value: { value: null, typeKind: "None" } });
          return { value: { fields: fields }, typeKind: "Struct" };
        } finally {
          seen.delete(value);
        }
      }
      default: return { value: typeof value, typeKind: "Raw" };
    }
  } catch(e) {
    return { value: "[encoding error]", typeKind: "Raw" };
  }
}

// Event buffer (typed arrays for performance)
var BUFFER_CAPACITY = 4096;
var eventKinds = new Uint8Array(BUFFER_CAPACITY);
var ids = new Uint32Array(BUFFER_CAPACITY);
var bufLen = 0;
var valueEntries = [];

var writeEntries = [];

function flushBuffer() {
  if (bufLen === 0) return;
  try {
    var valuesJson = valueEntries.length > 0 ? JSON.stringify(valueEntries) : "[]";
    var writesJson = writeEntries.length > 0 ? JSON.stringify(writeEntries) : "[]";
    addon.appendEvents(handle, eventKinds.slice(0, bufLen), ids.slice(0, bufLen), valuesJson, writesJson);
  } catch(e) {
    process.stderr.write("[codetracer] Warning: failed to append events: " + e + "\\n");
  }
  bufLen = 0;
  valueEntries = [];
  writeEntries = [];
}

function pushEvent(kind, id) {
  eventKinds[bufLen] = kind;
  ids[bufLen] = id;
  bufLen++;
  if (bufLen >= BUFFER_CAPACITY) {
    flushBuffer();
  }
}

// Async context tracking via async_hooks.executionAsyncId()
// Install a minimal async hook so executionAsyncId() returns meaningful values
// after async boundaries. Without this, all async continuations return 0.
var _asyncHook = async_hooks.createHook({ init: function() {} });
_asyncHook.enable();

var _knownContexts = {};
var _lastCtxId = 0;

// Initialize with the current context
var _initialCtxId = async_hooks.executionAsyncId();
_knownContexts[_initialCtxId] = true;
pushEvent(4, _initialCtxId); // EVENT_THREAD_START
_lastCtxId = _initialCtxId;

function checkAsyncContext() {
  var ctxId = async_hooks.executionAsyncId();
  if (ctxId !== _lastCtxId) {
    if (!_knownContexts[ctxId]) {
      _knownContexts[ctxId] = true;
      pushEvent(4, ctxId); // EVENT_THREAD_START
    }
    pushEvent(5, ctxId); // EVENT_THREAD_SWITCH
    _lastCtxId = ctxId;
  }
}

// Set up globalThis.__ct
globalThis.__ct = {
  step: function(siteId) {
    try { checkAsyncContext(); pushEvent(0, siteId); } catch(e) {}
  },
  enter: function(fnId, argsLike) {
    try {
      checkAsyncContext();
      pushEvent(1, fnId);
      var encodedArgs = [];
      for (var i = 0; i < argsLike.length; i++) {
        encodedArgs.push(encodeValue(argsLike[i]));
      }
      valueEntries.push({ eventIndex: bufLen - 1, args: encodedArgs });
    } catch(e) {}
  },
  ret: function(fnId, value) {
    try {
      checkAsyncContext();
      pushEvent(2, fnId);
      valueEntries.push({ eventIndex: bufLen - 1, returnValue: encodeValue(value) });
    } catch(e) {}
    return value;
  },
  // M16a: synthetic per-assignment write event emitted by the
  // instrumenter (see packages/instrumenter/src/visitor.ts).  Event
  // type 7 = EVENT_ASSIGNMENT (distinct from the IO EVENT_WRITE at
  // event type 3 used for stdout / stderr captures and from the
  // EVENT_THREAD_* events at 4-6).  Kept side-effect-free so it
  // never disrupts the instrumented program if the runtime is
  // partially initialised.
  write: function(siteId) {
    try { checkAsyncContext(); pushEvent(7, siteId); } catch(e) {}
  },
};

// Install console capture for IO recording
var _origLog = console.log;
var _origInfo = console.info;
var _origWarn = console.warn;
var _origError = console.error;

function _formatArgs(args) {
  return Array.prototype.map.call(args, function(a) {
    return typeof a === "string" ? a : String(a);
  }).join(" ");
}

console.log = function() {
  _origLog.apply(console, arguments);
  try {
    pushEvent(3, 0);
    writeEntries.push({ eventIndex: bufLen - 1, kind: "stdout", content: _formatArgs(arguments) });
  } catch(e) {}
};
console.info = function() {
  _origInfo.apply(console, arguments);
  try {
    pushEvent(3, 0);
    writeEntries.push({ eventIndex: bufLen - 1, kind: "stdout", content: _formatArgs(arguments) });
  } catch(e) {}
};
console.warn = function() {
  _origWarn.apply(console, arguments);
  try {
    pushEvent(3, 0);
    writeEntries.push({ eventIndex: bufLen - 1, kind: "stderr", content: _formatArgs(arguments) });
  } catch(e) {}
};
console.error = function() {
  _origError.apply(console, arguments);
  try {
    pushEvent(3, 0);
    writeEntries.push({ eventIndex: bufLen - 1, kind: "stderr", content: _formatArgs(arguments) });
  } catch(e) {}
};

// Register exit handler to flush and stop
var stopped = false;
process.on("exit", function() {
  if (!stopped) {
    stopped = true;
    // Disable async hook
    _asyncHook.disable();
    // Restore original console methods
    console.log = _origLog;
    console.info = _origInfo;
    console.warn = _origWarn;
    console.error = _origError;
    try {
      flushBuffer();
      var traceDir = addon.flushAndStop(handle);
      // Write trace dir path to a marker file so the parent process can read it
      var markerPath = ${esc(opts.manifestPath)}.replace("codetracer.manifest.json", "__ct_trace_dir.txt");
      fs.writeFileSync(markerPath, traceDir);
    } catch(e) {
      process.stderr.write("[codetracer] Warning: failed to finalize trace: " + e + "\\n");
    }
  }
});

// Run the instrumented entry file
require(${esc(opts.instrumentedEntry)});
`;
}

/**
 * Returns true when CODETRACER_JS_RECORDER_DISABLED is set to a truthy
 * value ("1" or "true", case-insensitive).  Per
 * Recorder-CLI-Conventions.md §5 this skips trace emission entirely
 * but still runs the target program (so a CI pipeline that opts out of
 * recording still sees the program's exit code and stdout/stderr —
 * mirrors the Python / Ruby runtime-disable semantics).  We achieve
 * that by spawning the target via `node` directly without
 * instrumentation, rather than going through the instrument →
 * runner-script pipeline.
 */
function recordingDisabledByEnv(): boolean {
  const v = process.env.CODETRACER_JS_RECORDER_DISABLED;
  if (!v) return false;
  const lc = v.toLowerCase();
  return lc === "1" || lc === "true";
}

/**
 * Entry point for the `record` command.
 */
export function recordCommand(args: string[]): void {
  const {
    entryFile,
    outDir,
    appArgs,
    include,
    exclude,
    columnAware,
    autoformat,
  } = parseArgs(args);

  if (recordingDisabledByEnv()) {
    // §5: when recording is disabled via env, the recorder must not
    // write any trace artefacts but should still run the target
    // program (so CI pipelines that opt out still see the program's
    // exit code, stdout and stderr).  We bypass the instrument →
    // runner-script pipeline and exec the program directly via Node,
    // mirroring `node <entry> <appArgs...>`.
    const directPath = path.resolve(entryFile);
    if (!fs.existsSync(directPath)) {
      console.error(`Error: entry file '${directPath}' does not exist.`);
      process.exit(1);
    }
    process.stderr.write(
      "[codetracer-js-recorder] recording disabled by CODETRACER_JS_RECORDER_DISABLED — running target without instrumentation\n",
    );
    try {
      execFileSync(process.execPath, [directPath, ...appArgs], {
        stdio: "inherit",
        cwd: process.cwd(),
        env: process.env,
      });
      process.exit(0);
    } catch (err: unknown) {
      const exitErr = err as { status?: number };
      process.exit(exitErr.status ?? 0);
    }
  }

  const entryPath = path.resolve(entryFile);
  if (!fs.existsSync(entryPath)) {
    console.error(`Error: entry file '${entryPath}' does not exist.`);
    process.exit(1);
  }

  const stat = fs.statSync(entryPath);
  const isDir = stat.isDirectory();

  // Build filter options from CLI flags
  const filterOpts: FilterOptions | undefined =
    include.length > 0 || exclude.length > 0
      ? {
          ...(include.length > 0 ? { include } : {}),
          ...(exclude.length > 0 ? { exclude } : {}),
        }
      : undefined;

  // Collect files to instrument
  let files: string[];
  let baseDir: string;
  let mainEntry: string;

  if (isDir) {
    baseDir = entryPath;
    files = collectFiles(entryPath, filterOpts);
    // Look for index.js or index.ts as entry point
    const indexFile = files.find(
      (f) => path.basename(f) === "index.js" || path.basename(f) === "index.ts",
    );
    if (!indexFile) {
      console.error("Error: no index.js or index.ts found in the directory.");
      process.exit(1);
    }
    mainEntry = indexFile!;
  } else {
    baseDir = path.dirname(entryPath);
    files = [entryPath];
    mainEntry = entryPath;
  }

  // Create temp directory for instrumented output
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-record-"));

  try {
    // Instrument each file.  For files that look minified, run the
    // P6.2 recorder-side autoformat first so the trace records
    // positions on the formatted view instead of the gibberish
    // single-line bundle.  See `packages/instrumenter/src/autoformat.ts`
    // for the heuristic + prettier wiring.
    const slices: Array<{ slice: ManifestSlice; originalFile: string }> = [];
    // P6.2: per-file autoformat artefacts, keyed by the *virtual*
    // filename that the manifest will reference (`<file>.fmt.js`).
    // Each entry carries the formatted source + the V3 sourcemap
    // (formatted → original) that the native addon materialises as
    // sidecars under `<trace>/files/`.  Replay-server's P3 path
    // discovers the `.map` sibling automatically.
    const formattedSiblings: Array<{
      virtualPath: string;
      formattedContent: string;
      sourceMapJson: string;
    }> = [];
    // Tracks whether we already warned the user that prettier is
    // missing.  We only emit one warning per record() invocation so
    // a bundle with dozens of minified files doesn't drown the
    // console in identical messages.
    let prettierMissingWarned = false;

    for (const file of files) {
      const relPath = path.relative(baseDir, file);
      const originalCode = fs.readFileSync(file, "utf-8");

      // P6.2 — recorder-side autoformat hook.  We run *before* the
      // instrumenter so the SWC pass sees the formatted view; that
      // way the manifest's column offsets land at sensible columns
      // in the formatted source instead of all clustering at column
      // 1 of the single minified line.
      let codeToInstrument = originalCode;
      let instrumentFilename = path.resolve(file);
      // The instrumented output is always emitted at `<tmpDir>/<relPath>`
      // (the original filename) so `require()` calls in sibling
      // instrumented files resolve cleanly.  When autoformat fires
      // we only change the *manifest* virtual path — not the file
      // on disk.
      const outFilePath = path.join(tmpDir, relPath);
      const baseName = path.basename(file);

      // P6.2 follow-up: if the source already ships with an adjacent
      // `<file>.map` sourcemap, the upstream toolchain already knows
      // how to map positions on this (possibly minified) view back to
      // the original sources.  Recorder-side autoformat would replace
      // that mapping with our line-level inverse, which is a strict
      // downgrade.  Skip and let the replay-server's existing P3
      // sourcemap discovery use the upstream `.map` sibling directly.
      const siblingMapPath = file + ".map";
      const hasSiblingMap =
        autoformat && fs.existsSync(siblingMapPath);

      if (autoformat && !hasSiblingMap) {
        const outcome: AutoformatOutcome = tryAutoformat(
          originalCode,
          baseName,
          { enabled: true },
        );

        if (outcome.kind === "ok") {
          // The instrumenter sees the formatted code; the manifest's
          // path entry uses a `.fmt.js`-suffixed virtual filename so
          // recorded steps reference the sibling we materialise into
          // `<trace>/files/<virtualPath>` + its V3 sourcemap.  The
          // emitted instrumented file on disk keeps its original
          // name so `require()` from sibling instrumented files
          // resolves correctly.
          const virtualPath = `${path.resolve(file)}.fmt.js`;
          codeToInstrument = outcome.formatted;
          instrumentFilename = virtualPath;

          formattedSiblings.push({
            virtualPath,
            formattedContent: outcome.formatted,
            sourceMapJson: JSON.stringify(outcome.sourceMap),
          });

          process.stderr.write(
            `[codetracer-js-recorder] autoformat: pre-formatted minified source '${baseName}' (` +
              `${originalCode.length} → ${outcome.formatted.length} bytes)\n`,
          );
        } else if (outcome.kind === "tool-missing") {
          if (!prettierMissingWarned) {
            process.stderr.write(
              "[codetracer-js-recorder] autoformat: prettier not found on PATH — minified sources will display unformatted (replay-server P4 fallback will format at view time)\n",
            );
            prettierMissingWarned = true;
          }
        } else if (outcome.kind === "tool-error") {
          process.stderr.write(
            `[codetracer-js-recorder] autoformat: prettier failed for '${baseName}': ${outcome.message} — recording original source\n`,
          );
        }
        // "skipped", "not-minified", "no-change" — silent: these
        // are the steady-state outcomes for normal source files.
      }

      try {
        const result = instrument(codeToInstrument, {
          filename: instrumentFilename,
        });

        // Write instrumented code
        const outFileDir = path.dirname(outFilePath);
        fs.mkdirSync(outFileDir, { recursive: true });
        fs.writeFileSync(outFilePath, result.code);

        slices.push({ slice: result.manifestSlice, originalFile: file });
      } catch (err) {
        console.error(`Warning: failed to instrument '${file}': ${err}`);
      }
    }

    if (slices.length === 0) {
      console.error("Error: no files were successfully instrumented.");
      process.exit(1);
    }

    // Merge manifests and write
    const merged = mergeManifestSlices(slices);
    // P6.2 — extra files materialised by the native addon under
    // `<trace>/files/`.  The first entry per pair is the formatted
    // source itself (so the UI's filesystem reader serves it as
    // `<virtual-path>`); the second is the V3 sourcemap sibling
    // (`<virtual-path>.map`) that the replay-server discovers via
    // the existing P3 sibling-lookup path.
    //
    // Keying by absolute virtual path mirrors how
    // `manifest.paths` is keyed — the native addon shares the same
    // "strip leading drive letter / slash, join under files/" logic
    // for both lists.
    const extraFiles: Record<string, string> = {};
    for (const sib of formattedSiblings) {
      extraFiles[sib.virtualPath] = sib.formattedContent;
      extraFiles[`${sib.virtualPath}.map`] = sib.sourceMapJson;
    }
    const manifest: Record<string, unknown> = {
      formatVersion: 1,
      ...merged,
    };
    if (Object.keys(extraFiles).length > 0) {
      manifest.extraFiles = extraFiles;
    }
    const manifestPath = path.join(tmpDir, "codetracer.manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    // Resolve the native addon path
    const addonPath = path.resolve(
      __dirname,
      "..",
      "..",
      "..",
      "crates",
      "recorder_native",
      "index.node",
    );
    if (!fs.existsSync(addonPath)) {
      console.error(
        `Error: native addon not found at '${addonPath}'. Run 'just build-native' first.`,
      );
      process.exit(1);
    }

    // Resolve output directory for traces
    const traceOutDir = path.resolve(outDir);

    // Determine the instrumented entry file path.  The instrumented
    // output keeps the original filename (autoformat only changes
    // the manifest virtual path, not the on-disk filename), so the
    // legacy 1:1 mapping holds in both autoformat and
    // no-autoformat cases.
    const instrumentedEntry = path.join(
      tmpDir,
      path.relative(baseDir, mainEntry),
    );

    // Generate the runner script
    const runnerCode = generateRunner({
      addonPath,
      manifestPath,
      instrumentedEntry,
      outDir: traceOutDir,
      program: path.resolve(mainEntry),
      appArgs,
      columnAware,
    });

    const runnerPath = path.join(tmpDir, "__ct_runner.js");
    fs.writeFileSync(runnerPath, runnerCode);

    // Execute the runner with Node.js
    const nodeExe = process.execPath;

    try {
      execFileSync(nodeExe, [runnerPath, ...appArgs], {
        stdio: "inherit",
        cwd: process.cwd(),
        env: {
          ...process.env,
          // Prevent recursive instrumentation
          CODETRACER_JS_RECORDER_DISABLED: "false",
        },
      });
    } catch (err: unknown) {
      // The child process may exit with a non-zero code but still produce a trace.
      // We continue to check for the trace directory marker.
      const exitErr = err as { status?: number };
      if (exitErr.status !== undefined && exitErr.status !== 0) {
        console.error(
          `Warning: recorded program exited with code ${exitErr.status}`,
        );
      }
    }

    // Read the trace directory from the marker file
    const markerPath = path.join(tmpDir, "__ct_trace_dir.txt");
    if (fs.existsSync(markerPath)) {
      const traceDir = fs.readFileSync(markerPath, "utf-8").trim();
      console.log(`Trace written to: ${traceDir}`);
    } else {
      console.error(
        "Warning: trace directory marker not found. The recording may have failed.",
      );
    }
  } finally {
    // Clean up temp directory
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

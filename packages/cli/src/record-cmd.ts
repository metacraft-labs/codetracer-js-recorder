/**
 * CLI `record` command implementation.
 *
 * Usage: codetracer-js-recorder record <file> [--out-dir <dir>] [--format json|binary] [-- app-args...]
 *
 * 1. Instruments the entry file (and directory siblings if entry is a dir).
 * 2. Creates a temp directory with:
 *    - Instrumented source code
 *    - codetracer.manifest.json
 *    - __ct_runner.js — a bootstrap script that sets up the runtime + addon
 * 3. Executes __ct_runner.js with Node.js as a child process.
 * 4. Reports the trace directory path on completion.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { instrument, shouldInstrument } from "@codetracer/instrumenter";
import type {
  ManifestSlice,
  FunctionEntry,
  SiteEntry,
  FilterOptions,
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
} {
  const paths: string[] = [];
  const functions: FunctionEntry[] = [];
  const sites: SiteEntry[] = [];
  const sourcesContent: Record<string, string> = {};

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
  }

  const result: {
    paths: string[];
    functions: FunctionEntry[];
    sites: SiteEntry[];
    sourcesContent?: Record<string, string>;
  } = { paths, functions, sites };

  if (Object.keys(sourcesContent).length > 0) {
    result.sourcesContent = sourcesContent;
  }

  return result;
}

/**
 * Parse command-line arguments for the record command.
 */
function parseArgs(args: string[]): {
  entryFile: string;
  outDir: string;
  format: string;
  appArgs: string[];
  include: string[];
  exclude: string[];
} {
  let entryFile: string | undefined;
  let outDir = "./ct-traces/";
  let format = "binary";
  const appArgs: string[] = [];
  const include: string[] = [];
  const exclude: string[] = [];
  let seenDashDash = false;

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

    if (arg === "--out-dir" && i + 1 < args.length) {
      outDir = args[++i];
    } else if (arg === "--format" && i + 1 < args.length) {
      format = args[++i];
    } else if (arg === "--include" && i + 1 < args.length) {
      include.push(args[++i]);
    } else if (arg === "--exclude" && i + 1 < args.length) {
      exclude.push(args[++i]);
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        `Usage: codetracer-js-recorder record <file> [--out-dir <dir>] [--format json|binary] [--include <glob>] [--exclude <glob>] [-- app-args...]`,
      );
      process.exit(0);
    } else if (!entryFile && !arg.startsWith("-")) {
      entryFile = arg;
    }
  }

  if (!entryFile) {
    console.error("Error: <file> argument is required.");
    process.exit(1);
  }

  return { entryFile: entryFile!, outDir, format, appArgs, include, exclude };
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
  format: string;
}): string {
  // Escape paths for embedding in JS strings (handle backslashes on Windows)
  const esc = (s: string) => JSON.stringify(s);

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
  format: ${esc(opts.format)},
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
 * Entry point for the `record` command.
 */
export function recordCommand(args: string[]): void {
  const { entryFile, outDir, format, appArgs, include, exclude } =
    parseArgs(args);

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
    // Instrument each file
    const slices: Array<{ slice: ManifestSlice; originalFile: string }> = [];

    for (const file of files) {
      const relPath = path.relative(baseDir, file);
      const code = fs.readFileSync(file, "utf-8");

      try {
        const result = instrument(code, { filename: path.resolve(file) });

        // Write instrumented code
        const outFilePath = path.join(tmpDir, relPath);
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
    const manifest = {
      formatVersion: 1,
      ...merged,
    };
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

    // Determine the instrumented entry file path
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
      format,
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

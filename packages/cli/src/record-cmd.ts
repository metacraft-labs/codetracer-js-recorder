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
import { instrument } from "@codetracer/instrumenter";
import type {
  ManifestSlice,
  FunctionEntry,
  SiteEntry,
} from "@codetracer/instrumenter";

/** File extensions we instrument. */
const INSTRUMENTABLE_EXTENSIONS = new Set([".js", ".ts", ".jsx", ".tsx"]);

/** Directories we always skip. */
const SKIP_DIRS = new Set(["node_modules", ".git", ".hg", ".svn"]);

/**
 * Recursively collect all instrumentable files under a directory.
 */
function collectFiles(dir: string): string[] {
  const results: string[] = [];

  function walk(current: string): void {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          walk(path.join(current, entry.name));
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (INSTRUMENTABLE_EXTENSIONS.has(ext)) {
          results.push(path.join(current, entry.name));
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
} {
  const paths: string[] = [];
  const functions: FunctionEntry[] = [];
  const sites: SiteEntry[] = [];

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
  }

  return { paths, functions, sites };
}

/**
 * Parse command-line arguments for the record command.
 */
function parseArgs(args: string[]): {
  entryFile: string;
  outDir: string;
  format: string;
  appArgs: string[];
} {
  let entryFile: string | undefined;
  let outDir = "./ct-traces/";
  let format = "json";
  const appArgs: string[] = [];
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
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        `Usage: codetracer-js-recorder record <file> [--out-dir <dir>] [--format json|binary] [-- app-args...]`,
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

  return { entryFile: entryFile!, outDir, format, appArgs };
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

// Event buffer (typed arrays for performance)
var BUFFER_CAPACITY = 4096;
var eventKinds = new Uint8Array(BUFFER_CAPACITY);
var ids = new Uint32Array(BUFFER_CAPACITY);
var bufLen = 0;

function flushBuffer() {
  if (bufLen === 0) return;
  addon.appendEvents(handle, eventKinds.slice(0, bufLen), ids.slice(0, bufLen));
  bufLen = 0;
}

function pushEvent(kind, id) {
  eventKinds[bufLen] = kind;
  ids[bufLen] = id;
  bufLen++;
  if (bufLen >= BUFFER_CAPACITY) {
    flushBuffer();
  }
}

// Set up globalThis.__ct
globalThis.__ct = {
  step: function(siteId) {
    pushEvent(0, siteId);
  },
  enter: function(fnId, args) {
    pushEvent(1, fnId);
  },
  ret: function(fnId, value) {
    pushEvent(2, fnId);
    return value;
  },
};

// Register exit handler to flush and stop
var stopped = false;
process.on("exit", function() {
  if (!stopped) {
    stopped = true;
    flushBuffer();
    var traceDir = addon.flushAndStop(handle);
    // Write trace dir path to a marker file so the parent process can read it
    var markerPath = ${esc(opts.manifestPath)}.replace("codetracer.manifest.json", "__ct_trace_dir.txt");
    fs.writeFileSync(markerPath, traceDir);
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
  const { entryFile, outDir, format, appArgs } = parseArgs(args);

  const entryPath = path.resolve(entryFile);
  if (!fs.existsSync(entryPath)) {
    console.error(`Error: entry file '${entryPath}' does not exist.`);
    process.exit(1);
  }

  const stat = fs.statSync(entryPath);
  const isDir = stat.isDirectory();

  // Collect files to instrument
  let files: string[];
  let baseDir: string;
  let mainEntry: string;

  if (isDir) {
    baseDir = entryPath;
    files = collectFiles(entryPath);
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

/**
 * CLI `instrument` command implementation.
 *
 * Usage: codetracer-js-recorder instrument <src> --out <dir> [--source-maps]
 *
 * Walks the source directory (or instruments a single file), instruments
 * all .js/.ts/.jsx/.tsx files (excluding node_modules), writes instrumented
 * output to the specified directory preserving directory structure, and
 * writes a merged codetracer.manifest.json.
 */

import * as fs from "node:fs";
import * as path from "node:path";
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
  lineLengths?: Record<string, number[]>;
} {
  const paths: string[] = [];
  const functions: FunctionEntry[] = [];
  const sites: SiteEntry[] = [];
  const sourcesContent: Record<string, string> = {};
  // P2.3: merged per-source line-length tables keyed by source path.
  // The native addon forwards the merged table through
  // `register_path_with_line_lengths` so the CTFS writer's `paths.dat`
  // ships the Layout A line-length record needed for column-aware
  // decoding.
  const lineLengths: Record<string, number[]> = {};

  const globalPathMap = new Map<string, number>();

  for (const { slice } of slices) {
    // Build a local-to-global path index map for this slice
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

    // Re-index functions
    const fnIdOffset = functions.length;
    for (const fn of slice.functions) {
      functions.push({
        ...fn,
        pathIndex: localToGlobal[fn.pathIndex],
      });
    }

    // Re-index sites
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

    // P2.3: merge line-length tables.  The first slice wins on
    // collisions — re-instrumenting the same file in a different
    // compilation run yields the same byte counts, so the choice
    // doesn't matter in practice.  We slice() before storing to
    // protect against the originating slice mutating the array
    // afterward.
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
 * Parse command-line arguments for the instrument command.
 */
function parseArgs(args: string[]): {
  src: string;
  outDir: string;
  sourceMaps: boolean;
  include: string[];
  exclude: string[];
  /**
   * M26: when true, the output is intended for static browser hosting.
   * The CLI emits an additional `codetracer-runtime.js` bootstrap file
   * that installs the `__ct` global before any instrumented module
   * loads.  Consumers add a single `<script src="codetracer-runtime.js">`
   * tag to their `index.html` and the bundle is drop-in.
   */
  browser: boolean;
  /** WebSocket endpoint baked into the browser runtime stub. */
  endpoint?: string;
} {
  let src: string | undefined;
  let outDir: string | undefined;
  let sourceMaps = false;
  let browser = false;
  let endpoint: string | undefined;
  const include: string[] = [];
  const exclude: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--out" && i + 1 < args.length) {
      outDir = args[++i];
    } else if (arg === "--source-maps") {
      sourceMaps = true;
    } else if (arg === "--include" && i + 1 < args.length) {
      include.push(args[++i]);
    } else if (arg === "--exclude" && i + 1 < args.length) {
      exclude.push(args[++i]);
    } else if (arg === "--browser") {
      browser = true;
    } else if (arg === "--endpoint" && i + 1 < args.length) {
      endpoint = args[++i];
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        `Usage: codetracer-js-recorder instrument <src> --out <dir> [--source-maps] [--include <glob>] [--exclude <glob>] [--browser [--endpoint <url>]]`,
      );
      process.exit(0);
    } else if (!src && !arg.startsWith("-")) {
      src = arg;
    }
  }

  if (!src) {
    console.error("Error: <src> argument is required.");
    process.exit(1);
  }
  if (!outDir) {
    console.error("Error: --out <dir> is required.");
    process.exit(1);
  }

  return {
    src: src!,
    outDir: outDir!,
    sourceMaps,
    include,
    exclude,
    browser,
    endpoint,
  };
}

/**
 * Build the contents of `codetracer-runtime.js` — a self-contained
 * browser bootstrap that installs the `__ct` global before any
 * instrumented module loads.  The file is small enough (a few KB) to
 * inline; consumers add `<script src="./codetracer-runtime.js"></script>`
 * to their `index.html` before the instrumented bundle.
 *
 * The stub is intentionally minimal — it ships only the surface the
 * SWC instrumenter calls (`step`, `enter`, `ret`, `write`) plus the M25
 * `markCorrelation` hook.  It buffers events until the WebSocket reaches
 * `OPEN` and flushes on a fixed threshold + on `pagehide`.  When the
 * WebSocket is unavailable (e.g. the daemon is not running) the runtime
 * silently degrades into a no-op — the host program is unaffected.
 *
 * We inline the JS source rather than `require()`-ing
 * `@codetracer/runtime-browser` because the produced bundle must be
 * runnable as a static asset with no `node_modules` lookup.
 */
function buildBrowserRuntimeStub(endpoint: string, manifest: unknown): string {
  const manifestJson = JSON.stringify(manifest);
  const endpointJson = JSON.stringify(endpoint);
  // The runtime stub mirrors `packages/runtime-browser/src/index.ts`'s
  // queue-and-flush semantics.  We keep it ES5 / no-modules so it loads
  // from a plain `<script>` tag without `type="module"`.
  return `// CodeTracer browser runtime (M26 AOT bundle bootstrap).
// Wire format: newline-delimited JSON over WebSocket.
// Spec: codetracer-specs/GUI/Debugging-Features/Value-Origin-Tracking.md §14.4
(function () {
  if (typeof globalThis === "undefined") return;
  if (globalThis.__ct) return;
  var endpoint =
    globalThis.__codetracer_endpoint || ${endpointJson};
  var manifest = ${manifestJson};
  var queue = [];
  var stopped = false;
  var threshold = 256;
  var socket = null;
  try {
    if (typeof WebSocket !== "undefined") {
      socket = new WebSocket(endpoint);
      socket.onopen = function () { flush(); };
    }
  } catch (e) {
    socket = null;
  }
  function enqueue(evt) {
    if (stopped) return;
    queue.push(evt);
    if (queue.length >= threshold) flush();
  }
  function flush() {
    if (!socket) { queue.length = 0; return; }
    if (socket.readyState !== 1) return;
    if (queue.length === 0) return;
    var lines = [];
    for (var i = 0; i < queue.length; i++) {
      try { lines.push(JSON.stringify(queue[i])); } catch (e) {}
    }
    try { socket.send(lines.join("\\n") + "\\n"); } catch (e) {}
    queue.length = 0;
  }
  function encodeValue(v) {
    if (v === undefined || v === null) return { value: null, typeKind: "None" };
    var t = typeof v;
    if (t === "boolean") return { value: v, typeKind: "Bool" };
    if (t === "number") {
      if (isNaN(v)) return { value: "NaN", typeKind: "Raw" };
      if (!isFinite(v)) return { value: v > 0 ? "Infinity" : "-Infinity", typeKind: "Raw" };
      return { value: v, typeKind: (v | 0) === v ? "Int" : "Float" };
    }
    if (t === "string") {
      return { value: v.length > 1000 ? v.slice(0, 1000) : v, typeKind: "String" };
    }
    if (t === "function") return { value: v.name || "anonymous", typeKind: "FunctionKind" };
    return { value: "[object]", typeKind: "Raw" };
  }
  enqueue({ kind: "SessionStart", program: (typeof document !== "undefined" && document.title) || "browser", args: [] });
  if (manifest) enqueue({ kind: "Manifest", manifest: manifest });
  var safeFlush = function () { try { flush(); } catch (e) {} };
  if (typeof globalThis.addEventListener === "function") {
    try {
      globalThis.addEventListener("pagehide", safeFlush);
      globalThis.addEventListener("beforeunload", safeFlush);
    } catch (e) {}
  }
  globalThis.__ct = {
    // The M37 per-step locals array (second argument) is accepted and
    // dropped: the browser transport's "Step" message carries only a
    // site id, and widening it is a wire-protocol change of its own.
    // Browser recordings therefore keep the pre-M37 shape, where a
    // binding's value arrives with its assignment.
    step: function (siteId) { enqueue({ kind: "Step", siteId: siteId }); },
    enter: function (fnId, argsLike) {
      var args = [];
      for (var i = 0; i < argsLike.length; i++) args.push(encodeValue(argsLike[i]));
      enqueue({ kind: "Call", fnId: fnId, args: args });
    },
    ret: function (fnId, value) {
      enqueue({ kind: "Return", fnId: fnId, returnValue: encodeValue(value) });
      return value;
    },
    write: function (siteId) { enqueue({ kind: "Assignment", siteId: siteId }); },
    markCorrelation: function (direction, boundary, key, payload) {
      var evt = { kind: "CorrelationMarker", direction: direction, boundary: boundary, key: key };
      if (payload !== undefined) evt.payload = payload;
      enqueue(evt);
    },
    flush: flush,
    stop: function () {
      if (stopped) return;
      enqueue({ kind: "SessionEnd" });
      flush();
      stopped = true;
      try { socket && socket.close(); } catch (e) {}
    },
  };
})();
`;
}

/**
 * Entry point for the `instrument` command.
 */
export function instrumentCommand(args: string[]): void {
  const { src, outDir, sourceMaps, include, exclude, browser, endpoint } =
    parseArgs(args);

  const srcPath = path.resolve(src);
  if (!fs.existsSync(srcPath)) {
    console.error(`Error: source path '${srcPath}' does not exist.`);
    process.exit(1);
  }

  const stat = fs.statSync(srcPath);
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

  if (isDir) {
    baseDir = srcPath;
    files = collectFiles(srcPath, filterOpts);
  } else {
    baseDir = path.dirname(srcPath);
    files = [srcPath];
  }

  if (files.length === 0) {
    console.error("No instrumentable files found.");
    process.exit(1);
  }

  // Create output directory
  const outPath = path.resolve(outDir);
  fs.mkdirSync(outPath, { recursive: true });

  // Instrument each file
  const slices: Array<{ slice: ManifestSlice; originalFile: string }> = [];
  let instrumentedCount = 0;

  for (const file of files) {
    const relPath = path.relative(baseDir, file);
    const code = fs.readFileSync(file, "utf-8");

    try {
      const result = instrument(code, { filename: path.resolve(file) });

      // Write instrumented code
      const outFilePath = path.join(outPath, relPath);
      const outFileDir = path.dirname(outFilePath);
      fs.mkdirSync(outFileDir, { recursive: true });
      fs.writeFileSync(outFilePath, result.code);

      // Write source map if requested
      if (sourceMaps && result.map) {
        fs.writeFileSync(outFilePath + ".map", result.map);
      }

      slices.push({ slice: result.manifestSlice, originalFile: file });
      instrumentedCount++;
    } catch (err) {
      console.error(`Warning: failed to instrument '${file}': ${err}`);
    }
  }

  // Merge manifests and write
  const merged = mergeManifestSlices(slices);
  const manifest = {
    formatVersion: 1,
    ...merged,
  };
  fs.writeFileSync(
    path.join(outPath, "codetracer.manifest.json"),
    JSON.stringify(manifest, null, 2),
  );

  // M26: emit the browser-runtime bootstrap stub when --browser is set.
  // The output directory becomes a drop-in static-hostable bundle: the
  // `<script src="./codetracer-runtime.js">` tag loads the runtime + the
  // manifest, then the instrumented modules can be loaded normally.
  if (browser) {
    const stubEndpoint = endpoint ?? "ws://localhost:9230/ct-stream";
    const stubPath = path.join(outPath, "codetracer-runtime.js");
    fs.writeFileSync(stubPath, buildBrowserRuntimeStub(stubEndpoint, manifest));
    console.log(`Browser runtime stub written to ${stubPath}`);
  }

  console.log(`Instrumented ${instrumentedCount} file(s) -> ${outPath}`);
  console.log(
    `Manifest written to ${path.join(outPath, "codetracer.manifest.json")}`,
  );
}

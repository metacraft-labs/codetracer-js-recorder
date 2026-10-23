/**
 * CLI `instrument` command implementation.
 *
 * Usage: codetracer-js-recorder instrument <src> --out <dir> [--source-maps]
 *          [--relative-paths]
 *
 * Walks the source directory (or instruments a single file), instruments
 * all .js/.ts/.jsx/.tsx files (excluding node_modules), writes instrumented
 * output to the specified directory preserving directory structure, and
 * writes a merged codetracer.manifest.json.
 *
 * The output is deterministic: files are
 * instrumented in the order of their sorted relative paths, so the id
 * blocks baked into the code do not depend on the order the filesystem
 * lists them in, and every file and the manifest declare the recorder
 * version. With --relative-paths the manifest and the source maps name
 * files by their path relative to <src>, so the same bundle instrumented
 * in two places, or on two machines, is byte-identical; that is how the
 * post-bundle replay build is made. An --out directory that already holds
 * an instrumented build of another recorder version is refused rather than
 * reused.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  checkInstrumentedBuild,
  instrument,
  manifestDocument,
  manifestFileContents,
  mergeManifestSlices,
  MANIFEST_FILE_NAME,
  nextManifestIdBases,
  RECORDER_VERSION,
  recorderVersionDeclaration,
  shouldInstrument,
  sortedFilesUnder,
} from "@codetracer/instrumenter";
import type { ManifestSlice, FilterOptions } from "@codetracer/instrumenter";

/**
 * Collect all instrumentable files under a directory, as paths relative
 * to it, sorted (`sortedFilesUnder`): the order files are instrumented
 * in decides the id blocks baked into their code, so it must not be the
 * order the filesystem happens to list them in.
 *
 * Uses glob-based include/exclude filtering via picomatch.
 * By default, includes all JS/TS files and excludes node_modules.
 */
export function collectFiles(
  dir: string,
  filterOpts?: FilterOptions,
): string[] {
  return sortedFilesUnder(dir, (rel) => shouldInstrument(rel, filterOpts));
}

/**
 * Parse command-line arguments for the instrument command.
 */
function parseArgs(args: string[]): {
  src: string;
  outDir: string;
  sourceMaps: boolean;
  /** Record paths relative to <src> instead of absolute (see the header). */
  relativePaths: boolean;
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
  let relativePaths = false;
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
    } else if (arg === "--relative-paths") {
      relativePaths = true;
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
        `Usage: codetracer-js-recorder instrument <src> --out <dir> [--source-maps] [--relative-paths] [--include <glob>] [--exclude <glob>] [--browser [--endpoint <url>]]`,
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
    relativePaths,
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
${recorderVersionDeclaration()}
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
  // The daemon socket is the recorder's, not the page's: open it with the
  // WebSocket constructor as it was before a boundary shim patched it (the
  // replay runner's or the shim's published originals), so it is not
  // recorded as a socket the page opened. Mirrors resolveOriginals() in
  // packages/runtime-browser/src/index.ts.
  var published =
    (globalThis.__ctReplay && globalThis.__ctReplay.originals) ||
    (globalThis.__ctBoundaryShim && globalThis.__ctBoundaryShim.originals);
  var WebSocketCtor =
    (published && published.WebSocket) ||
    (typeof WebSocket !== "undefined" ? WebSocket : undefined);
  try {
    if (WebSocketCtor) {
      socket = new WebSocketCtor(endpoint);
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
  // The session's program and args: the page's title and no args, unless
  // the page (or a replay runner, which records a materialised trace's
  // provenance in its args) set __codetracer_program / __codetracer_args.
  var program = typeof globalThis.__codetracer_program === "string"
    ? globalThis.__codetracer_program
    : (typeof document !== "undefined" && document.title) || "browser";
  var sessionArgs = [];
  if (Array.isArray(globalThis.__codetracer_args)) {
    for (var a = 0; a < globalThis.__codetracer_args.length; a++) {
      sessionArgs.push(String(globalThis.__codetracer_args[a]));
    }
  }
  enqueue({ kind: "SessionStart", program: program, args: sessionArgs });
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
    markCorrelation: function (direction, boundary, key, payload, showText) {
      var evt = { kind: "CorrelationMarker", direction: direction, boundary: boundary, key: key };
      if (payload !== undefined) evt.payload = payload;
      // showText names the binding a cross-process origin chain resumes
      // its walk on in the sending recording; dropping it leaves the
      // marker visible with its history unreachable.  The daemon's
      // CorrelationMarker message already carries it (see
      // packages/runtime-browser/src/index.ts).
      if (showText !== undefined) evt.showText = showText;
      enqueue(evt);
    },
    // Accepted and dropped: span coverage is written into corrmark.ns by
    // the CTFS writer at close, and this stub has no writer — it speaks
    // the daemon's message protocol, which has no span-coverage message
    // yet.  Accepting it keeps a page instrumented by the same pass from
    // throwing where a Node program records.
    markSpanCoverage: function () {},
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

/** What {@link instrumentTree} instruments, and how. */
export interface InstrumentTreeOptions {
  /** A file, or a directory whose instrumentable files are instrumented. */
  src: string;
  /** The output directory. */
  outDir: string;
  sourceMaps?: boolean;
  relativePaths?: boolean;
  include?: string[];
  exclude?: string[];
  /** Also write the browser runtime stub `codetracer-runtime.js`. */
  browser?: boolean;
  /** The WebSocket endpoint baked into the stub. */
  endpoint?: string;
}

/** What {@link instrumentTree} wrote. */
export interface InstrumentTreeResult {
  outDir: string;
  /** Files instrumented. */
  instrumented: number;
  /** Files that failed to instrument (left out of the output), with why. */
  failures: { file: string; error: string }[];
  /** The merged manifest document (`codetracer.manifest.json`). */
  manifest: unknown;
  /** The browser runtime stub's path, with `browser`. */
  stubPath?: string;
}

/**
 * Instrument `options.src` into `options.outDir`: the `instrument`
 * command as a library call, for the boundary replay runner, which
 * instruments a deployed bundle itself (CodeTracer's JS-Boundary-Recording
 * specification §8, §12). Throws instead of exiting.
 */
export function instrumentTree(
  options: InstrumentTreeOptions,
): InstrumentTreeResult {
  const {
    src,
    outDir,
    sourceMaps = false,
    relativePaths = false,
    include = [],
    exclude = [],
    browser = false,
    endpoint,
  } = options;

  const srcPath = path.resolve(src);
  if (!fs.existsSync(srcPath)) {
    throw new Error(`source path '${srcPath}' does not exist.`);
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
    files = collectFiles(srcPath, filterOpts).map((rel) =>
      path.join(srcPath, rel),
    );
  } else {
    baseDir = path.dirname(srcPath);
    files = [srcPath];
  }

  if (files.length === 0) {
    throw new Error("No instrumentable files found.");
  }

  // Create output directory, refusing one that holds an instrumented
  // build of another recorder version: mixing its files with this
  // version's would give a build no single runtime matches.
  const outPath = path.resolve(outDir);
  const stale = checkInstrumentedBuild(outPath, RECORDER_VERSION);
  if (stale.length > 0) {
    const first = stale[0];
    throw new Error(
      `refusing to reuse '${outPath}': it holds an instrumented build ` +
        `whose ${first.file} declares recorder version ` +
        `${first.declared ?? "(none)"}, not ${RECORDER_VERSION} ` +
        `(${stale.length} file(s) differ). Remove it or choose another --out.`,
    );
  }
  fs.mkdirSync(outPath, { recursive: true });

  // Instrument each file.  Merge order IS instrumentation order: each
  // file is instrumented with `nextManifestIdBases(slices)` so the ids
  // baked into its `__ct.*` calls are already the merged manifest's ids.
  const slices: ManifestSlice[] = [];
  const failures: { file: string; error: string }[] = [];
  let instrumentedCount = 0;

  for (const file of files) {
    const relPath = path.relative(baseDir, file);
    const code = fs.readFileSync(file, "utf-8");

    try {
      const result = instrument(code, {
        filename: path.resolve(file),
        // Relative to <src>, `/`-separated, when the output must not
        // depend on where the bundle sits.
        ...(relativePaths
          ? { recordedPath: relPath.split(path.sep).join("/") }
          : {}),
        // See the note on `slices` above: ids are baked into the emitted
        // code, so they must be minted in the merged numbering.
        idBases: nextManifestIdBases(slices),
      });

      // Write instrumented code
      const outFilePath = path.join(outPath, relPath);
      const outFileDir = path.dirname(outFilePath);
      fs.mkdirSync(outFileDir, { recursive: true });
      fs.writeFileSync(outFilePath, result.code);

      // Write source map if requested
      if (sourceMaps && result.map) {
        fs.writeFileSync(outFilePath + ".map", result.map);
      }

      slices.push(result.manifestSlice);
      instrumentedCount++;
    } catch (err) {
      failures.push({ file, error: String(err) });
    }
  }

  // Merge manifests and write
  const merged = mergeManifestSlices(slices);
  const manifest = manifestDocument(merged);
  fs.writeFileSync(
    path.join(outPath, MANIFEST_FILE_NAME),
    manifestFileContents(merged),
  );

  // M26: emit the browser-runtime bootstrap stub when --browser is set.
  // The output directory becomes a drop-in static-hostable bundle: the
  // `<script src="./codetracer-runtime.js">` tag loads the runtime + the
  // manifest, then the instrumented modules can be loaded normally.
  let stubPath: string | undefined;
  if (browser) {
    const stubEndpoint = endpoint ?? "ws://localhost:9230/ct-stream";
    stubPath = path.join(outPath, "codetracer-runtime.js");
    fs.writeFileSync(stubPath, buildBrowserRuntimeStub(stubEndpoint, manifest));
  }

  return {
    outDir: outPath,
    instrumented: instrumentedCount,
    failures,
    manifest,
    ...(stubPath === undefined ? {} : { stubPath }),
  };
}

/**
 * Entry point for the `instrument` command.
 */
export function instrumentCommand(args: string[]): void {
  const options = parseArgs(args);
  let result: InstrumentTreeResult;
  try {
    result = instrumentTree(options);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
  for (const f of result.failures) {
    console.error(`Warning: failed to instrument '${f.file}': ${f.error}`);
  }
  if (result.stubPath !== undefined) {
    console.log(`Browser runtime stub written to ${result.stubPath}`);
  }
  console.log(
    `Instrumented ${result.instrumented} file(s) -> ${result.outDir}`,
  );
  console.log(
    `Manifest written to ${path.join(result.outDir, MANIFEST_FILE_NAME)}`,
  );
}

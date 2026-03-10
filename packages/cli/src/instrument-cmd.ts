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
  }

  return { paths, functions, sites };
}

/**
 * Parse command-line arguments for the instrument command.
 */
function parseArgs(args: string[]): {
  src: string;
  outDir: string;
  sourceMaps: boolean;
} {
  let src: string | undefined;
  let outDir: string | undefined;
  let sourceMaps = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--out" && i + 1 < args.length) {
      outDir = args[++i];
    } else if (arg === "--source-maps") {
      sourceMaps = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        `Usage: codetracer-js-recorder instrument <src> --out <dir> [--source-maps]`,
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

  return { src: src!, outDir: outDir!, sourceMaps };
}

/**
 * Entry point for the `instrument` command.
 */
export function instrumentCommand(args: string[]): void {
  const { src, outDir, sourceMaps } = parseArgs(args);

  const srcPath = path.resolve(src);
  if (!fs.existsSync(srcPath)) {
    console.error(`Error: source path '${srcPath}' does not exist.`);
    process.exit(1);
  }

  const stat = fs.statSync(srcPath);
  const isDir = stat.isDirectory();

  // Collect files to instrument
  let files: string[];
  let baseDir: string;

  if (isDir) {
    baseDir = srcPath;
    files = collectFiles(srcPath);
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

  console.log(`Instrumented ${instrumentedCount} file(s) -> ${outPath}`);
  console.log(
    `Manifest written to ${path.join(outPath, "codetracer.manifest.json")}`,
  );
}

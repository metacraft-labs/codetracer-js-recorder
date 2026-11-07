/**
 * The recorder version that instrumented output declares, and the check
 * that refuses to reuse an instrumented build of another version.
 *
 * Instrumented code is only meaningful together with the runtime it was
 * instrumented for: the `__ct.*` calls it carries, their arguments and the
 * manifest's id numbering are a contract between the two. A trace produced
 * by running code instrumented by a different version must be detected,
 * not silently recorded. A replay archive also keys instrumented builds by
 * this version.
 *
 * Two declarations carry it, so that both a single file and a whole build
 * can be checked:
 *
 *   * every instrumented file ends with {@link recorderVersionDeclaration}
 *     (a `/*! … *\/` comment, which minifiers keep as a "legal comment");
 *   * the merged manifest the CLI and the bundler plugins write carries
 *     `recorderVersion` ({@link manifestDocument}).
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { MergedManifest } from "./merge.js";
import { sortedFilesUnder } from "./files.js";

/**
 * What a version may look like: it is used as a path segment of the
 * bundle archive (`instrumented/{recorder_version}/`), so it is limited
 * to the characters of a semantic version.
 */
export const VERSION_SHAPE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;

/**
 * This package's version, which is the recorder version: the CLI, the
 * instrumenter and the runtime are versioned together (`just
 * bump-version`). Read from `package.json` so it cannot drift from it.
 */
export const RECORDER_VERSION: string = readOwnVersion();

function readOwnVersion(): string {
  // `dist/version.js` (and `src/version.ts` under vitest) sit one level
  // below the package root.
  const pkgPath = path.join(__dirname, "..", "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
    version?: unknown;
  };
  if (typeof pkg.version !== "string" || !VERSION_SHAPE.test(pkg.version)) {
    throw new Error(
      `@codetracer/instrumenter: ${pkgPath} has no usable "version"`,
    );
  }
  return pkg.version;
}

const DECLARATION_PREFIX = "/*! @codetracer/recorder-version ";
const DECLARATION_SUFFIX = " */";

/** The comment appended to every instrumented file. */
export function recorderVersionDeclaration(
  version: string = RECORDER_VERSION,
): string {
  return `${DECLARATION_PREFIX}${version}${DECLARATION_SUFFIX}`;
}

const DECLARATION_PATTERN = /\/\*! @codetracer\/recorder-version (\S+) \*\//g;

/**
 * The recorder version `code` declares, or `null` when it declares none.
 * Code that declares two different versions (two builds concatenated)
 * is reported as the sentinel `"<conflicting>"`, which never equals a
 * real version.
 */
export function declaredRecorderVersion(code: string): string | null {
  let found: string | null = null;
  for (const match of code.matchAll(DECLARATION_PATTERN)) {
    if (found !== null && found !== match[1]) return "<conflicting>";
    found = match[1];
  }
  return found;
}

/** File name of the merged manifest the CLI writes beside its output. */
export const MANIFEST_FILE_NAME = "codetracer.manifest.json";

/**
 * The manifest document every build tool writes: the merged manifest
 * with its format version and the recorder version that produced it.
 */
export function manifestDocument(
  merged: MergedManifest,
  version: string = RECORDER_VERSION,
): { formatVersion: 1; recorderVersion: string } & MergedManifest {
  return { formatVersion: 1, recorderVersion: version, ...merged };
}

/**
 * The bytes of {@link MANIFEST_FILE_NAME}: {@link manifestDocument} as
 * indented JSON. The one serialisation, used by the CLI and every
 * bundler plugin, so the same build gives the same file.
 */
export function manifestFileContents(merged: MergedManifest): string {
  return JSON.stringify(manifestDocument(merged), null, 2);
}

/** One way an existing instrumented build differs from the expected version. */
export interface RecorderVersionMismatch {
  /** Path relative to the build directory (`/`-separated). */
  file: string;
  /** What the file declares; `null` when it declares nothing. */
  declared: string | null;
}

/** Extensions of the instrumented code files a build holds. */
const CODE_FILE = /\.(?:[cm]?jsx?|tsx?)$/i;

/**
 * Compare an existing instrumented build with `expected`: its manifest
 * must declare that `recorderVersion`, and no code file in it may
 * declare another. Returns every mismatch (empty when the build is of
 * the expected version, or when `dir` holds no build).
 *
 * A build is recognised by its {@link MANIFEST_FILE_NAME}; a directory
 * without one holds no instrumented build and is not checked. A code
 * file that declares no version is not instrumented output (a file the
 * caller put there) and is not a mismatch.
 */
export function checkInstrumentedBuild(
  dir: string,
  expected: string = RECORDER_VERSION,
): RecorderVersionMismatch[] {
  const manifestPath = path.join(dir, MANIFEST_FILE_NAME);
  if (!fs.existsSync(manifestPath)) return [];
  const mismatches: RecorderVersionMismatch[] = [];
  let declared: string | null = null;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as {
      recorderVersion?: unknown;
    };
    declared =
      typeof manifest.recorderVersion === "string"
        ? manifest.recorderVersion
        : null;
  } catch {
    declared = null;
  }
  if (declared !== expected) {
    mismatches.push({ file: MANIFEST_FILE_NAME, declared });
  }
  for (const rel of sortedFilesUnder(dir, (p) => CODE_FILE.test(p))) {
    const code = fs.readFileSync(path.join(dir, rel), "utf-8");
    const fileVersion = declaredRecorderVersion(code);
    if (fileVersion !== null && fileVersion !== expected) {
      mismatches.push({ file: rel, declared: fileVersion });
    }
  }
  return mismatches;
}

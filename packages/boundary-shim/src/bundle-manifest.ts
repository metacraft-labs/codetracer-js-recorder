/**
 * Build identity: the bundle manifest `ct-bundle.json` and the build hash.
 *
 * A boundary recording is replayed against the byte-identical bundle the
 * visitor ran, so the recording has to name that bundle. The manifest lists
 * every asset the site serves that can execute or style (`.js`, `.mjs`,
 * `.css`, `.html`, `.htm`, `.wasm`) as `{path, sha256, size}`, sorted by
 * path; the build hash is the SHA-256 of its canonical serialisation. The
 * shim's bootstrap embeds the hash and writes it into every session's
 * `Header.build_hash`, and codetracer-ci archives the bundle under it.
 *
 * The bootstrap that embeds the hash is itself inserted into the HTML
 * files the manifest hashes. So that the hash does not depend on it (it
 * cannot contain itself), an HTML file is hashed with its boundary-shim
 * bootstrap element removed: the hash is the same before and after
 * `codetracer-js-recorder boundary-shim --build-hash` runs, and the same
 * deployed bundle has one build hash. The archive holds the bundle as the
 * manifest describes it, without the bootstrap (replay installs the shim
 * its own way).
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { compareUtf8, sortedFilesUnder } from "@codetracer/instrumenter";

import { stripImportSeam } from "./import-seam.js";
import { withoutBootstraps } from "./placement.js";

/** The manifest's file name. */
export const BUNDLE_MANIFEST_FILE = "ct-bundle.json";

/** The manifest format this module writes (`version` in the document). */
export const BUNDLE_MANIFEST_VERSION = 1;

/** Extensions of the files a manifest lists (compared case-insensitively). */
export const BUNDLE_EXTENSIONS: readonly string[] = [
  ".css",
  ".htm",
  ".html",
  ".js",
  ".mjs",
  ".wasm",
];

/** One listed file. */
export interface BundleManifestEntry {
  /** Path relative to the bundle root, `/`-separated. */
  path: string;
  /** SHA-256 of the file's bytes (an HTML file's without the bootstrap), lowercase hex. */
  sha256: string;
  /** Length of those bytes. */
  size: number;
}

/** The `ct-bundle.json` document. */
export interface BundleManifest {
  files: BundleManifestEntry[];
  version: number;
}

/** A manifest with its canonical bytes and the build hash. */
export interface BuiltBundleManifest {
  manifest: BundleManifest;
  /** The canonical serialisation: what `ct-bundle.json` holds. */
  bytes: Buffer;
  /** SHA-256 of {@link bytes}, lowercase hex. */
  buildHash: string;
}

/** Whether `relativePath` is a file the manifest lists. */
export function isBundleAsset(relativePath: string): boolean {
  const ext = path.posix.extname(relativePath).toLowerCase();
  return BUNDLE_EXTENSIONS.includes(ext);
}

function isHtml(relativePath: string): boolean {
  const ext = path.posix.extname(relativePath).toLowerCase();
  return ext === ".html" || ext === ".htm";
}

/**
 * The HTML bytes without the boundary-shim bootstrap element(s): exactly
 * the bytes `injectBoundaryShim` inserted are removed, so for any page
 * `stripBoundaryShim(inject(page))` is `page`. The elements are found with
 * the HTML tokenizer, as injection finds the one it replaces
 * (`bootstrapRanges`): text in a comment or a script that only looks like a
 * bootstrap is the page's. Works on bytes (through a byte-preserving latin1
 * view: everything the tokenizer acts on is ASCII), so the rest of a file is
 * never re-encoded.
 */
export function stripBoundaryShim(html: Buffer): Buffer {
  const text = html.toString("latin1");
  const stripped = withoutBootstraps(text);
  return stripped === text ? html : Buffer.from(stripped, "latin1");
}

/**
 * The bytes without the dynamic `import()` seam the deploy step inserts
 * (`import-seam.ts`): its exact inverse, applied to a byte-preserving
 * latin1 view (the inserted strings are ASCII).
 */
export function stripImportSeamBytes(content: Buffer): Buffer {
  const text = content.toString("latin1");
  const stripped = stripImportSeam(text);
  return stripped === text ? content : Buffer.from(stripped, "latin1");
}

/** Whether the deploy step rewrites the dynamic imports of the file. */
function isScript(relativePath: string): boolean {
  const ext = path.posix.extname(relativePath).toLowerCase();
  return ext === ".js" || ext === ".mjs";
}

/**
 * The bytes a file is hashed by: HTML without the bootstrap, and HTML and
 * scripts without the dynamic `import()` seam (§8.1); others as they are.
 * So the deployed bundle has one build hash, before and after the deploy
 * step installs the recorder.
 */
export function hashedBytes(relativePath: string, content: Buffer): Buffer {
  if (isHtml(relativePath)) {
    return stripImportSeamBytes(stripBoundaryShim(content));
  }
  return isScript(relativePath) ? stripImportSeamBytes(content) : content;
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Canonical JSON (UTF-8, no insignificant whitespace, object keys
 * sorted by code point): `JSON.stringify` of the value with every object's
 * keys in that order.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort(
      compareUtf8,
    );
    const members = keys.map(
      (k) =>
        `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`,
    );
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The canonical bytes of a manifest. */
export function canonicalBundleManifestBytes(manifest: BundleManifest): Buffer {
  return Buffer.from(canonicalJson(manifest), "utf-8");
}

/** The build hash of a manifest: SHA-256 of its canonical bytes. */
export function buildHashOf(manifest: BundleManifest): string {
  return sha256Hex(canonicalBundleManifestBytes(manifest));
}

/**
 * Build the manifest of the bundle under `root`. Throws if `root` holds an
 * entry that is neither a regular file nor a directory (a symbolic link
 * would be served but could not be described reproducibly), or no asset.
 */
export function buildBundleManifest(root: string): BuiltBundleManifest {
  const files = sortedFilesUnder(root, isBundleAsset, {
    rejectOtherEntries: true,
  });
  if (files.length === 0) {
    throw new Error(
      `${root} holds no ${BUNDLE_EXTENSIONS.join(", ")} file to describe`,
    );
  }
  const entries: BundleManifestEntry[] = files.map((rel) => {
    const bytes = hashedBytes(rel, fs.readFileSync(path.join(root, rel)));
    return { path: rel, sha256: sha256Hex(bytes), size: bytes.length };
  });
  const manifest: BundleManifest = {
    files: entries,
    version: BUNDLE_MANIFEST_VERSION,
  };
  const bytes = canonicalBundleManifestBytes(manifest);
  return { manifest, bytes, buildHash: sha256Hex(bytes) };
}

/**
 * Build the manifest of `root` and write it to `outFile` (default
 * `<root>/ct-bundle.json`). Returns what was written.
 */
export function writeBundleManifest(
  root: string,
  outFile: string = path.join(root, BUNDLE_MANIFEST_FILE),
): BuiltBundleManifest {
  const built = buildBundleManifest(root);
  fs.writeFileSync(outFile, built.bytes);
  return built;
}

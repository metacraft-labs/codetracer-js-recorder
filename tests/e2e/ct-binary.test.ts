/**
 * Tests for .ct binary output produced alongside JSON traces.
 *
 * The JS recorder now writes both JSON and binary .ct output for every
 * recording. These tests verify:
 *   - A .ct file is produced when recording a simple JS program
 *   - The .ct file has valid CTFS magic bytes (0xC0 0xDE 0x72 0xAC 0xE2)
 *   - The .ct file has the expected CTFS version (3)
 *   - The .ct file has the expected block size (4096)
 *
 * See: Trace-Files/CTFS-Container-Format.md in codetracer-specs for the
 * CTFS container format specification.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const CLI_PATH = path.join(PROJECT_ROOT, "packages/cli/dist/index.js");
const EXAMPLES_DIR = path.join(PROJECT_ROOT, "examples");

/** CTFS magic bytes: [0xC0, 0xDE, 0x72, 0xAC, 0xE2] */
const CTFS_MAGIC = Buffer.from([0xc0, 0xde, 0x72, 0xac, 0xe2]);

/** Expected CTFS format version.
 *
 * Tracks `CtfsVersion` in
 * codetracer-trace-format-nim/src/codetracer_ctfs/types.nim — bump this
 * when the upstream container format version is incremented.  The Nim
 * reader at `container.nim::hasValidVersion` accepts the current version
 * plus one or two prior versions, so the .ct files this recorder writes
 * remain readable across upstream bumps even before this constant is
 * updated.
 */
const CTFS_VERSION = 4;

/** Expected default block size (4096 as u32 LE). */
const CTFS_BLOCK_SIZE = 4096;

/**
 * Run the CLI as a child process and capture stdout.
 */
function runCLI(args: string[], opts?: { cwd?: string }): string {
  try {
    return execFileSync(process.execPath, [CLI_PATH, ...args], {
      cwd: opts?.cwd ?? PROJECT_ROOT,
      encoding: "utf-8",
      timeout: 30000,
    });
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string };
    // Return stdout even on non-zero exit so tests can inspect output.
    return execErr.stdout ?? "";
  }
}

/**
 * Extract the trace directory path from CLI output.
 * The CLI prints "Trace written to: <path>" on success.
 */
function extractTraceDir(stdout: string): string {
  const match = stdout.match(/Trace written to:\s*(.+)/);
  if (!match) {
    throw new Error(
      `Could not extract trace directory from CLI output:\n${stdout}`,
    );
  }
  return match[1].trim();
}

/**
 * Find .ct files in a directory. The binary writer produces .ct files
 * whose names are derived from the program name (e.g. "hello.ct" for
 * "hello.js"), not from a fixed "trace.ct" convention.
 */
function findCtFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".ct"))
    .map((f) => path.join(dir, f));
}

/**
 * Read a little-endian u32 from a Buffer at the given offset.
 */
function readU32LE(buf: Buffer, offset: number): number {
  return buf.readUInt32LE(offset);
}

// =============================================
// .ct binary output tests
// =============================================
describe("ct binary output", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-e2e-binary-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("recording produces at least one .ct file alongside JSON output", () => {
    const outDir = path.join(tmpDir, "traces");
    const stdout = runCLI([
      "record",
      path.join(EXAMPLES_DIR, "hello.js"),
      "--out-dir",
      outDir,
    ]);

    const traceDir = extractTraceDir(stdout);

    // JSON files should exist (backward compat)
    expect(fs.existsSync(path.join(traceDir, "trace.json"))).toBe(true);

    // At least one .ct file should exist. The name is derived from the
    // program (e.g. "hello.ct" from "hello.js").
    const ctFiles = findCtFiles(traceDir);
    expect(ctFiles.length).toBeGreaterThanOrEqual(1);

    // The .ct file should be non-empty
    const stat = fs.statSync(ctFiles[0]);
    expect(stat.size).toBeGreaterThan(0);
  });

  it(".ct file has valid CTFS magic bytes, version, and block size", () => {
    const outDir = path.join(tmpDir, "traces");
    const stdout = runCLI([
      "record",
      path.join(EXAMPLES_DIR, "hello.js"),
      "--out-dir",
      outDir,
    ]);

    const traceDir = extractTraceDir(stdout);
    const ctFiles = findCtFiles(traceDir);
    expect(ctFiles.length).toBeGreaterThanOrEqual(1);

    // Read the first 12 bytes of the .ct file to check the header.
    // CTFS header layout:
    //   bytes 0-4: magic (5 bytes)
    //   byte  5:   version (1 byte)
    //   byte  6:   compression (1 byte)
    //   byte  7:   encryption (1 byte)
    //   bytes 8-11: block_size (u32 LE)
    const header = Buffer.alloc(12);
    const fd = fs.openSync(ctFiles[0], "r");
    try {
      fs.readSync(fd, header, 0, 12, 0);
    } finally {
      fs.closeSync(fd);
    }

    // Verify CTFS magic: 0xC0 0xDE 0x72 0xAC 0xE2
    const magic = header.subarray(0, 5);
    expect(magic.equals(CTFS_MAGIC)).toBe(true);

    // Verify version
    expect(header[5]).toBe(CTFS_VERSION);

    // Verify block size
    const blockSize = readU32LE(header, 8);
    expect(blockSize).toBe(CTFS_BLOCK_SIZE);
  });

  it(".ct file is produced even with explicit --format json", () => {
    const outDir = path.join(tmpDir, "traces");
    const stdout = runCLI([
      "record",
      path.join(EXAMPLES_DIR, "hello.js"),
      "--out-dir",
      outDir,
      "--format",
      "json",
    ]);

    const traceDir = extractTraceDir(stdout);

    // Even with --format json, the binary .ct is produced as secondary output
    const ctFiles = findCtFiles(traceDir);
    expect(ctFiles.length).toBeGreaterThanOrEqual(1);

    // Verify magic bytes on the first .ct file found
    const header = Buffer.alloc(5);
    const fd = fs.openSync(ctFiles[0], "r");
    try {
      fs.readSync(fd, header, 0, 5, 0);
    } finally {
      fs.closeSync(fd);
    }
    expect(header.equals(CTFS_MAGIC)).toBe(true);
  });

  it("functions.js recording also produces .ct output with valid magic", () => {
    const outDir = path.join(tmpDir, "traces");
    const stdout = runCLI([
      "record",
      path.join(EXAMPLES_DIR, "functions.js"),
      "--out-dir",
      outDir,
    ]);

    const traceDir = extractTraceDir(stdout);

    const ctFiles = findCtFiles(traceDir);
    expect(ctFiles.length).toBeGreaterThanOrEqual(1);

    // Verify magic bytes
    const header = Buffer.alloc(5);
    const fd = fs.openSync(ctFiles[0], "r");
    try {
      fs.readSync(fd, header, 0, 5, 0);
    } finally {
      fs.closeSync(fd);
    }
    expect(header.equals(CTFS_MAGIC)).toBe(true);
  });
});

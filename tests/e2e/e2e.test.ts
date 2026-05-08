import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import {
  ctPrintAvailable,
  ctPrintJson,
  findCtFile,
  type CtPrintBundle,
} from "../helpers/ct-print.js";

// Resolve paths relative to the project root
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const CLI_PATH = path.join(PROJECT_ROOT, "packages/cli/dist/index.js");
const EXAMPLES_DIR = path.join(PROJECT_ROOT, "examples");

/**
 * Helper to run the CLI as a child process and capture output.
 */
function runCLI(
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string> },
): { stdout: string; stderr: string } {
  try {
    const result = execFileSync(process.execPath, [CLI_PATH, ...args], {
      cwd: opts?.cwd ?? PROJECT_ROOT,
      env: { ...process.env, ...opts?.env },
      encoding: "utf-8",
      timeout: 30000,
    });
    return { stdout: result, stderr: "" };
  } catch (err: unknown) {
    const execErr = err as {
      stdout?: string;
      stderr?: string;
      status?: number;
    };
    return {
      stdout: execErr.stdout ?? "",
      stderr: execErr.stderr ?? "",
    };
  }
}

// =============================================
// test_cli_instrument_command
// =============================================
describe("test_cli_instrument_command", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-e2e-inst-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("instruments a single file and produces output + manifest", () => {
    const outDir = path.join(tmpDir, "out");
    const { stdout } = runCLI([
      "instrument",
      path.join(EXAMPLES_DIR, "hello.js"),
      "--out",
      outDir,
    ]);

    // CLI should report success
    expect(stdout).toContain("Instrumented 1 file(s)");
    expect(stdout).toContain("codetracer.manifest.json");

    // Output file should exist
    expect(fs.existsSync(path.join(outDir, "hello.js"))).toBe(true);

    // Manifest should exist and be valid JSON
    const manifestPath = path.join(outDir, "codetracer.manifest.json");
    expect(fs.existsSync(manifestPath)).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    expect(manifest.formatVersion).toBe(1);
    expect(manifest.paths.length).toBeGreaterThanOrEqual(1);
    expect(manifest.functions.length).toBeGreaterThanOrEqual(1);
    expect(manifest.sites.length).toBeGreaterThanOrEqual(1);

    // Instrumented code should contain __ct calls
    const instrumentedCode = fs.readFileSync(
      path.join(outDir, "hello.js"),
      "utf-8",
    );
    expect(instrumentedCode).toContain("__ct.step(");
    expect(instrumentedCode).toContain("__ct.enter(");
    expect(instrumentedCode).toContain("__ct.ret(");
  });

  it("instruments a directory of files", () => {
    const outDir = path.join(tmpDir, "out");
    const { stdout } = runCLI(["instrument", EXAMPLES_DIR, "--out", outDir]);

    // Should instrument all example files
    expect(stdout).toContain("Instrumented 3 file(s)");

    expect(fs.existsSync(path.join(outDir, "hello.js"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "functions.js"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "loops.js"))).toBe(true);

    // Manifest should have all paths
    const manifest = JSON.parse(
      fs.readFileSync(path.join(outDir, "codetracer.manifest.json"), "utf-8"),
    );
    expect(manifest.paths.length).toBe(3);
  });

  it("manifest has all expected function names from all files", () => {
    const outDir = path.join(tmpDir, "out");
    runCLI(["instrument", EXAMPLES_DIR, "--out", outDir]);

    const manifest = JSON.parse(
      fs.readFileSync(path.join(outDir, "codetracer.manifest.json"), "utf-8"),
    );

    const fnNames = manifest.functions.map((f: { name: string }) => f.name);

    // From hello.js
    expect(fnNames).toContain("greet");
    // From functions.js
    expect(fnNames).toContain("add");
    expect(fnNames).toContain("multiply");
    expect(fnNames).toContain("factorial");
    expect(fnNames).toContain("main");
    // From loops.js
    expect(fnNames).toContain("sumRange");
    expect(fnNames).toContain("countDown");
    expect(fnNames).toContain("classify");
  });
});

// =============================================
// test_cli_record_command
// =============================================
describe("test_cli_record_command", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-e2e-rec-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("records a simple program and produces a CTFS trace directory", () => {
    const outDir = path.join(tmpDir, "traces");
    const { stdout } = runCLI([
      "record",
      path.join(EXAMPLES_DIR, "hello.js"),
      "--out-dir",
      outDir,
    ]);

    // Should show program output
    expect(stdout).toContain("Hello, World!");

    // Should report trace directory
    expect(stdout).toContain("Trace written to:");

    // Extract trace directory from output
    const traceDirMatch = stdout.match(/Trace written to:\s*(.+)/);
    expect(traceDirMatch).not.toBeNull();
    const traceDir = traceDirMatch![1].trim();

    // Trace directory should exist with the CTFS .ct container plus the
    // operational JSON sidecars (`trace_metadata.json` / `trace_paths.json`).
    // The legacy `trace.json` events sidecar must NOT exist
    // (Recorder-CLI-Conventions.md §4 — CTFS-only).
    expect(fs.existsSync(traceDir)).toBe(true);
    expect(fs.existsSync(path.join(traceDir, "trace.json"))).toBe(false);
    expect(fs.existsSync(path.join(traceDir, "trace_metadata.json"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(traceDir, "trace_paths.json"))).toBe(true);

    const ctFiles = fs.readdirSync(traceDir).filter((f) => f.endsWith(".ct"));
    expect(ctFiles.length).toBeGreaterThanOrEqual(1);
  });

  it("exits cleanly with code 0", () => {
    const outDir = path.join(tmpDir, "traces");

    // This should not throw (exit code 0)
    const result = execFileSync(
      process.execPath,
      [
        CLI_PATH,
        "record",
        path.join(EXAMPLES_DIR, "hello.js"),
        "--out-dir",
        outDir,
      ],
      {
        cwd: PROJECT_ROOT,
        encoding: "utf-8",
        timeout: 30000,
      },
    );

    expect(result).toContain("Trace written to:");
  });
});

// =============================================
// e2e_record_simple_program
// =============================================
describe("e2e_record_simple_program", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-e2e-simple-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("test_recorded_trace_via_ct_print_json", () => {
    // This test mirrors the cairo precedent (commit 2710b5e) — record a
    // real program, then convert the produced CTFS bundle through
    // `ct-print --json` and assert on the textual representation.
    // See `Recorder-CLI-Conventions.md` §4 — CTFS-only output, with
    // `ct print` as the canonical conversion tool.
    if (!ctPrintAvailable()) {
      // Skip when ct-print is not reachable (out-of-workspace CI run).
      // The verify-cli-convention-no-silent-skip.sh guard ensures the
      // CLI surface stays compliant even if this content test is skipped.
      console.warn(
        "SKIP test_recorded_trace_via_ct_print_json: ct-print not found",
      );
      return;
    }

    const outDir = path.join(tmpDir, "traces");
    const { stdout } = runCLI([
      "record",
      path.join(EXAMPLES_DIR, "hello.js"),
      "--out-dir",
      outDir,
    ]);

    const traceDirMatch = stdout.match(/Trace written to:\s*(.+)/);
    expect(traceDirMatch).not.toBeNull();
    const traceDir = traceDirMatch![1].trim();

    const ctFile = findCtFile(traceDir);
    const bundle = ctPrintJson(ctFile) as CtPrintBundle;

    // Structural anchors: paths, functions, steps, ioEvents.  We do NOT
    // assert on exact internal record IDs — those are owned by
    // codetracer-trace-format-nim and may evolve.
    expect(bundle.paths).toBeDefined();
    expect(bundle.paths!.length).toBeGreaterThanOrEqual(1);
    expect(bundle.paths!.some((p) => p.endsWith("hello.js"))).toBe(true);

    expect(bundle.functions).toBeDefined();
    expect(bundle.functions).toContain("<module>");
    expect(bundle.functions).toContain("greet");

    expect(bundle.steps).toBeDefined();
    expect(bundle.steps!.length).toBeGreaterThan(0);

    // The console.log("Hello, World!") call must surface as an ioStdout
    // event — this is the canonical anchor for the recorder's IO path.
    expect(bundle.ioEvents).toBeDefined();
    const helloEvent = bundle.ioEvents!.find(
      (e) => e.kind === "ioStdout" && (e.data ?? "").includes("Hello, World!"),
    );
    expect(helloEvent).toBeDefined();

    // Verify trace_metadata.json sidecar (operational, not events).
    const metadata = JSON.parse(
      fs.readFileSync(path.join(traceDir, "trace_metadata.json"), "utf-8"),
    );
    expect(metadata.language).toBe("javascript");
    expect(metadata.recorder).toBe("codetracer-js-recorder");
    // §4: format is hard-pinned to "ctfs" — no `--format` selector exists.
    expect(metadata.format).toBe("ctfs");

    // Verify trace_paths.json sidecar
    const tracePaths = JSON.parse(
      fs.readFileSync(path.join(traceDir, "trace_paths.json"), "utf-8"),
    );
    expect(tracePaths.length).toBeGreaterThanOrEqual(1);

    // Verify files/ directory has source copied
    const filesDir = path.join(traceDir, "files");
    expect(fs.existsSync(filesDir)).toBe(true);
  });

  it("recorded CTFS trace contains Call frames for greet + module", () => {
    if (!ctPrintAvailable()) {
      console.warn("SKIP: ct-print not found");
      return;
    }
    const outDir = path.join(tmpDir, "traces2");
    const { stdout } = runCLI([
      "record",
      path.join(EXAMPLES_DIR, "hello.js"),
      "--out-dir",
      outDir,
    ]);

    const traceDirMatch = stdout.match(/Trace written to:\s*(.+)/);
    const traceDir = traceDirMatch![1].trim();

    const ctFile = findCtFile(traceDir);
    const bundle = ctPrintJson(ctFile) as CtPrintBundle;

    // The CTFS bundle should include functions for both the synthetic
    // module frame and the user-defined `greet` function.
    expect(bundle.functions).toContain("<module>");
    expect(bundle.functions).toContain("greet");

    // Steps must be present — the program executes multiple statements.
    expect(bundle.steps!.length).toBeGreaterThan(0);
  });
});

// =============================================
// e2e_record_multi_file (multiple functions, single file)
// =============================================
describe("e2e_record_multi_file", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-e2e-multi-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("records functions.js and all function names appear in the trace", () => {
    if (!ctPrintAvailable()) {
      console.warn("SKIP: ct-print not found");
      return;
    }
    const outDir = path.join(tmpDir, "traces");
    const { stdout } = runCLI([
      "record",
      path.join(EXAMPLES_DIR, "functions.js"),
      "--out-dir",
      outDir,
    ]);

    // Should show program output
    expect(stdout).toContain("sum: 7");
    expect(stdout).toContain("product: 30");
    expect(stdout).toContain("factorial(5): 120");

    // Extract trace directory
    const traceDirMatch = stdout.match(/Trace written to:\s*(.+)/);
    expect(traceDirMatch).not.toBeNull();
    const traceDir = traceDirMatch![1].trim();

    const ctFile = findCtFile(traceDir);
    const bundle = ctPrintJson(ctFile) as CtPrintBundle;

    expect(bundle.functions).toContain("<module>");
    expect(bundle.functions).toContain("add");
    expect(bundle.functions).toContain("multiply");
    expect(bundle.functions).toContain("factorial");
    expect(bundle.functions).toContain("main");
  });

  it("records loops.js and captures loop iterations as Step events", () => {
    if (!ctPrintAvailable()) {
      console.warn("SKIP: ct-print not found");
      return;
    }
    const outDir = path.join(tmpDir, "traces2");
    const { stdout } = runCLI([
      "record",
      path.join(EXAMPLES_DIR, "loops.js"),
      "--out-dir",
      outDir,
    ]);

    // Should show program output
    expect(stdout).toContain("sum 1..10: 55");
    expect(stdout).toContain("countdown:");

    const traceDirMatch = stdout.match(/Trace written to:\s*(.+)/);
    const traceDir = traceDirMatch![1].trim();

    const ctFile = findCtFile(traceDir);
    const bundle = ctPrintJson(ctFile) as CtPrintBundle;

    // sumRange(1,10) alone should produce 10+ step events for loop iterations
    expect(bundle.steps!.length).toBeGreaterThan(20);

    expect(bundle.functions).toContain("sumRange");
    expect(bundle.functions).toContain("countDown");
    expect(bundle.functions).toContain("classify");
  });

  it("recording exits cleanly and writes a non-trivial CTFS container", () => {
    const outDir = path.join(tmpDir, "traces3");
    const { stdout } = runCLI([
      "record",
      path.join(EXAMPLES_DIR, "hello.js"),
      "--out-dir",
      outDir,
    ]);

    const traceDirMatch = stdout.match(/Trace written to:\s*(.+)/);
    const traceDir = traceDirMatch![1].trim();

    const ctFiles = fs
      .readdirSync(traceDir)
      .filter((f) => f.endsWith(".ct"))
      .map((f) => path.join(traceDir, f));
    expect(ctFiles.length).toBeGreaterThanOrEqual(1);
    const ctSize = ctFiles
      .map((p) => fs.statSync(p).size)
      .reduce((a, b) => a + b, 0);
    // The .ct container must hold meaningful payload above the magic
    // header alone (mirrors the cairo audit's > 100-byte threshold).
    expect(ctSize).toBeGreaterThan(100);
  });
});

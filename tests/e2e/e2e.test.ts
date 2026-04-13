import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { parseTraceEvents } from "../helpers/parse-trace.js";

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

  it("records a simple program and produces a trace directory", () => {
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

    // Trace directory should exist with all expected files
    expect(fs.existsSync(traceDir)).toBe(true);
    expect(fs.existsSync(path.join(traceDir, "trace.json"))).toBe(true);
    expect(fs.existsSync(path.join(traceDir, "trace_metadata.json"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(traceDir, "trace_paths.json"))).toBe(true);
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

  it("records hello.js and produces valid trace with Step/Call/Return events", () => {
    const outDir = path.join(tmpDir, "traces");
    const { stdout } = runCLI([
      "record",
      path.join(EXAMPLES_DIR, "hello.js"),
      "--out-dir",
      outDir,
      "--format",
      "json",
    ]);

    // Extract trace directory
    const traceDirMatch = stdout.match(/Trace written to:\s*(.+)/);
    expect(traceDirMatch).not.toBeNull();
    const traceDir = traceDirMatch![1].trim();

    // Verify trace.json exists and has content
    const traceJson = parseTraceEvents(
      JSON.parse(fs.readFileSync(path.join(traceDir, "trace.json"), "utf-8")),
    );
    expect(traceJson.length).toBeGreaterThan(0);

    // Should have Path events
    const pathEvents = traceJson.filter(
      (e: { type: string }) => e.type === "Path",
    );
    expect(pathEvents.length).toBeGreaterThanOrEqual(1);

    // Should have Function events
    const funcEvents = traceJson.filter(
      (e: { type: string }) => e.type === "Function",
    );
    expect(funcEvents.length).toBeGreaterThanOrEqual(2); // <module> and greet

    const funcNames = funcEvents.map((e: { name: string }) => e.name);
    expect(funcNames).toContain("<module>");
    expect(funcNames).toContain("greet");

    // Should have Step events
    const stepEvents = traceJson.filter(
      (e: { type: string }) => e.type === "Step",
    );
    expect(stepEvents.length).toBeGreaterThan(0);

    // Should have Call events
    const callEvents = traceJson.filter(
      (e: { type: string }) => e.type === "Call",
    );
    expect(callEvents.length).toBeGreaterThanOrEqual(2); // module enter + greet enter

    // Should have Return events
    const returnEvents = traceJson.filter(
      (e: { type: string }) => e.type === "Return",
    );
    expect(returnEvents.length).toBeGreaterThanOrEqual(2); // module return + greet return

    // Verify trace_metadata.json
    const metadata = JSON.parse(
      fs.readFileSync(path.join(traceDir, "trace_metadata.json"), "utf-8"),
    );
    expect(metadata.language).toBe("javascript");
    expect(metadata.recorder).toBe("codetracer-js-recorder");
    expect(metadata.format).toBe("json");

    // Verify trace_paths.json
    const tracePaths = JSON.parse(
      fs.readFileSync(path.join(traceDir, "trace_paths.json"), "utf-8"),
    );
    expect(tracePaths.length).toBeGreaterThanOrEqual(1);

    // Verify files/ directory has source copied
    const filesDir = path.join(traceDir, "files");
    expect(fs.existsSync(filesDir)).toBe(true);
  });

  it("the first runtime event is a Call (module enter) and last is a Return (module exit)", () => {
    const outDir = path.join(tmpDir, "traces2");
    const { stdout } = runCLI([
      "record",
      path.join(EXAMPLES_DIR, "hello.js"),
      "--out-dir",
      outDir,
    ]);

    const traceDirMatch = stdout.match(/Trace written to:\s*(.+)/);
    const traceDir = traceDirMatch![1].trim();

    const traceJson = parseTraceEvents(
      JSON.parse(fs.readFileSync(path.join(traceDir, "trace.json"), "utf-8")),
    );

    // Runtime events are everything after Path and Function declarations
    const runtimeEvents = traceJson.filter(
      (e: { type: string }) =>
        e.type === "Step" || e.type === "Call" || e.type === "Return",
    );

    expect(runtimeEvents.length).toBeGreaterThan(0);
    expect(runtimeEvents[0].type).toBe("Call");
    expect(runtimeEvents[runtimeEvents.length - 1].type).toBe("Return");
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

    // Verify all function names appear in the trace
    const traceJson = parseTraceEvents(
      JSON.parse(fs.readFileSync(path.join(traceDir, "trace.json"), "utf-8")),
    );

    const funcEvents = traceJson.filter(
      (e: { type: string }) => e.type === "Function",
    );
    const funcNames = funcEvents.map((e: { name: string }) => e.name);

    expect(funcNames).toContain("<module>");
    expect(funcNames).toContain("add");
    expect(funcNames).toContain("multiply");
    expect(funcNames).toContain("factorial");
    expect(funcNames).toContain("main");
  });

  it("records loops.js and captures loop iterations as Step events", () => {
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

    const traceJson = parseTraceEvents(
      JSON.parse(fs.readFileSync(path.join(traceDir, "trace.json"), "utf-8")),
    );

    // Should have many step events from the loops
    const stepEvents = traceJson.filter(
      (e: { type: string }) => e.type === "Step",
    );
    // sumRange(1,10) alone should produce 10+ step events for loop iterations
    expect(stepEvents.length).toBeGreaterThan(20);

    // Should have correct function names
    const funcNames = traceJson
      .filter((e: { type: string }) => e.type === "Function")
      .map((e: { name: string }) => e.name);
    expect(funcNames).toContain("sumRange");
    expect(funcNames).toContain("countDown");
    expect(funcNames).toContain("classify");
  });

  it("trace has balanced Call/Return events", () => {
    const outDir = path.join(tmpDir, "traces3");
    const { stdout } = runCLI([
      "record",
      path.join(EXAMPLES_DIR, "hello.js"),
      "--out-dir",
      outDir,
    ]);

    const traceDirMatch = stdout.match(/Trace written to:\s*(.+)/);
    const traceDir = traceDirMatch![1].trim();

    const traceJson = parseTraceEvents(
      JSON.parse(fs.readFileSync(path.join(traceDir, "trace.json"), "utf-8")),
    );

    const callCount = traceJson.filter(
      (e: { type: string }) => e.type === "Call",
    ).length;
    const returnCount = traceJson.filter(
      (e: { type: string }) => e.type === "Return",
    ).length;

    // Every call should have a matching return
    expect(callCount).toBe(returnCount);
    expect(callCount).toBeGreaterThan(0);
  });
});

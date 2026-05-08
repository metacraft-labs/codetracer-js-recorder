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
const HCR_DIR = path.join(__dirname);

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

// Expected output lines for the 12-step HCR program.
// Steps 1-6 use v1: compute=n*2, transform=value+n (delta=3n), aggregate=sum
// Steps 7-12 use v2: compute=n*3, transform=value-n (delta=2n), aggregate=max
const EXPECTED_LINES = [
  "step=1 value=2 delta=3 total=3",
  "step=2 value=4 delta=6 total=9",
  "step=3 value=6 delta=9 total=18",
  "step=4 value=8 delta=12 total=30",
  "step=5 value=10 delta=15 total=45",
  "step=6 value=12 delta=18 total=63",
  "RELOAD_APPLIED",
  "step=7 value=21 delta=14 total=18",
  "step=8 value=24 delta=16 total=18",
  "step=9 value=27 delta=18 total=18",
  "step=10 value=30 delta=20 total=20",
  "step=11 value=33 delta=22 total=22",
  "step=12 value=36 delta=24 total=24",
];

describe("HCR (Hot Code Reload) validation", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-hcr-js-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Copy HCR fixtures into a working directory so the test program can
   * overwrite mymodule.js without affecting the source tree.
   */
  function prepareWorkdir(): string {
    const workdir = path.join(tmpDir, "workdir");
    fs.mkdirSync(workdir, { recursive: true });
    fs.copyFileSync(
      path.join(HCR_DIR, "index.js"),
      path.join(workdir, "index.js"),
    );
    fs.copyFileSync(
      path.join(HCR_DIR, "mymodule_v2.js"),
      path.join(workdir, "mymodule_v2.js"),
    );
    // Start with v1 as the active module.
    fs.copyFileSync(
      path.join(HCR_DIR, "mymodule.js"),
      path.join(workdir, "mymodule.js"),
    );
    return workdir;
  }

  it("records the HCR program and produces correct output with 12 steps", () => {
    const workdir = prepareWorkdir();
    const outDir = path.join(tmpDir, "traces");

    // Pass the workdir directory so the recorder collects all JS files
    // (index.js, mymodule.js, mymodule_v2.js) into the instrumented temp dir.
    const { stdout, stderr } = runCLI(["record", workdir, "--out-dir", outDir]);

    // Parse program output lines (filter out recorder metadata)
    const lines = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("Trace written to:"));

    // Should have 13 output lines: 12 steps + RELOAD_APPLIED
    const stepLines = lines.filter(
      (l) => l.startsWith("step=") || l === "RELOAD_APPLIED",
    );
    expect(stepLines.length).toBe(13);

    // Verify RELOAD_APPLIED is present
    expect(stepLines).toContain("RELOAD_APPLIED");

    // Verify each expected line matches
    for (let i = 0; i < EXPECTED_LINES.length; i++) {
      expect(stepLines[i]).toBe(EXPECTED_LINES[i]);
    }
  });

  it("v1 formulas are correct before reload (steps 1-6)", () => {
    const workdir = prepareWorkdir();
    const outDir = path.join(tmpDir, "traces");

    const { stdout } = runCLI(["record", workdir, "--out-dir", outDir]);

    const lines = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("step="));

    // Steps 1-6: compute = n*2, transform = value+n, aggregate = sum
    for (let step = 1; step <= 6; step++) {
      const line = lines[step - 1];
      const match = line.match(
        /step=(\d+) value=(\d+) delta=(\d+) total=(\d+)/,
      );
      expect(match).not.toBeNull();
      const [, s, value, delta] = match!.map(Number);
      expect(s).toBe(step);
      expect(value).toBe(step * 2);
      expect(delta).toBe(step * 2 + step);
    }
  });

  it("v2 formulas are correct after reload (steps 7-12)", () => {
    const workdir = prepareWorkdir();
    const outDir = path.join(tmpDir, "traces");

    const { stdout } = runCLI(["record", workdir, "--out-dir", outDir]);

    const lines = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("step="));

    // Steps 7-12: compute = n*3, transform = value-n, aggregate = max
    for (let step = 7; step <= 12; step++) {
      // After RELOAD_APPLIED, step=7 is the 7th step line (index 6)
      const line = lines[step - 1];
      const match = line.match(
        /step=(\d+) value=(\d+) delta=(-?\d+) total=(\d+)/,
      );
      expect(match).not.toBeNull();
      const [, s, value, delta] = match!.map(Number);
      expect(s).toBe(step);
      expect(value).toBe(step * 3);
      expect(delta).toBe(step * 3 - step);
    }
  });

  it("produces a trace directory with a non-empty CTFS .ct container", () => {
    const workdir = prepareWorkdir();
    const outDir = path.join(tmpDir, "traces");

    const { stdout } = runCLI(["record", workdir, "--out-dir", outDir]);

    // Extract trace directory from output
    const traceDirMatch = stdout.match(/Trace written to:\s*(.+)/);
    if (traceDirMatch) {
      const traceDir = traceDirMatch[1].trim();
      expect(fs.existsSync(traceDir)).toBe(true);

      // Per Recorder-CLI-Conventions.md §4 the recorder is CTFS-only —
      // no `trace.json` events sidecar is written.
      const ctFiles = fs.readdirSync(traceDir).filter((f) => f.endsWith(".ct"));
      expect(ctFiles.length).toBeGreaterThan(0);

      const totalSize = ctFiles
        .map((f) => fs.statSync(path.join(traceDir, f)).size)
        .reduce((a, b) => a + b, 0);
      expect(totalSize).toBeGreaterThan(100);
    }
  });
});

// =============================================
// HCR trace content assertions
// =============================================
describe("HCR trace content assertions", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-hcr-content-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function prepareWorkdir(): string {
    const workdir = path.join(tmpDir, "workdir");
    fs.mkdirSync(workdir, { recursive: true });
    fs.copyFileSync(
      path.join(HCR_DIR, "index.js"),
      path.join(workdir, "index.js"),
    );
    fs.copyFileSync(
      path.join(HCR_DIR, "mymodule_v2.js"),
      path.join(workdir, "mymodule_v2.js"),
    );
    fs.copyFileSync(
      path.join(HCR_DIR, "mymodule.js"),
      path.join(workdir, "mymodule.js"),
    );
    return workdir;
  }

  /**
   * Helper: record the HCR program and return the ct-print bundle + trace
   * dir.  Returns null when ct-print is unavailable so callers can skip
   * cleanly without silently weakening assertions.
   */
  function recordAndDecode(): {
    bundle: CtPrintBundle;
    traceDir: string;
  } | null {
    const workdir = prepareWorkdir();
    const outDir = path.join(tmpDir, "traces");

    const { stdout } = runCLI(["record", workdir, "--out-dir", outDir]);

    const traceDirMatch = stdout.match(/Trace written to:\s*(.+)/);
    expect(traceDirMatch).not.toBeNull();
    const traceDir = traceDirMatch![1].trim();

    if (!ctPrintAvailable()) {
      console.warn("SKIP HCR content assertions: ct-print not found");
      return null;
    }

    const ctFile = findCtFile(traceDir);
    const bundle = ctPrintJson(ctFile) as CtPrintBundle;
    return { bundle, traceDir };
  }

  it("trace file exists and contains events", () => {
    const result = recordAndDecode();
    if (!result) return;
    const { bundle, traceDir } = result;

    // The CTFS .ct container must exist and decode to a non-empty bundle.
    expect(bundle.steps).toBeDefined();
    expect(bundle.steps!.length).toBeGreaterThan(0);

    // The legacy `trace.json` events sidecar must NOT exist (CTFS-only).
    expect(fs.existsSync(path.join(traceDir, "trace.json"))).toBe(false);

    // Should also have trace_metadata.json sidecar (operational only).
    const metadataPath = path.join(traceDir, "trace_metadata.json");
    expect(fs.existsSync(metadataPath)).toBe(true);
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8"));
    expect(metadata.language).toBe("javascript");
    expect(metadata.format).toBe("ctfs");
  });

  it("trace contains Step events from the HCR program", () => {
    const result = recordAndDecode();
    if (!result) return;
    const { bundle } = result;

    // The program has 12 iterations with multiple statements each, plus
    // module-level code.  Should produce many step events.
    expect(bundle.steps).toBeDefined();
    expect(bundle.steps!.length).toBeGreaterThan(20);
  });

  it("Function definitions include module entry and arrow functions", () => {
    const result = recordAndDecode();
    if (!result) return;
    const { bundle } = result;

    const funcNames = bundle.functions ?? [];
    // The JS recorder names arrow functions as <arrow> and module-level
    // code as <module>.  Both must be present.  Note: the CTFS
    // canonical container only retains functions actually invoked in
    // the recorded execution — module-level function declarations that
    // are never called (or whose owning module isn't stepped through)
    // do not surface here.  This is a behavioural change from the
    // legacy `trace.json` events sidecar (which surfaced every
    // pre-registered Function record).
    expect(funcNames).toContain("<module>");
    expect(funcNames).toContain("<arrow>");
  });

  it("recorded CTFS trace surfaces the index.js source path", () => {
    const result = recordAndDecode();
    if (!result) return;
    const { bundle } = result;

    const paths = bundle.paths ?? [];
    // The CTFS container retains paths whose code actually executed.
    // index.js is the entry — its module-level loop runs, so it must
    // surface here.  See `trace_paths.json` (the operational sidecar)
    // for the full set of pre-registered manifest paths.
    expect(paths.some((p) => p.includes("index.js"))).toBe(true);
  });

  it("structural integrity: substantial step count for the HCR program", () => {
    const result = recordAndDecode();
    if (!result) return;
    const { bundle } = result;

    // Module + at least one arrow function must surface.
    expect(bundle.functions!.length).toBeGreaterThanOrEqual(2);

    // 12-iteration HCR program should produce a substantial step count.
    expect(bundle.steps!.length).toBeGreaterThan(50);

    // The values table should reflect tracked variables across iterations.
    expect(bundle.values).toBeDefined();
    expect(bundle.values!.length).toBeGreaterThan(0);
  });
});

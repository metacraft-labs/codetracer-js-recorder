import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";

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
    const { stdout, stderr } = runCLI([
      "record",
      workdir,
      "--out-dir",
      outDir,
    ]);

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

    const { stdout } = runCLI([
      "record",
      workdir,
      "--out-dir",
      outDir,
    ]);

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

    const { stdout } = runCLI([
      "record",
      workdir,
      "--out-dir",
      outDir,
    ]);

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

  it("produces a trace directory with non-empty trace data", () => {
    const workdir = prepareWorkdir();
    const outDir = path.join(tmpDir, "traces");

    const { stdout } = runCLI([
      "record",
      workdir,
      "--out-dir",
      outDir,
    ]);

    // Extract trace directory from output
    const traceDirMatch = stdout.match(/Trace written to:\s*(.+)/);
    if (traceDirMatch) {
      const traceDir = traceDirMatch[1].trim();
      expect(fs.existsSync(traceDir)).toBe(true);

      // Check for trace.json or .ct files
      const traceJson = path.join(traceDir, "trace.json");
      const ctFiles = fs
        .readdirSync(traceDir)
        .filter((f) => f.endsWith(".ct"));

      const hasTrace =
        fs.existsSync(traceJson) || ctFiles.length > 0;
      expect(hasTrace).toBe(true);

      if (fs.existsSync(traceJson)) {
        const trace = JSON.parse(fs.readFileSync(traceJson, "utf-8"));
        // Should have events (array or object with events)
        const events = Array.isArray(trace) ? trace : trace.events ?? [];
        expect(events.length).toBeGreaterThan(0);
      }
    }
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { parseTraceEvents } from "../helpers/parse-trace.js";

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
   * Helper: record the HCR program and return parsed trace events + trace dir.
   */
  function recordAndParseTrace(): {
    events: ReturnType<typeof parseTraceEvents>;
    traceDir: string;
  } {
    const workdir = prepareWorkdir();
    const outDir = path.join(tmpDir, "traces");

    const { stdout } = runCLI([
      "record",
      workdir,
      "--out-dir",
      outDir,
      "--format",
      "json",
    ]);

    const traceDirMatch = stdout.match(/Trace written to:\s*(.+)/);
    expect(traceDirMatch).not.toBeNull();
    const traceDir = traceDirMatch![1].trim();

    const traceJsonPath = path.join(traceDir, "trace.json");
    expect(fs.existsSync(traceJsonPath)).toBe(true);

    const rawEvents = JSON.parse(fs.readFileSync(traceJsonPath, "utf-8"));
    const events = parseTraceEvents(rawEvents);

    return { events, traceDir };
  }

  it("trace file exists and contains events", () => {
    const { events, traceDir } = recordAndParseTrace();

    // trace.json must exist (already asserted in helper, but be explicit)
    expect(fs.existsSync(path.join(traceDir, "trace.json"))).toBe(true);

    // Must have a meaningful number of events
    expect(events.length).toBeGreaterThan(0);

    // Should also have trace_metadata.json
    const metadataPath = path.join(traceDir, "trace_metadata.json");
    expect(fs.existsSync(metadataPath)).toBe(true);
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8"));
    expect(metadata.language).toBe("javascript");
  });

  it("trace contains Step events from the HCR program", () => {
    const { events } = recordAndParseTrace();

    const stepEvents = events.filter((e) => e.type === "Step");

    // The program has 12 iterations with multiple statements each,
    // plus module-level code. Should have many step events.
    expect(stepEvents.length).toBeGreaterThan(20);

    // Step events should have line numbers
    for (const step of stepEvents) {
      expect(step.line).toBeDefined();
      expect(typeof step.line).toBe("number");
      expect(step.line as number).toBeGreaterThan(0);
    }
  });

  it("Function definitions include module entries and arrow functions from mymodule", () => {
    const { events } = recordAndParseTrace();

    const funcEvents = events.filter((e) => e.type === "Function");
    const funcNames = funcEvents.map((e) => e.name as string);

    // The JS recorder names arrow functions as <arrow> and module-level
    // code as <module>. mymodule.js exports three arrow functions
    // (compute, transform, aggregate) which appear as <arrow> entries.
    expect(funcNames).toContain("<module>");
    expect(funcNames).toContain("<arrow>");

    // Should have at least 3 arrow functions (compute, transform, aggregate
    // from mymodule.js, and their v2 counterparts after reload)
    const arrowCount = funcNames.filter((n) => n === "<arrow>").length;
    expect(arrowCount).toBeGreaterThanOrEqual(3);

    // Functions from mymodule.js (path_id 1) should include the arrow
    // functions on the expected lines (line 2=compute, 3=transform, 4=aggregate)
    const mymoduleFuncs = funcEvents.filter((e) => e.pathId === 1);
    expect(mymoduleFuncs.length).toBeGreaterThanOrEqual(3);
    const mymoduleLines = mymoduleFuncs.map((e) => e.line as number);
    expect(mymoduleLines).toContain(2); // compute
    expect(mymoduleLines).toContain(3); // transform
    expect(mymoduleLines).toContain(4); // aggregate
  });

  it("Call events cover all 12 iterations with calls to the three module functions", () => {
    const { events } = recordAndParseTrace();

    // Build function lookup: index in the Function event list = function_id
    const funcEvents = events.filter((e) => e.type === "Function");
    const funcPathById = new Map<number, number>();
    const funcLineById = new Map<number, number>();
    let fnIndex = 0;
    for (const fe of funcEvents) {
      funcPathById.set(fnIndex, fe.pathId as number);
      funcLineById.set(fnIndex, fe.line as number);
      fnIndex++;
    }

    const callEvents = events.filter((e) => e.type === "Call");
    expect(callEvents.length).toBeGreaterThan(0);

    // Identify calls to mymodule functions by path_id (1 for mymodule.js,
    // 2 for mymodule_v2.js) and line numbers
    const moduleCallLines = callEvents
      .filter((e) => {
        const pathId = funcPathById.get(e.fnId as number);
        return pathId === 1 || pathId === 2;
      })
      .map((e) => funcLineById.get(e.fnId as number));

    // compute is on line 2, transform on line 3, aggregate on line 4
    // Each is called 12 times (once per iteration)
    const computeCalls = moduleCallLines.filter((l) => l === 2).length;
    const transformCalls = moduleCallLines.filter((l) => l === 3).length;
    const aggregateCalls = moduleCallLines.filter((l) => l === 4).length;

    expect(computeCalls).toBeGreaterThanOrEqual(12);
    expect(transformCalls).toBeGreaterThanOrEqual(12);
    expect(aggregateCalls).toBeGreaterThanOrEqual(12);
  });

  it("source paths reference both index.js and mymodule.js", () => {
    const { events } = recordAndParseTrace();

    const pathEvents = events.filter((e) => e.type === "Path");
    const paths = pathEvents.map((e) => e.path as string);

    // Both source files should be referenced in the trace
    expect(paths.some((p) => p.includes("index.js"))).toBe(true);
    expect(paths.some((p) => p.includes("mymodule.js"))).toBe(true);
  });

  it("structural integrity: balanced Call/Return events and consistent counts", () => {
    const { events } = recordAndParseTrace();

    const callCount = events.filter((e) => e.type === "Call").length;
    const returnCount = events.filter((e) => e.type === "Return").length;
    const stepCount = events.filter((e) => e.type === "Step").length;
    const funcCount = events.filter((e) => e.type === "Function").length;
    const pathCount = events.filter((e) => e.type === "Path").length;

    // Every call should have a matching return
    expect(callCount).toBe(returnCount);
    expect(callCount).toBeGreaterThan(0);

    // Should have at least the 3 module functions + module-level entries
    expect(funcCount).toBeGreaterThanOrEqual(3);

    // Should have at least 1 path (likely 2+: index.js and mymodule.js)
    expect(pathCount).toBeGreaterThanOrEqual(1);

    // Step events should outnumber call events (multiple steps per function call)
    expect(stepCount).toBeGreaterThan(callCount);

    // Total runtime events should be substantial for a 12-iteration program
    const runtimeEvents = events.filter(
      (e) => e.type === "Step" || e.type === "Call" || e.type === "Return",
    );
    expect(runtimeEvents.length).toBeGreaterThan(50);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import {
  ctPrintAvailable,
  ctPrintFull,
  ctPrintJson,
  findCtFile,
  type CtFullBundle,
  type CtFullEvent,
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
    // This test mirrors the cairo / cardano / circom / flow / fuel /
    // leo / miden / move / polkavm / solana / ton (Int round-trip) and
    // evm (Raw byte) precedents — record a real program, then convert
    // the produced CTFS bundle through `ct-print` and assert on the
    // textual representation.  See `Recorder-CLI-Conventions.md` §4 —
    // CTFS-only output, with `ct print` as the canonical conversion
    // tool.
    //
    // Two layers of assertions:
    //
    //   1. **Structural anchors** (legacy `--json` layer): paths /
    //      functions / steps / ioEvents are present.  This is a safety
    //      net so a regression in the textual rendering is caught even
    //      if --full's JSON shape evolves.
    //
    //   2. **Exact decoded values** (the layer enabled by
    //      `ct-print --full`): the canonical fixture `examples/hello.js`
    //      executes
    //          function greet(name)            // line 4
    //            var message = "Hello, " + name + "!";   // line 5
    //            return message;               // line 6
    //          var result = greet("World");    // line 9
    //          console.log(result);            // line 10
    //      Each binding must surface in the trace as a step / call_entry
    //      event with a decoded ValueRecord.  In particular:
    //        - greet's call_entry args carry `name = "World"` decoded
    //          as `ValueRecord::String { text: "World" }`.
    //        - greet's call_exit return_value is the concatenated
    //          string `"Hello, World!"` decoded as `ValueRecord::Raw`
    //          (the JS recorder snapshots step-level / return values
    //          using the textual `Raw` form rather than the typed
    //          `String` variant — this is current recorder behaviour;
    //          if it changes, the strict invariant below fires).
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

    // -----------------------------------------------------------------
    // Layer 1 (legacy): ct-print --json — substring presence checks.
    // -----------------------------------------------------------------
    const bundle = ctPrintJson(ctFile) as CtPrintBundle;

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

    // -----------------------------------------------------------------
    // Layer 2 (the upgrade): ct-print --full — exact decoded values.
    // -----------------------------------------------------------------
    const full: CtFullBundle = ctPrintFull(ctFile);

    // ----- Function table: <module> + greet ---------------------------
    expect(full.functions).toContain("<module>");
    expect(full.functions).toContain("greet");

    // The `greet` function name surfaces as a bare identifier — the JS
    // recorder does not prefix it with a module path.  Use ends_with to
    // stay tolerant of any future decorator / namespace prefixing
    // (mirrors the cairo `::compute` / `::main` precedent).
    expect(full.functions.some((f) => f.endsWith("greet"))).toBe(true);
    expect(full.functions.some((f) => f.endsWith("<module>"))).toBe(true);

    // ----- Path table: the canonical fixture path must appear ---------
    // Node.js path equivalent of cairo's `ends_with(".cairo")` —
    // assert the bundle records `examples/hello.js` somewhere.
    expect(full.paths.some((p) => p.endsWith("examples/hello.js"))).toBe(true);

    // ----- Step / call counts -----------------------------------------
    // hello.js produces a stable number of recorder events:
    //   - 7 step events (1 thread-start synthetic, 1 module prologue,
    //     1 line 4 (greet entry), 1 line 9 (greet body), 1 line 5
    //     (return), 1 line 6 (post-call), 1 line 10 (console.log))
    //   - 2 call entries (synthetic <module> wrapper + greet)
    //   - 1 io event (the console.log("Hello, World!") write to stdout)
    // These are stable properties of the canonical fixture under the
    // current JS recorder — if they change, that's a real regression
    // to investigate, not a flake.
    expect(full.counts.steps).toBe(7);
    expect(full.counts.calls).toBe(2);
    expect(full.counts.io_events).toBe(1);

    // ----- Call sequence: <module> first, then greet ------------------
    const callSequence: string[] = full.events
      .filter(
        (e): e is Extract<CtFullEvent, { kind: "call_entry" }> =>
          e.kind === "call_entry",
      )
      .map((e) => e.function);
    expect(callSequence).toHaveLength(2);
    // The synthetic <module> frame is always entered first (it wraps
    // every JS program the recorder instruments).
    expect(callSequence[0].endsWith("<module>")).toBe(true);
    expect(callSequence[1].endsWith("greet")).toBe(true);

    // ----- Strict ValueRecord variant invariant -----------------------
    // Every step var / call arg / return value that surfaces must carry
    // a `value.kind` field.  For the JS recorder today, values decode
    // as one of: String / Raw / Int / Bool / Float / None / Void /
    // Sequence / Struct.  We don't pin a single kind globally because
    // the JS recorder uses `String` for typed string args (call_entry)
    // but the textual `Raw` form for step-var snapshots and return
    // values — both are valid current behaviour.  Instead we assert
    // that EVERY value belongs to the expected, finite set of kinds.
    // If a brand-new variant appears (e.g. BigInt support lands), this
    // assertion fires loudly so the test author can extend the
    // exact-value layer rather than silently weakening the check.
    const allowedKinds = new Set([
      "Int",
      "Float",
      "String",
      "Bool",
      "Raw",
      "None",
      "Void",
      "Sequence",
      "Struct",
    ]);
    for (const ev of full.events) {
      if (ev.kind === "step") {
        for (const v of ev.vars) {
          expect(
            allowedKinds.has(v.value.kind),
            `step ${ev.step_index} var \`${v.varname}\` has unknown ` +
              `value.kind=${v.value.kind}; if a new ValueRecord variant ` +
              `has landed for the JS recorder, extend this test to assert ` +
              `on it explicitly rather than weakening the check`,
          ).toBe(true);
        }
      } else if (ev.kind === "call_entry") {
        for (const a of ev.args) {
          expect(
            allowedKinds.has(a.value.kind),
            `call_entry to \`${ev.function}\` arg \`${a.varname}\` has ` +
              `unknown value.kind=${a.value.kind}`,
          ).toBe(true);
        }
      } else if (ev.kind === "call_exit") {
        expect(
          allowedKinds.has(ev.return_value.kind),
          `call_exit from \`${ev.function}\` has unknown ` +
            `return_value.kind=${ev.return_value.kind}`,
        ).toBe(true);
      }
    }

    // ----- Exact decoded call-arg values ------------------------------
    // The greet("World") call must surface its `name` argument with
    // the `String` ValueRecord variant decoded back to the literal
    // "World".  The JS recorder uses ValueRecord::String for typed
    // call arguments (ct-print --full decodes it to
    // `{"kind":"String","text":"World",...}`).  This is the JS
    // analogue of cairo's `(a, 10)` Int round-trip.
    const greetCall = full.events.find(
      (e): e is Extract<CtFullEvent, { kind: "call_entry" }> =>
        e.kind === "call_entry" && e.function.endsWith("greet"),
    );
    expect(greetCall).toBeDefined();
    const nameArg = greetCall!.args.find((a) => a.varname === "name");
    expect(nameArg).toBeDefined();
    expect(nameArg!.value.kind).toBe("String");
    expect(nameArg!.value.text).toBe("World");

    // ----- Exact decoded return value ---------------------------------
    // greet("World") returns the concatenated string "Hello, World!".
    // The JS recorder snapshots return values via ValueRecord::Raw
    // (textual rendering) — the strict `kind === "Raw"` invariant
    // means: if a future recorder upgrade emits ValueRecord::String
    // (or any other variant), this test fails loudly and the next
    // maintainer extends the assertion to the new variant rather than
    // silently accepting it.
    const greetExit = full.events.find(
      (e): e is Extract<CtFullEvent, { kind: "call_exit" }> =>
        e.kind === "call_exit" && e.function.endsWith("greet"),
    );
    expect(greetExit).toBeDefined();
    expect(greetExit!.return_value.kind).toBe("Raw");
    expect(greetExit!.return_value.r).toBe("Hello, World!");

    // ----- Exact (varname, value) step-var pairs ----------------------
    // Collect every (varname, value-text) pair surfaced by step events.
    // The JS recorder snapshots `name` inside greet's body at line 9
    // as `ValueRecord::Raw { r: "World" }` — this is the JS analogue
    // of the cairo `a=10, b=32, sum_val=42, ...` round-trip.  If a
    // future recorder upgrade emits ValueRecord::String here instead,
    // the strict kind invariant above (and the explicit assertion
    // below) fires loudly.
    interface StepVarObservation {
      name: string;
      kind: string;
      text: string | undefined;
    }
    const observedStepVars: StepVarObservation[] = [];
    for (const ev of full.events) {
      if (ev.kind !== "step") continue;
      for (const v of ev.vars) {
        observedStepVars.push({
          name: v.varname,
          kind: v.value.kind,
          // Both `String.text` and `Raw.r` carry textual payload — the
          // recorder picks one or the other.  Accept whichever is
          // populated so the assertion stays readable.
          text: v.value.text ?? v.value.r,
        });
      }
    }

    // The canonical (var, kind, value) tuples for hello.js — these
    // anchor the JS recorder's exact-value contract:
    //   * `name = "World"` inside greet's body (Raw form).
    const expectedStepVars: StepVarObservation[] = [
      { name: "name", kind: "Raw", text: "World" },
    ];
    for (const want of expectedStepVars) {
      const found = observedStepVars.some(
        (o) =>
          o.name === want.name && o.kind === want.kind && o.text === want.text,
      );
      expect(
        found,
        `expected step variable \`${want.name}\` = ${want.kind} ` +
          `\`${want.text}\` in --full output; observed = ` +
          JSON.stringify(observedStepVars),
      ).toBe(true);
    }

    // ----- IO event: console.log("Hello, World!") --------------------
    // The single io event must be a stdout write of "Hello, World!".
    const ioEvents = full.events.filter(
      (e): e is Extract<CtFullEvent, { kind: "io" }> => e.kind === "io",
    );
    expect(ioEvents).toHaveLength(1);
    expect(ioEvents[0].io_kind).toBe("ioStdout");
    expect(ioEvents[0].text).toBe("Hello, World!");
    expect(ioEvents[0].bytes_len).toBe("Hello, World!".length);
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

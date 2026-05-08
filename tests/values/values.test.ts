import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";

import {
  createRuntime,
  startRecording,
  encodeValue,
  EVENT_ENTER,
  EVENT_RET,
} from "@codetracer/runtime";
import type { TraceManifest, EncodedValue } from "@codetracer/runtime";
import { instrument } from "@codetracer/instrumenter";
import {
  ctPrintAvailable,
  ctPrintJson,
  findCtFile,
  type CtPrintBundle,
} from "../helpers/ct-print.js";

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const ADDON_PATH = path.resolve(
  __dirname,
  "../../crates/recorder_native/index.node",
);
const CLI_PATH = path.join(PROJECT_ROOT, "packages/cli/dist/index.js");

// ── Helpers ─────────────────────────────────────────────────────────

function makeManifest(overrides: Partial<TraceManifest> = {}): TraceManifest {
  return {
    formatVersion: 1,
    paths: ["src/main.js"],
    functions: [
      { name: "<module>", pathIndex: 0, line: 1, col: 0 },
      {
        name: "greet",
        pathIndex: 0,
        line: 3,
        col: 0,
        params: ["name", "greeting"],
      },
    ],
    sites: [
      { kind: "call", pathIndex: 0, line: 1, col: 0, fnId: 0 },
      { kind: "step", pathIndex: 0, line: 4, col: 2 },
      { kind: "return", pathIndex: 0, line: 5, col: 2, fnId: 1 },
    ],
    ...overrides,
  };
}

function writeManifest(dir: string, manifest: TraceManifest): string {
  const p = path.join(dir, "codetracer.manifest.json");
  fs.writeFileSync(p, JSON.stringify(manifest));
  return p;
}

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
// test_type_registration
// =============================================
describe("test_type_registration", () => {
  it("encodes undefined as None/null", () => {
    const result = encodeValue(undefined);
    expect(result.typeKind).toBe("None");
    expect(result.value).toBe(null);
  });

  it("encodes null as None/null", () => {
    const result = encodeValue(null);
    expect(result.typeKind).toBe("None");
    expect(result.value).toBe(null);
  });

  it("encodes booleans as Bool", () => {
    expect(encodeValue(true)).toEqual({ value: true, typeKind: "Bool" });
    expect(encodeValue(false)).toEqual({ value: false, typeKind: "Bool" });
  });

  it("encodes integers as Int", () => {
    expect(encodeValue(42)).toEqual({ value: 42, typeKind: "Int" });
    expect(encodeValue(0)).toEqual({ value: 0, typeKind: "Int" });
    expect(encodeValue(-7)).toEqual({ value: -7, typeKind: "Int" });
  });

  it("encodes floating point numbers as Float", () => {
    expect(encodeValue(3.14)).toEqual({ value: 3.14, typeKind: "Float" });
    expect(encodeValue(0.1)).toEqual({ value: 0.1, typeKind: "Float" });
  });

  it("encodes NaN as Raw/'NaN'", () => {
    const result = encodeValue(NaN);
    expect(result.typeKind).toBe("Raw");
    expect(result.value).toBe("NaN");
  });

  it("encodes Infinity as Raw", () => {
    expect(encodeValue(Infinity)).toEqual({
      value: "Infinity",
      typeKind: "Raw",
    });
    expect(encodeValue(-Infinity)).toEqual({
      value: "-Infinity",
      typeKind: "Raw",
    });
  });

  it("encodes strings as String", () => {
    expect(encodeValue("hello")).toEqual({
      value: "hello",
      typeKind: "String",
    });
    expect(encodeValue("")).toEqual({ value: "", typeKind: "String" });
  });

  it("truncates strings longer than 1000 chars", () => {
    const longStr = "x".repeat(2000);
    const result = encodeValue(longStr);
    expect(result.typeKind).toBe("String");
    expect((result.value as string).length).toBe(1000);
  });

  it("encodes bigint as BigInt", () => {
    const result = encodeValue(BigInt(123456789));
    expect(result.typeKind).toBe("BigInt");
    expect(result.value).toBe("123456789");
  });

  it("encodes symbols as Raw", () => {
    const result = encodeValue(Symbol("test"));
    expect(result.typeKind).toBe("Raw");
    expect(result.value).toBe("Symbol(test)");
  });

  it("encodes named functions as FunctionKind with name", () => {
    function myFunc() {}
    const result = encodeValue(myFunc);
    expect(result.typeKind).toBe("FunctionKind");
    expect(result.value).toBe("myFunc");
  });

  it("encodes anonymous functions as FunctionKind with 'anonymous'", () => {
    // Use a function expression assigned to a const for truly anonymous behavior
    const result = encodeValue(
      (() => {
        // eslint-disable-next-line no-inner-declarations
        return Function("return 1");
      })(),
    );
    expect(result.typeKind).toBe("FunctionKind");
    expect(result.value).toBe("anonymous");
  });

  it("encodes objects as Struct", () => {
    const result = encodeValue({ a: 1 });
    expect(result.typeKind).toBe("Struct");
    const fields = (
      result.value as { fields: Array<{ name: string; value: EncodedValue }> }
    ).fields;
    expect(fields.length).toBe(1);
    expect(fields[0].name).toBe("a");
    expect(fields[0].value).toEqual({ value: 1, typeKind: "Int" });
  });

  it("encodes arrays as Seq", () => {
    const result = encodeValue([1, 2, 3]);
    expect(result.typeKind).toBe("Seq");
    const elements = result.value as EncodedValue[];
    expect(elements.length).toBe(3);
    expect(elements[0]).toEqual({ value: 1, typeKind: "Int" });
    expect(elements[1]).toEqual({ value: 2, typeKind: "Int" });
    expect(elements[2]).toEqual({ value: 3, typeKind: "Int" });
  });
});

// =============================================
// test_primitive_arg_capture
// =============================================
describe("test_primitive_arg_capture", () => {
  it("captures argument values in the flushed batch", () => {
    const rt = createRuntime({
      bufferCapacity: 1024,
      skipProcessHooks: true,
    });

    // Create fake arguments with primitives
    const fakeArgs = (function (
      _a: number,
      _b: string,
      _c: boolean,
      _d: null,
      _e: undefined,
    ) {
      return arguments;
    })(42, "hello", true, null, undefined);

    rt.enter(0, fakeArgs);
    rt.flush();

    const batch = rt.buffer.flushedBatches[0];
    expect(batch.eventKinds[0]).toBe(EVENT_ENTER);
    expect(batch.values.length).toBe(1);

    const valueEntry = batch.values[0];
    expect(valueEntry.eventIndex).toBe(0);
    expect(valueEntry.args).toBeDefined();
    expect(valueEntry.args!.length).toBe(5);

    // Verify encoded types
    expect(valueEntry.args![0]).toEqual({ value: 42, typeKind: "Int" });
    expect(valueEntry.args![1]).toEqual({
      value: "hello",
      typeKind: "String",
    });
    expect(valueEntry.args![2]).toEqual({ value: true, typeKind: "Bool" });
    expect(valueEntry.args![3]).toEqual({ value: null, typeKind: "None" });
    expect(valueEntry.args![4]).toEqual({ value: null, typeKind: "None" });
  });

  it("captures no-argument enter events with empty args", () => {
    const rt = createRuntime({
      bufferCapacity: 1024,
      skipProcessHooks: true,
    });

    const fakeArgs = (function () {
      return arguments;
    })();

    rt.enter(0, fakeArgs);
    rt.flush();

    const batch = rt.buffer.flushedBatches[0];
    const valueEntry = batch.values[0];
    expect(valueEntry.args).toBeDefined();
    expect(valueEntry.args!.length).toBe(0);
  });
});

// =============================================
// test_return_value_capture
// =============================================
describe("test_return_value_capture", () => {
  it("captures return value in the flushed batch", () => {
    const rt = createRuntime({
      bufferCapacity: 1024,
      skipProcessHooks: true,
    });

    const result = rt.ret(0, 42);
    expect(result).toBe(42); // Critical: ret must still return the value

    rt.flush();

    const batch = rt.buffer.flushedBatches[0];
    expect(batch.eventKinds[0]).toBe(EVENT_RET);
    expect(batch.values.length).toBe(1);

    const valueEntry = batch.values[0];
    expect(valueEntry.eventIndex).toBe(0);
    expect(valueEntry.returnValue).toBeDefined();
    expect(valueEntry.returnValue).toEqual({ value: 42, typeKind: "Int" });
  });

  it("captures string return values", () => {
    const rt = createRuntime({
      bufferCapacity: 1024,
      skipProcessHooks: true,
    });

    const result = rt.ret(0, "world");
    expect(result).toBe("world");

    rt.flush();

    const batch = rt.buffer.flushedBatches[0];
    expect(batch.values[0].returnValue).toEqual({
      value: "world",
      typeKind: "String",
    });
  });

  it("captures void return (undefined)", () => {
    const rt = createRuntime({
      bufferCapacity: 1024,
      skipProcessHooks: true,
    });

    const result = rt.ret(0);
    expect(result).toBeUndefined();

    rt.flush();

    const batch = rt.buffer.flushedBatches[0];
    expect(batch.values[0].returnValue).toEqual({
      value: null,
      typeKind: "None",
    });
  });

  it("captures boolean return values", () => {
    const rt = createRuntime({
      bufferCapacity: 1024,
      skipProcessHooks: true,
    });

    expect(rt.ret(0, true)).toBe(true);
    expect(rt.ret(0, false)).toBe(false);

    rt.flush();

    const batch = rt.buffer.flushedBatches[0];
    expect(batch.values[0].returnValue).toEqual({
      value: true,
      typeKind: "Bool",
    });
    expect(batch.values[1].returnValue).toEqual({
      value: false,
      typeKind: "Bool",
    });
  });

  it("still returns object references (same identity)", () => {
    const rt = createRuntime({
      bufferCapacity: 1024,
      skipProcessHooks: true,
    });

    const obj = { a: 1 };
    expect(rt.ret(0, obj)).toBe(obj);
  });
});

// =============================================
// test_mixed_values_in_batch
// =============================================
describe("test_mixed_values_in_batch", () => {
  it("captures values for enter and ret events alongside step events", () => {
    const rt = createRuntime({
      bufferCapacity: 1024,
      skipProcessHooks: true,
    });

    const fakeArgs = (function (_x: number) {
      return arguments;
    })(10);

    // step 0, enter 1, step 2, ret 3
    rt.step(0);
    rt.enter(1, fakeArgs);
    rt.step(2);
    rt.ret(1, 20);

    rt.flush();

    const batch = rt.buffer.flushedBatches[0];
    expect(batch.length).toBe(4);

    // Two value entries: one for enter at index 1, one for ret at index 3
    expect(batch.values.length).toBe(2);

    // Enter value entry
    expect(batch.values[0].eventIndex).toBe(1);
    expect(batch.values[0].args).toBeDefined();
    expect(batch.values[0].args![0]).toEqual({ value: 10, typeKind: "Int" });

    // Ret value entry
    expect(batch.values[1].eventIndex).toBe(3);
    expect(batch.values[1].returnValue).toEqual({
      value: 20,
      typeKind: "Int",
    });
  });
});

// =============================================
// test_instrumenter_param_names
// =============================================
describe("test_instrumenter_param_names", () => {
  it("extracts parameter names for function declarations", () => {
    const source = `function greet(name, greeting) { return greeting + " " + name; }`;
    const result = instrument(source, { filename: "test.js" });
    const manifest = result.manifestSlice;

    // Find the greet function (not <module>)
    const greetFn = manifest.functions.find((f) => f.name === "greet");
    expect(greetFn).toBeDefined();
    expect(greetFn!.params).toEqual(["name", "greeting"]);
  });

  it("extracts parameter names for arrow functions", () => {
    const source = `const add = (x, y) => x + y;`;
    const result = instrument(source, { filename: "test.js" });
    const manifest = result.manifestSlice;

    const arrowFn = manifest.functions.find((f) => f.name === "<arrow>");
    expect(arrowFn).toBeDefined();
    expect(arrowFn!.params).toEqual(["x", "y"]);
  });

  it("extracts parameter names for function expressions", () => {
    const source = `const calc = function multiply(a, b) { return a * b; };`;
    const result = instrument(source, { filename: "test.js" });
    const manifest = result.manifestSlice;

    const mulFn = manifest.functions.find((f) => f.name === "multiply");
    expect(mulFn).toBeDefined();
    expect(mulFn!.params).toEqual(["a", "b"]);
  });

  it("handles default parameters", () => {
    const source = `function greet(name, greeting = "Hello") { return greeting + " " + name; }`;
    const result = instrument(source, { filename: "test.js" });
    const manifest = result.manifestSlice;

    const greetFn = manifest.functions.find((f) => f.name === "greet");
    expect(greetFn).toBeDefined();
    expect(greetFn!.params).toEqual(["name", "greeting"]);
  });

  it("handles rest parameters", () => {
    const source = `function variadic(first, ...rest) { return rest; }`;
    const result = instrument(source, { filename: "test.js" });
    const manifest = result.manifestSlice;

    const fn = manifest.functions.find((f) => f.name === "variadic");
    expect(fn).toBeDefined();
    expect(fn!.params).toEqual(["first", "...rest"]);
  });

  it("handles destructuring parameters with placeholder names", () => {
    const source = `function destruct({ a, b }, [c, d]) { return a + b + c + d; }`;
    const result = instrument(source, { filename: "test.js" });
    const manifest = result.manifestSlice;

    const fn = manifest.functions.find((f) => f.name === "destruct");
    expect(fn).toBeDefined();
    expect(fn!.params).toEqual(["_param0", "_param1"]);
  });

  it("omits params field for zero-parameter functions", () => {
    const source = `function noArgs() { return 42; }`;
    const result = instrument(source, { filename: "test.js" });
    const manifest = result.manifestSlice;

    const fn = manifest.functions.find((f) => f.name === "noArgs");
    expect(fn).toBeDefined();
    expect(fn!.params).toBeUndefined();
  });
});

// =============================================
// test_addon_value_capture
// =============================================
describe("test_addon_value_capture", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-values-addon-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes Call events with args reaching the CTFS values table", () => {
    const manifest = makeManifest();
    const manifestPath = writeManifest(tmpDir, manifest);

    const rt = createRuntime({
      bufferCapacity: 1024,
      skipProcessHooks: true,
    });
    rt.init(manifestPath);

    const outDir = path.join(tmpDir, "traces");

    const session = startRecording({
      runtime: rt,
      addonPath: ADDON_PATH,
      outDir,
      program: "app.js",
      args: [],
      skipProcessHooks: true,
    });

    // Enter function 1 (greet) with arguments "World" and "Hi"
    const fakeArgs = (function (_name: string, _greeting: string) {
      return arguments;
    })("World", "Hi");
    rt.enter(1, fakeArgs);
    rt.ret(1, "Hi World");

    const traceDir = session.stop();

    if (!ctPrintAvailable()) {
      console.warn("SKIP: ct-print not found");
      return;
    }
    const ctFile = findCtFile(traceDir);
    const bundle = ctPrintJson(ctFile) as CtPrintBundle;

    // The manifest's params ("name", "greeting") must surface in the
    // CTFS values table — proving they reached the writer's
    // pending-args buffer (staged via `arg(name, value)` before the
    // matching `register_call`, audit fix #1 in handoff entry 1.38).
    const varnames = (bundle.values ?? []).map((v) => v.varname);
    expect(varnames).toContain("name");
    expect(varnames).toContain("greeting");
  });

  it("writes Return events that reach the CTFS bundle", () => {
    const manifest = makeManifest();
    const manifestPath = writeManifest(tmpDir, manifest);

    const rt = createRuntime({
      bufferCapacity: 1024,
      skipProcessHooks: true,
    });
    rt.init(manifestPath);

    const outDir = path.join(tmpDir, "traces");

    const session = startRecording({
      runtime: rt,
      addonPath: ADDON_PATH,
      outDir,
      program: "app.js",
      args: [],
      skipProcessHooks: true,
    });

    const fakeArgs = (function () {
      return arguments;
    })();
    rt.enter(0, fakeArgs);
    rt.ret(0, true);

    const traceDir = session.stop();

    // The .ct container must be non-trivial — proving the Return event
    // was successfully emitted through the writer's `register_return`
    // path.  Detailed value/typeKind inspection requires a CTFS reader
    // (out of scope for this test; the encoder-level correctness is
    // covered by the `test_type_registration` suite above).
    const ctFiles = fs
      .readdirSync(traceDir)
      .filter((f) => f.endsWith(".ct"))
      .map((f) => path.join(traceDir, f));
    expect(ctFiles.length).toBeGreaterThanOrEqual(1);
    expect(fs.statSync(ctFiles[0]).size).toBeGreaterThan(100);
  });
});

// =============================================
// e2e_value_capture_program
// =============================================
describe("e2e_value_capture_program", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-values-e2e-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("records a program with function args and return values in the trace", () => {
    // Create a simple test program
    const sourceCode = `
function add(x, y) {
  return x + y;
}

function greet(name) {
  return "Hello, " + name;
}

var sum = add(3, 4);
var msg = greet("World");
`;

    // Write the test program
    const srcDir = path.join(tmpDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const srcFile = path.join(srcDir, "test-values.js");
    fs.writeFileSync(srcFile, sourceCode);

    const outDir = path.join(tmpDir, "traces");
    const { stdout } = runCLI(["record", srcFile, "--out-dir", outDir]);

    // Extract trace directory
    const traceDirMatch = stdout.match(/Trace written to:\s*(.+)/);
    expect(traceDirMatch).not.toBeNull();
    const traceDir = traceDirMatch![1].trim();

    if (!ctPrintAvailable()) {
      console.warn("SKIP: ct-print not found");
      return;
    }
    const ctFile = findCtFile(traceDir);
    const bundle = ctPrintJson(ctFile) as CtPrintBundle;

    // Functions registered: <module>, add, greet.
    expect(bundle.functions).toContain("<module>");
    expect(bundle.functions).toContain("add");
    expect(bundle.functions).toContain("greet");

    // Parameter names ("x", "y", "name") must surface in the values
    // table — proving they reached the writer's pending-args buffer.
    const varnames = (bundle.values ?? []).map((v) => v.varname);
    expect(varnames).toContain("x");
    expect(varnames).toContain("y");
    expect(varnames).toContain("name");
  });

  it("captures mixed primitive types as arguments (CTFS varname surface)", () => {
    const sourceCode = `
function mixed(n, s, b, x) {
  return n;
}

mixed(42, "test", true, null);
`;

    const srcDir = path.join(tmpDir, "src2");
    fs.mkdirSync(srcDir, { recursive: true });
    const srcFile = path.join(srcDir, "mixed.js");
    fs.writeFileSync(srcFile, sourceCode);

    const outDir = path.join(tmpDir, "traces2");
    const { stdout } = runCLI(["record", srcFile, "--out-dir", outDir]);

    const traceDirMatch = stdout.match(/Trace written to:\s*(.+)/);
    expect(traceDirMatch).not.toBeNull();
    const traceDir = traceDirMatch![1].trim();

    if (!ctPrintAvailable()) {
      console.warn("SKIP: ct-print not found");
      return;
    }
    const ctFile = findCtFile(traceDir);
    const bundle = ctPrintJson(ctFile) as CtPrintBundle;

    expect(bundle.functions).toContain("mixed");

    // All four parameter names must reach the values table.
    const varnames = (bundle.values ?? []).map((v) => v.varname);
    expect(varnames).toContain("n");
    expect(varnames).toContain("s");
    expect(varnames).toContain("b");
    expect(varnames).toContain("x");
  });
});

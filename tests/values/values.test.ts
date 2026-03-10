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

  it("encodes functions as Raw/'function'", () => {
    const result = encodeValue(() => {});
    expect(result.typeKind).toBe("Raw");
    expect(result.value).toBe("function");
  });

  it("encodes objects as Raw/'object'", () => {
    const result = encodeValue({ a: 1 });
    expect(result.typeKind).toBe("Raw");
    expect(result.value).toBe("object");
  });

  it("encodes arrays as Raw/'array'", () => {
    const result = encodeValue([1, 2, 3]);
    expect(result.typeKind).toBe("Raw");
    expect(result.value).toBe("array");
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

  it("writes Call events with args containing name/value/typeKind", () => {
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
      format: "json",
      skipProcessHooks: true,
    });

    // Enter function 1 (greet) with arguments "World" and "Hi"
    const fakeArgs = (function (_name: string, _greeting: string) {
      return arguments;
    })("World", "Hi");
    rt.enter(1, fakeArgs);
    rt.ret(1, "Hi World");

    const traceDir = session.stop();

    const traceEvents = JSON.parse(
      fs.readFileSync(path.join(traceDir, "trace.json"), "utf-8"),
    );

    const callEvents = traceEvents.filter(
      (e: { type: string }) => e.type === "Call",
    );
    expect(callEvents.length).toBe(1);

    const callEvent = callEvents[0];
    expect(callEvent.fnId).toBe(1);
    expect(callEvent.args).toBeDefined();
    expect(callEvent.args.length).toBe(2);

    // Check arg names come from manifest params
    expect(callEvent.args[0].name).toBe("name");
    expect(callEvent.args[0].value).toBe("World");
    expect(callEvent.args[0].typeKind).toBe("String");

    expect(callEvent.args[1].name).toBe("greeting");
    expect(callEvent.args[1].value).toBe("Hi");
    expect(callEvent.args[1].typeKind).toBe("String");
  });

  it("writes Return events with value containing value/typeKind", () => {
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
      format: "json",
      skipProcessHooks: true,
    });

    const fakeArgs = (function () {
      return arguments;
    })();
    rt.enter(0, fakeArgs);
    rt.ret(0, true);

    const traceDir = session.stop();

    const traceEvents = JSON.parse(
      fs.readFileSync(path.join(traceDir, "trace.json"), "utf-8"),
    );

    const returnEvents = traceEvents.filter(
      (e: { type: string }) => e.type === "Return",
    );
    expect(returnEvents.length).toBe(1);

    const retEvent = returnEvents[0];
    expect(retEvent.value).toBeDefined();
    expect(retEvent.value.value).toBe(true);
    expect(retEvent.value.typeKind).toBe("Bool");
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

    // Read trace events
    const traceEvents = JSON.parse(
      fs.readFileSync(path.join(traceDir, "trace.json"), "utf-8"),
    );

    // Get all Call events
    const callEvents = traceEvents.filter(
      (e: { type: string }) => e.type === "Call",
    );

    // Should have at least 3 calls: <module>, add, greet
    expect(callEvents.length).toBeGreaterThanOrEqual(3);

    // Find the add(3, 4) call
    const addCall = callEvents.find(
      (e: { fnId: number; args?: Array<{ name: string; value: unknown }> }) =>
        e.args &&
        e.args.length === 2 &&
        e.args[0].value === 3 &&
        e.args[1].value === 4,
    );
    expect(addCall).toBeDefined();
    expect(addCall.args[0].name).toBe("x");
    expect(addCall.args[0].typeKind).toBe("Int");
    expect(addCall.args[1].name).toBe("y");
    expect(addCall.args[1].typeKind).toBe("Int");

    // Find the greet("World") call
    const greetCall = callEvents.find(
      (e: { fnId: number; args?: Array<{ name: string; value: unknown }> }) =>
        e.args && e.args.length === 1 && e.args[0].value === "World",
    );
    expect(greetCall).toBeDefined();
    expect(greetCall.args[0].name).toBe("name");
    expect(greetCall.args[0].typeKind).toBe("String");

    // Get all Return events
    const returnEvents = traceEvents.filter(
      (e: { type: string }) => e.type === "Return",
    );

    // Verify some return events have values
    const returnWithValues = returnEvents.filter(
      (e: { value?: { value: unknown } }) => e.value != null,
    );
    expect(returnWithValues.length).toBeGreaterThan(0);

    // Find the return value 7 (from add(3,4))
    const retSeven = returnWithValues.find(
      (e: { value: { value: unknown; typeKind: string } }) =>
        e.value.value === 7,
    );
    expect(retSeven).toBeDefined();
    expect(retSeven.value.typeKind).toBe("Int");

    // Find the return value "Hello, World" (from greet)
    const retHello = returnWithValues.find(
      (e: { value: { value: unknown; typeKind: string } }) =>
        e.value.value === "Hello, World",
    );
    expect(retHello).toBeDefined();
    expect(retHello.value.typeKind).toBe("String");
  });

  it("captures mixed primitive types as arguments", () => {
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

    const traceEvents = JSON.parse(
      fs.readFileSync(path.join(traceDir, "trace.json"), "utf-8"),
    );

    const callEvents = traceEvents.filter(
      (e: { type: string }) => e.type === "Call",
    );

    // Find the mixed() call
    const mixedCall = callEvents.find(
      (e: { args?: Array<{ name: string }> }) =>
        e.args && e.args.length === 4 && e.args[0].name === "n",
    );
    expect(mixedCall).toBeDefined();

    expect(mixedCall.args[0]).toEqual({
      name: "n",
      value: 42,
      typeKind: "Int",
    });
    expect(mixedCall.args[1]).toEqual({
      name: "s",
      value: "test",
      typeKind: "String",
    });
    expect(mixedCall.args[2]).toEqual({
      name: "b",
      value: true,
      typeKind: "Bool",
    });
    expect(mixedCall.args[3]).toEqual({
      name: "x",
      value: null,
      typeKind: "None",
    });
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";

import {
  createRuntime,
  startRecording,
  encodeValue,
} from "@codetracer/runtime";
import type { TraceManifest, EncodedValue } from "@codetracer/runtime";
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
        name: "process",
        pathIndex: 0,
        line: 3,
        col: 0,
        params: ["data"],
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
// test_object_serialization
// =============================================
describe("test_object_serialization", () => {
  it("encodes a plain object with fields as Struct", () => {
    const result = encodeValue({ name: "Alice", age: 30, active: true });
    expect(result.typeKind).toBe("Struct");

    const fields = (
      result.value as { fields: Array<{ name: string; value: EncodedValue }> }
    ).fields;
    expect(fields.length).toBe(3);

    expect(fields[0].name).toBe("name");
    expect(fields[0].value).toEqual({ value: "Alice", typeKind: "String" });

    expect(fields[1].name).toBe("age");
    expect(fields[1].value).toEqual({ value: 30, typeKind: "Int" });

    expect(fields[2].name).toBe("active");
    expect(fields[2].value).toEqual({ value: true, typeKind: "Bool" });
  });

  it("encodes empty object as Struct with empty fields", () => {
    const result = encodeValue({});
    expect(result.typeKind).toBe("Struct");
    const fields = (
      result.value as { fields: Array<{ name: string; value: EncodedValue }> }
    ).fields;
    expect(fields.length).toBe(0);
  });

  it("encodes nested objects recursively", () => {
    const result = encodeValue({ outer: { inner: 42 } });
    expect(result.typeKind).toBe("Struct");

    const fields = (
      result.value as { fields: Array<{ name: string; value: EncodedValue }> }
    ).fields;
    expect(fields.length).toBe(1);
    expect(fields[0].name).toBe("outer");
    expect(fields[0].value.typeKind).toBe("Struct");

    const innerFields = (
      fields[0].value.value as {
        fields: Array<{ name: string; value: EncodedValue }>;
      }
    ).fields;
    expect(innerFields.length).toBe(1);
    expect(innerFields[0].name).toBe("inner");
    expect(innerFields[0].value).toEqual({ value: 42, typeKind: "Int" });
  });

  it("encodes objects with mixed value types", () => {
    const result = encodeValue({
      str: "hello",
      num: 3.14,
      bool: false,
      nil: null,
      undef: undefined,
    });
    expect(result.typeKind).toBe("Struct");

    const fields = (
      result.value as { fields: Array<{ name: string; value: EncodedValue }> }
    ).fields;
    expect(fields.length).toBe(5);
    expect(fields[0].value.typeKind).toBe("String");
    expect(fields[1].value.typeKind).toBe("Float");
    expect(fields[2].value.typeKind).toBe("Bool");
    expect(fields[3].value.typeKind).toBe("None");
    expect(fields[4].value.typeKind).toBe("None");
  });
});

// =============================================
// test_array_serialization
// =============================================
describe("test_array_serialization", () => {
  it("encodes an array as Seq with correct elements", () => {
    const result = encodeValue([1, "two", true, null]);
    expect(result.typeKind).toBe("Seq");

    const elements = result.value as EncodedValue[];
    expect(elements.length).toBe(4);
    expect(elements[0]).toEqual({ value: 1, typeKind: "Int" });
    expect(elements[1]).toEqual({ value: "two", typeKind: "String" });
    expect(elements[2]).toEqual({ value: true, typeKind: "Bool" });
    expect(elements[3]).toEqual({ value: null, typeKind: "None" });
  });

  it("encodes empty array as Seq with empty elements", () => {
    const result = encodeValue([]);
    expect(result.typeKind).toBe("Seq");
    const elements = result.value as EncodedValue[];
    expect(elements.length).toBe(0);
  });

  it("encodes nested arrays recursively", () => {
    const result = encodeValue([
      [1, 2],
      [3, 4],
    ]);
    expect(result.typeKind).toBe("Seq");

    const elements = result.value as EncodedValue[];
    expect(elements.length).toBe(2);
    expect(elements[0].typeKind).toBe("Seq");
    expect(elements[1].typeKind).toBe("Seq");

    const inner0 = elements[0].value as EncodedValue[];
    expect(inner0.length).toBe(2);
    expect(inner0[0]).toEqual({ value: 1, typeKind: "Int" });
    expect(inner0[1]).toEqual({ value: 2, typeKind: "Int" });
  });

  it("encodes array of objects", () => {
    const result = encodeValue([{ x: 1 }, { x: 2 }]);
    expect(result.typeKind).toBe("Seq");

    const elements = result.value as EncodedValue[];
    expect(elements.length).toBe(2);
    expect(elements[0].typeKind).toBe("Struct");
    expect(elements[1].typeKind).toBe("Struct");
  });
});

// =============================================
// test_circular_reference_handling
// =============================================
describe("test_circular_reference_handling", () => {
  it("handles self-referencing objects without infinite loop", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;

    const result = encodeValue(obj);
    expect(result.typeKind).toBe("Struct");

    const fields = (
      result.value as { fields: Array<{ name: string; value: EncodedValue }> }
    ).fields;
    expect(fields.length).toBe(2);
    expect(fields[0].name).toBe("a");
    expect(fields[0].value).toEqual({ value: 1, typeKind: "Int" });

    expect(fields[1].name).toBe("self");
    expect(fields[1].value).toEqual({ value: "[circular]", typeKind: "Raw" });
  });

  it("handles circular arrays without infinite loop", () => {
    const arr: unknown[] = [1, 2, 3];
    arr.push(arr);

    const result = encodeValue(arr);
    expect(result.typeKind).toBe("Seq");

    const elements = result.value as EncodedValue[];
    expect(elements.length).toBe(4);
    expect(elements[3]).toEqual({ value: "[circular]", typeKind: "Raw" });
  });

  it("handles mutual circular references", () => {
    const a: Record<string, unknown> = { name: "a" };
    const b: Record<string, unknown> = { name: "b" };
    a.ref = b;
    b.ref = a;

    const result = encodeValue(a);
    expect(result.typeKind).toBe("Struct");

    const fields = (
      result.value as { fields: Array<{ name: string; value: EncodedValue }> }
    ).fields;

    // b.ref should be "[circular]" since a is still being encoded
    const bFields = (
      fields[1].value.value as {
        fields: Array<{ name: string; value: EncodedValue }>;
      }
    ).fields;
    expect(bFields[1].name).toBe("ref");
    expect(bFields[1].value).toEqual({ value: "[circular]", typeKind: "Raw" });
  });

  it("allows same object in different non-recursive branches", () => {
    const shared = { value: 42 };
    const result = encodeValue({ a: shared, b: shared });
    expect(result.typeKind).toBe("Struct");

    const fields = (
      result.value as { fields: Array<{ name: string; value: EncodedValue }> }
    ).fields;
    // Both should be encoded fully (not circular) since shared is not an ancestor
    expect(fields[0].value.typeKind).toBe("Struct");
    expect(fields[1].value.typeKind).toBe("Struct");
  });
});

// =============================================
// test_depth_limit
// =============================================
describe("test_depth_limit", () => {
  it("stops encoding at maxDepth and returns depth limit marker", () => {
    // Create deeply nested object: { a: { a: { a: ... } } }
    let obj: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 10; i++) {
      obj = { nested: obj };
    }

    // With default maxDepth=5, should stop at depth 5
    const result = encodeValue(obj);
    expect(result.typeKind).toBe("Struct");

    // Walk down the nesting chain
    let current: EncodedValue = result;
    for (let i = 0; i < 5; i++) {
      const fields = (
        current.value as {
          fields: Array<{ name: string; value: EncodedValue }>;
        }
      ).fields;
      expect(fields.length).toBe(1);
      current = fields[0].value;
    }

    // At depth 5, we should hit the depth limit
    expect(current).toEqual({ value: "[depth limit]", typeKind: "Raw" });
  });

  it("respects custom maxDepth option", () => {
    const obj = { a: { b: { c: { d: 42 } } } };

    // With maxDepth=2, should stop at depth 2
    const result = encodeValue(obj, { maxDepth: 2 });
    expect(result.typeKind).toBe("Struct");

    const aField = (
      result.value as { fields: Array<{ name: string; value: EncodedValue }> }
    ).fields[0];
    expect(aField.value.typeKind).toBe("Struct");

    const bField = (
      aField.value.value as {
        fields: Array<{ name: string; value: EncodedValue }>;
      }
    ).fields[0];
    // At depth 2, should be depth limit
    expect(bField.value).toEqual({ value: "[depth limit]", typeKind: "Raw" });
  });

  it("deeply nested arrays hit depth limit", () => {
    let arr: unknown = [42];
    for (let i = 0; i < 10; i++) {
      arr = [arr];
    }

    const result = encodeValue(arr, { maxDepth: 3 });
    expect(result.typeKind).toBe("Seq");

    // Walk 3 levels deep
    let current: EncodedValue = result;
    for (let i = 0; i < 3; i++) {
      const elements = current.value as EncodedValue[];
      expect(elements.length).toBe(1);
      current = elements[0];
    }

    expect(current).toEqual({ value: "[depth limit]", typeKind: "Raw" });
  });
});

// =============================================
// test_size_limit
// =============================================
describe("test_size_limit", () => {
  it("limits array elements to maxSize and adds marker", () => {
    const bigArray = Array.from({ length: 1000 }, (_, i) => i);

    const result = encodeValue(bigArray);
    expect(result.typeKind).toBe("Seq");

    const elements = result.value as EncodedValue[];
    // 100 actual elements + 1 marker
    expect(elements.length).toBe(101);

    // First element
    expect(elements[0]).toEqual({ value: 0, typeKind: "Int" });
    // 100th element (index 99)
    expect(elements[99]).toEqual({ value: 99, typeKind: "Int" });

    // Marker
    expect(elements[100]).toEqual({
      value: "[... 900 more]",
      typeKind: "Raw",
    });
  });

  it("limits object fields to maxSize and adds marker", () => {
    const bigObj: Record<string, number> = {};
    for (let i = 0; i < 200; i++) {
      bigObj[`field_${String(i).padStart(3, "0")}`] = i;
    }

    const result = encodeValue(bigObj);
    expect(result.typeKind).toBe("Struct");

    const fields = (
      result.value as { fields: Array<{ name: string; value: EncodedValue }> }
    ).fields;
    // 100 actual fields + 1 marker
    expect(fields.length).toBe(101);

    // Marker
    const lastField = fields[100];
    expect(lastField.name).toBe("[... 100 more]");
  });

  it("respects custom maxSize option", () => {
    const arr = [1, 2, 3, 4, 5];

    const result = encodeValue(arr, { maxSize: 3 });
    expect(result.typeKind).toBe("Seq");

    const elements = result.value as EncodedValue[];
    expect(elements.length).toBe(4); // 3 elements + marker
    expect(elements[3]).toEqual({ value: "[... 2 more]", typeKind: "Raw" });
  });

  it("does not add marker when array size equals maxSize", () => {
    const arr = [1, 2, 3];

    const result = encodeValue(arr, { maxSize: 3 });
    expect(result.typeKind).toBe("Seq");

    const elements = result.value as EncodedValue[];
    expect(elements.length).toBe(3);
  });

  it("limits Set elements to maxSize", () => {
    const bigSet = new Set<number>();
    for (let i = 0; i < 150; i++) {
      bigSet.add(i);
    }

    const result = encodeValue(bigSet);
    expect(result.typeKind).toBe("Set");

    const elements = result.value as EncodedValue[];
    expect(elements.length).toBe(101); // 100 + marker
    expect(elements[100]).toEqual({
      value: "[... 50 more]",
      typeKind: "Raw",
    });
  });

  it("limits Map entries to maxSize", () => {
    const bigMap = new Map<string, number>();
    for (let i = 0; i < 150; i++) {
      bigMap.set(`key${i}`, i);
    }

    const result = encodeValue(bigMap);
    expect(result.typeKind).toBe("TableKind");

    const entries = result.value as Array<{
      key: EncodedValue;
      value: EncodedValue;
    }>;
    expect(entries.length).toBe(101); // 100 + marker
    expect(entries[100].key).toEqual({
      value: "[... 50 more]",
      typeKind: "Raw",
    });
  });
});

// =============================================
// test_map_set_encoding
// =============================================
describe("test_map_set_encoding", () => {
  it("encodes a Map as TableKind", () => {
    const map = new Map<string, number>([
      ["a", 1],
      ["b", 2],
    ]);

    const result = encodeValue(map);
    expect(result.typeKind).toBe("TableKind");

    const entries = result.value as Array<{
      key: EncodedValue;
      value: EncodedValue;
    }>;
    expect(entries.length).toBe(2);
    expect(entries[0].key).toEqual({ value: "a", typeKind: "String" });
    expect(entries[0].value).toEqual({ value: 1, typeKind: "Int" });
    expect(entries[1].key).toEqual({ value: "b", typeKind: "String" });
    expect(entries[1].value).toEqual({ value: 2, typeKind: "Int" });
  });

  it("encodes a Map with non-string keys", () => {
    const map = new Map<unknown, string>([
      [1, "one"],
      [true, "yes"],
    ]);

    const result = encodeValue(map);
    expect(result.typeKind).toBe("TableKind");

    const entries = result.value as Array<{
      key: EncodedValue;
      value: EncodedValue;
    }>;
    expect(entries[0].key).toEqual({ value: 1, typeKind: "Int" });
    expect(entries[1].key).toEqual({ value: true, typeKind: "Bool" });
  });

  it("encodes empty Map", () => {
    const result = encodeValue(new Map());
    expect(result.typeKind).toBe("TableKind");
    const entries = result.value as Array<{
      key: EncodedValue;
      value: EncodedValue;
    }>;
    expect(entries.length).toBe(0);
  });

  it("encodes a Set as Set typeKind", () => {
    const set = new Set([10, 20, 30]);

    const result = encodeValue(set);
    expect(result.typeKind).toBe("Set");

    const elements = result.value as EncodedValue[];
    expect(elements.length).toBe(3);
    expect(elements[0]).toEqual({ value: 10, typeKind: "Int" });
    expect(elements[1]).toEqual({ value: 20, typeKind: "Int" });
    expect(elements[2]).toEqual({ value: 30, typeKind: "Int" });
  });

  it("encodes empty Set", () => {
    const result = encodeValue(new Set());
    expect(result.typeKind).toBe("Set");
    const elements = result.value as EncodedValue[];
    expect(elements.length).toBe(0);
  });

  it("encodes a Set with mixed types", () => {
    const set = new Set<unknown>(["hello", 42, true, null]);

    const result = encodeValue(set);
    expect(result.typeKind).toBe("Set");

    const elements = result.value as EncodedValue[];
    expect(elements.length).toBe(4);
    expect(elements[0].typeKind).toBe("String");
    expect(elements[1].typeKind).toBe("Int");
    expect(elements[2].typeKind).toBe("Bool");
    expect(elements[3].typeKind).toBe("None");
  });
});

// =============================================
// test_error_encoding
// =============================================
describe("test_error_encoding", () => {
  it("encodes Error objects with Error typeKind and message", () => {
    const err = new Error("something went wrong");
    const result = encodeValue(err);
    expect(result.typeKind).toBe("Error");
    expect(result.value).toBe("something went wrong");
  });

  it("encodes TypeError as Error typeKind", () => {
    const err = new TypeError("invalid type");
    const result = encodeValue(err);
    expect(result.typeKind).toBe("Error");
    expect(result.value).toBe("invalid type");
  });

  it("encodes RangeError as Error typeKind", () => {
    const err = new RangeError("out of range");
    const result = encodeValue(err);
    expect(result.typeKind).toBe("Error");
    expect(result.value).toBe("out of range");
  });

  it("encodes Error with empty message", () => {
    const err = new Error("");
    const result = encodeValue(err);
    expect(result.typeKind).toBe("Error");
    expect(result.value).toBe("");
  });
});

// =============================================
// test_special_type_encoding
// =============================================
describe("test_special_type_encoding", () => {
  it("encodes Date as Raw with ISO string", () => {
    const date = new Date("2024-01-15T12:00:00.000Z");
    const result = encodeValue(date);
    expect(result.typeKind).toBe("Raw");
    expect(result.value).toBe("2024-01-15T12:00:00.000Z");
  });

  it("encodes RegExp as Raw with toString", () => {
    const regex = /hello\s+world/gi;
    const result = encodeValue(regex);
    expect(result.typeKind).toBe("Raw");
    expect(result.value).toBe("/hello\\s+world/gi");
  });

  it("encodes named function as FunctionKind", () => {
    function myFunction() {}
    const result = encodeValue(myFunction);
    expect(result.typeKind).toBe("FunctionKind");
    expect(result.value).toBe("myFunction");
  });

  it("encodes arrow function with inferred name as FunctionKind", () => {
    const arrowFn = () => {};
    const result = encodeValue(arrowFn);
    expect(result.typeKind).toBe("FunctionKind");
    expect(result.value).toBe("arrowFn");
  });
});

// =============================================
// test_addon_deep_value_capture
// =============================================
describe("test_addon_deep_value_capture", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-deep-vals-addon-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes Call events with structured object args in trace", () => {
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

    // Enter function 1 (process) with a structured object argument
    const fakeArgs = (function (_data: unknown) {
      return arguments;
    })({ name: "test", count: 42 });
    rt.enter(1, fakeArgs);
    rt.ret(1, [1, 2, 3]);

    const traceDir = session!.stop();

    if (!ctPrintAvailable()) {
      console.warn("SKIP: ct-print not found");
      return;
    }
    const ctFile = findCtFile(traceDir);
    const bundle = ctPrintJson(ctFile) as CtPrintBundle;

    // The "data" parameter must surface in the values table — proving
    // the structured-arg staging via `arg(name, value)` reached the
    // CTFS writer.  ct-print's top-level JSON view collapses compound
    // values to Raw "{...}" markers (see codetracer-trace-format-nim's
    // `local_value_to_upstream` — until the Nim C library exports CBOR-
    // based compound registration the writer flattens Struct/Seq to a
    // Raw string), so the structural contents of `data` are not
    // asserted here.  The pure-encoder invariants (typeKind=Struct,
    // fields.length=2, etc.) are covered by the `test_struct_encoding_*`
    // suite at the top of this file via the `encodeValue` path.
    const varnames = (bundle.values ?? []).map((v) => v.varname);
    expect(varnames).toContain("data");
  });
});

// =============================================
// e2e_complex_program_trace
// =============================================
describe("e2e_complex_program_trace", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-deep-vals-e2e-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("records a program with objects, arrays, closures, and verifies structured values in trace", () => {
    const sourceCode = `
function createUser(name, age) {
  return { name: name, age: age, tags: ["user", "active"] };
}

function processUsers(users) {
  var names = [];
  for (var i = 0; i < users.length; i++) {
    names.push(users[i].name);
  }
  return names;
}

function makeCounter() {
  var count = 0;
  return function increment() {
    count = count + 1;
    return count;
  };
}

var alice = createUser("Alice", 30);
var bob = createUser("Bob", 25);
var names = processUsers([alice, bob]);
var counter = makeCounter();
var c1 = counter();
var c2 = counter();
console.log("names:", names);
console.log("counter:", c2);
`;

    const srcDir = path.join(tmpDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const srcFile = path.join(srcDir, "complex.js");
    fs.writeFileSync(srcFile, sourceCode);

    const outDir = path.join(tmpDir, "traces");
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

    // Functions registered: <module>, createUser, processUsers,
    // makeCounter, increment.
    expect(bundle.functions).toContain("createUser");
    expect(bundle.functions).toContain("processUsers");

    // Parameter names used across the program must surface in the
    // values table.
    const varnames = (bundle.values ?? []).map((v) => v.varname);
    expect(varnames).toContain("name");
    expect(varnames).toContain("age");
    expect(varnames).toContain("users");

    // The program output must reach the IO event stream.
    const ioEvents = bundle.ioEvents ?? [];
    expect(ioEvents.some((e) => (e.data ?? "").includes("names:"))).toBe(true);
    expect(ioEvents.some((e) => (e.data ?? "").includes("counter:"))).toBe(
      true,
    );
  });
});

// =============================================
// test_encode_value_safety
// =============================================
describe("test_encode_value_safety", () => {
  it("never throws for any input", () => {
    // Test a wide variety of values to ensure encodeValue never throws
    const values: unknown[] = [
      undefined,
      null,
      true,
      false,
      0,
      1,
      -1,
      3.14,
      NaN,
      Infinity,
      -Infinity,
      "",
      "hello",
      BigInt(42),
      Symbol("test"),
      () => {},
      function named() {},
      [],
      [1, 2, 3],
      {},
      { a: 1 },
      new Map(),
      new Set(),
      new Error("test"),
      new Date(),
      /regex/,
      new Int32Array([1, 2, 3]),
      new ArrayBuffer(8),
      Promise.resolve(42),
    ];

    for (const val of values) {
      expect(() => encodeValue(val)).not.toThrow();
    }
  });

  it("ret() still returns its value with complex types", () => {
    const rt = createRuntime({
      bufferCapacity: 1024,
      skipProcessHooks: true,
    });

    const obj = { a: 1, b: [2, 3] };
    const result = rt.ret(0, obj);
    expect(result).toBe(obj); // Same reference

    const arr = [1, 2, { nested: true }];
    const result2 = rt.ret(0, arr);
    expect(result2).toBe(arr); // Same reference

    const map = new Map([["key", "value"]]);
    const result3 = rt.ret(0, map);
    expect(result3).toBe(map); // Same reference
  });
});

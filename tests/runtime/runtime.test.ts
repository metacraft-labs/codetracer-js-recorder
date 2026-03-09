import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  createRuntime,
  EventBuffer,
  EVENT_STEP,
  EVENT_ENTER,
  EVENT_RET,
} from "@codetracer/runtime";

// =============================================
// test_runtime_step_buffering
// =============================================
describe("test_runtime_step_buffering", () => {
  it("buffers step events in typed arrays and flushes at threshold", () => {
    const capacity = 8; // small threshold for testing
    const rt = createRuntime({
      bufferCapacity: capacity,
      skipProcessHooks: true,
    });

    // Push 5 step events (below threshold)
    for (let i = 0; i < 5; i++) {
      rt.step(i);
    }

    // Should be buffered, not flushed
    expect(rt.buffer.length).toBe(5);
    expect(rt.buffer.flushedBatches.length).toBe(0);

    // Verify typed array contents
    for (let i = 0; i < 5; i++) {
      expect(rt.buffer.eventKinds[i]).toBe(EVENT_STEP);
      expect(rt.buffer.ids[i]).toBe(i);
    }

    // Push 3 more to reach capacity (8 total) — triggers auto-flush
    for (let i = 5; i < 8; i++) {
      rt.step(i);
    }

    // Buffer should have been flushed
    expect(rt.buffer.flushedBatches.length).toBe(1);
    expect(rt.buffer.length).toBe(0);

    // Verify the flushed batch
    const batch = rt.buffer.flushedBatches[0];
    expect(batch.length).toBe(8);
    for (let i = 0; i < 8; i++) {
      expect(batch.eventKinds[i]).toBe(EVENT_STEP);
      expect(batch.ids[i]).toBe(i);
    }
  });

  it("uses typed arrays (Uint8Array and Uint32Array), not JS objects", () => {
    const rt = createRuntime({
      bufferCapacity: 16,
      skipProcessHooks: true,
    });

    expect(rt.buffer.eventKinds).toBeInstanceOf(Uint8Array);
    expect(rt.buffer.ids).toBeInstanceOf(Uint32Array);

    rt.step(42);
    rt.flush();

    const batch = rt.buffer.flushedBatches[0];
    expect(batch.eventKinds).toBeInstanceOf(Uint8Array);
    expect(batch.ids).toBeInstanceOf(Uint32Array);
  });
});

// =============================================
// test_runtime_enter_ret_sequence
// =============================================
describe("test_runtime_enter_ret_sequence", () => {
  it("records enter and ret with correct event kind codes and function IDs", () => {
    const rt = createRuntime({
      bufferCapacity: 1024,
      skipProcessHooks: true,
    });

    // Simulate: enter fn 3, step at site 10, ret fn 3
    const fakeArgs = (function () {
      return arguments;
    })();

    rt.enter(3, fakeArgs);
    rt.step(10);
    rt.ret(3);

    expect(rt.buffer.length).toBe(3);

    // Event 0: enter
    expect(rt.buffer.eventKinds[0]).toBe(EVENT_ENTER);
    expect(rt.buffer.ids[0]).toBe(3);

    // Event 1: step
    expect(rt.buffer.eventKinds[1]).toBe(EVENT_STEP);
    expect(rt.buffer.ids[1]).toBe(10);

    // Event 2: ret
    expect(rt.buffer.eventKinds[2]).toBe(EVENT_RET);
    expect(rt.buffer.ids[2]).toBe(3);
  });

  it("records mixed enter/ret for nested function calls", () => {
    const rt = createRuntime({
      bufferCapacity: 1024,
      skipProcessHooks: true,
    });

    const fakeArgs = (function () {
      return arguments;
    })();

    // outer enter
    rt.enter(0, fakeArgs);
    rt.step(1);
    // inner enter
    rt.enter(1, fakeArgs);
    rt.step(2);
    // inner ret
    rt.ret(1);
    // outer ret
    rt.ret(0);

    expect(rt.buffer.length).toBe(6);

    const kinds = Array.from(rt.buffer.eventKinds.slice(0, 6));
    const ids = Array.from(rt.buffer.ids.slice(0, 6));

    expect(kinds).toEqual([
      EVENT_ENTER,
      EVENT_STEP,
      EVENT_ENTER,
      EVENT_STEP,
      EVENT_RET,
      EVENT_RET,
    ]);
    expect(ids).toEqual([0, 1, 1, 2, 1, 0]);
  });
});

// =============================================
// test_runtime_flush_on_exit
// =============================================
describe("test_runtime_flush_on_exit", () => {
  it("flushes remaining buffered events when flush() is called", () => {
    const rt = createRuntime({
      bufferCapacity: 1024,
      skipProcessHooks: true,
    });

    // Buffer some events (not enough to trigger auto-flush)
    rt.step(0);
    rt.step(1);
    rt.step(2);

    expect(rt.buffer.length).toBe(3);
    expect(rt.buffer.flushedBatches.length).toBe(0);

    // Simulate what the process.on('exit') handler does
    rt.flush();

    expect(rt.buffer.length).toBe(0);
    expect(rt.buffer.flushedBatches.length).toBe(1);

    const batch = rt.buffer.flushedBatches[0];
    expect(batch.length).toBe(3);
    expect(batch.ids[0]).toBe(0);
    expect(batch.ids[1]).toBe(1);
    expect(batch.ids[2]).toBe(2);
  });

  it("does not create an empty batch when flush() is called with no events", () => {
    const rt = createRuntime({
      bufferCapacity: 1024,
      skipProcessHooks: true,
    });

    rt.flush();
    expect(rt.buffer.flushedBatches.length).toBe(0);
  });
});

// =============================================
// test_runtime_manifest_loading
// =============================================
describe("test_runtime_manifest_loading", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-runtime-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads the manifest and makes site/function lookups available", () => {
    const manifest = {
      formatVersion: 1,
      paths: ["src/main.ts"],
      functions: [
        { name: "<module>", pathIndex: 0, line: 1, col: 0 },
        { name: "main", pathIndex: 0, line: 3, col: 0 },
      ],
      sites: [
        { kind: "call", pathIndex: 0, line: 1, col: 0, fnId: 0 },
        { kind: "step", pathIndex: 0, line: 4, col: 2 },
        { kind: "return", pathIndex: 0, line: 5, col: 2, fnId: 1 },
      ],
    };

    const manifestPath = path.join(tmpDir, "codetracer.manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    const rt = createRuntime({
      bufferCapacity: 1024,
      skipProcessHooks: true,
    });

    expect(rt.manifest).toBeNull();
    expect(rt.initialized).toBe(false);

    rt.init(manifestPath);

    expect(rt.initialized).toBe(true);
    expect(rt.manifest).not.toBeNull();
    expect(rt.manifest!.formatVersion).toBe(1);
    expect(rt.manifest!.paths).toEqual(["src/main.ts"]);
    expect(rt.manifest!.functions).toHaveLength(2);
    expect(rt.manifest!.functions[0].name).toBe("<module>");
    expect(rt.manifest!.functions[1].name).toBe("main");
    expect(rt.manifest!.sites).toHaveLength(3);
    expect(rt.manifest!.sites[0].kind).toBe("call");
    expect(rt.manifest!.sites[1].kind).toBe("step");
    expect(rt.manifest!.sites[2].kind).toBe("return");
  });

  it("is idempotent — calling init() twice does not reload", () => {
    const manifest1 = {
      formatVersion: 1,
      paths: ["a.ts"],
      functions: [],
      sites: [],
    };
    const manifest2 = {
      formatVersion: 2,
      paths: ["b.ts"],
      functions: [],
      sites: [],
    };

    const path1 = path.join(tmpDir, "manifest1.json");
    const path2 = path.join(tmpDir, "manifest2.json");
    fs.writeFileSync(path1, JSON.stringify(manifest1));
    fs.writeFileSync(path2, JSON.stringify(manifest2));

    const rt = createRuntime({
      bufferCapacity: 1024,
      skipProcessHooks: true,
    });

    rt.init(path1);
    rt.init(path2); // should be ignored

    expect(rt.manifest!.formatVersion).toBe(1);
    expect(rt.manifest!.paths).toEqual(["a.ts"]);
  });
});

// =============================================
// test_runtime_disabled
// =============================================
describe("test_runtime_disabled", () => {
  const origEnv = process.env.CODETRACER_JS_RECORDER_DISABLED;

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env.CODETRACER_JS_RECORDER_DISABLED;
    } else {
      process.env.CODETRACER_JS_RECORDER_DISABLED = origEnv;
    }
  });

  it("step/enter/ret are no-ops when disabled", () => {
    process.env.CODETRACER_JS_RECORDER_DISABLED = "true";

    const rt = createRuntime({
      bufferCapacity: 1024,
      skipProcessHooks: true,
    });

    expect(rt.config.disabled).toBe(true);

    const fakeArgs = (function () {
      return arguments;
    })();

    // These should all be no-ops — no events buffered
    rt.step(0);
    rt.step(1);
    rt.enter(0, fakeArgs);
    rt.ret(0);

    expect(rt.buffer.length).toBe(0);
    expect(rt.buffer.flushedBatches.length).toBe(0);
  });

  it("ret still returns its value when disabled", () => {
    process.env.CODETRACER_JS_RECORDER_DISABLED = "true";

    const rt = createRuntime({
      bufferCapacity: 1024,
      skipProcessHooks: true,
    });

    const result = rt.ret(0, 42);
    expect(result).toBe(42);
  });
});

// =============================================
// test_runtime_ret_returns_value
// =============================================
describe("test_runtime_ret_returns_value", () => {
  it("returns the exact value argument for expression correctness", () => {
    const rt = createRuntime({
      bufferCapacity: 1024,
      skipProcessHooks: true,
    });

    // Primitive values
    expect(rt.ret(0, 42)).toBe(42);
    expect(rt.ret(0, "hello")).toBe("hello");
    expect(rt.ret(0, true)).toBe(true);
    expect(rt.ret(0, null)).toBe(null);
    expect(rt.ret(0, 0)).toBe(0);
    expect(rt.ret(0, "")).toBe("");
    expect(rt.ret(0, false)).toBe(false);
  });

  it("returns undefined when no value is provided (void return)", () => {
    const rt = createRuntime({
      bufferCapacity: 1024,
      skipProcessHooks: true,
    });

    expect(rt.ret(0)).toBeUndefined();
  });

  it("returns object references (same identity)", () => {
    const rt = createRuntime({
      bufferCapacity: 1024,
      skipProcessHooks: true,
    });

    const obj = { a: 1 };
    const arr = [1, 2, 3];

    expect(rt.ret(0, obj)).toBe(obj);
    expect(rt.ret(0, arr)).toBe(arr);
  });

  it("works correctly in the pattern: return __ct.ret(fnId, expr)", () => {
    const rt = createRuntime({
      bufferCapacity: 1024,
      skipProcessHooks: true,
    });

    // Simulate what instrumented code does:
    // function add(a, b) { return __ct.ret(1, a + b); }
    function add(a: number, b: number): number {
      return rt.ret(1, a + b) as number;
    }

    expect(add(3, 4)).toBe(7);
    expect(add(0, 0)).toBe(0);
    expect(add(-1, 1)).toBe(0);
  });
});

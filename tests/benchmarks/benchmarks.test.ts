/**
 * Performance benchmarks for CodeTracer JS Recorder.
 *
 * These are not a formal benchmark framework — they simply measure
 * and report key performance metrics via console.log.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";

import {
  createRuntime,
  startRecording,
  encodeValue,
} from "@codetracer/runtime";
import type { TraceManifest } from "@codetracer/runtime";
import { instrument } from "@codetracer/instrumenter";

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const EXAMPLES_DIR = path.join(PROJECT_ROOT, "examples");
const ADDON_PATH = path.resolve(
  __dirname,
  "../../crates/recorder_native/index.node",
);
const CLI_PATH = path.join(PROJECT_ROOT, "packages/cli/dist/index.js");

// =============================================
// benchmark_instrumentation_speed
// =============================================
describe("benchmark_instrumentation_speed", () => {
  it("measures instrumentation speed on examples directory", () => {
    const files = fs
      .readdirSync(EXAMPLES_DIR)
      .filter((f) => f.endsWith(".js"))
      .map((f) => ({
        name: f,
        code: fs.readFileSync(path.join(EXAMPLES_DIR, f), "utf-8"),
      }));

    expect(files.length).toBeGreaterThan(0);

    // Warm up
    for (const file of files) {
      instrument(file.code, { filename: file.name });
    }

    // Timed run
    const iterations = 100;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      for (const file of files) {
        instrument(file.code, { filename: file.name });
      }
    }
    const elapsed = performance.now() - start;

    const totalFiles = files.length * iterations;
    const filesPerSec = (totalFiles / (elapsed / 1000)).toFixed(1);

    console.log(`\n--- Instrumentation Benchmark ---`);
    console.log(`  Files: ${files.length} example files`);
    console.log(`  Iterations: ${iterations}`);
    console.log(`  Total time: ${elapsed.toFixed(1)}ms`);
    console.log(`  Speed: ${filesPerSec} files/sec`);
    console.log(`  Per file: ${(elapsed / totalFiles).toFixed(2)}ms`);

    // Sanity check: should be able to instrument at least 100 files/sec
    expect(parseFloat(filesPerSec)).toBeGreaterThan(100);
  });
});

// =============================================
// benchmark_runtime_events_per_sec
// =============================================
describe("benchmark_runtime_events_per_sec", () => {
  it("measures step events/sec in a tight loop", () => {
    const rt = createRuntime({
      bufferCapacity: 8192,
      skipProcessHooks: true,
      onFlush: () => {}, // discard to measure pure runtime overhead
    });

    const iterations = 100_000;

    // Warm up
    for (let i = 0; i < 1000; i++) {
      rt.step(0);
    }
    rt.flush();

    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      rt.step(0);
    }
    rt.flush();
    const elapsed = performance.now() - start;

    const eventsPerSec = (iterations / (elapsed / 1000)).toFixed(0);

    console.log(`\n--- Runtime Step Events Benchmark ---`);
    console.log(`  Events: ${iterations.toLocaleString()}`);
    console.log(`  Total time: ${elapsed.toFixed(1)}ms`);
    console.log(`  Speed: ${Number(eventsPerSec).toLocaleString()} events/sec`);
    console.log(`  Per event: ${((elapsed / iterations) * 1000).toFixed(1)}us`);

    // Should be able to handle at least 1M events/sec
    expect(parseFloat(eventsPerSec)).toBeGreaterThan(1_000_000);
  });

  it("measures enter+ret events/sec with value encoding", () => {
    const rt = createRuntime({
      bufferCapacity: 8192,
      skipProcessHooks: true,
      onFlush: () => {},
    });

    const fakeArgs = (function (_x: number, _y: string) {
      return arguments;
    })(42, "hello");

    const iterations = 50_000;

    // Warm up
    for (let i = 0; i < 500; i++) {
      rt.enter(0, fakeArgs);
      rt.ret(0, 42);
    }
    rt.flush();

    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      rt.enter(0, fakeArgs);
      rt.ret(0, 42);
    }
    rt.flush();
    const elapsed = performance.now() - start;

    const pairsPerSec = (iterations / (elapsed / 1000)).toFixed(0);

    console.log(`\n--- Runtime Enter+Ret Events Benchmark ---`);
    console.log(`  Enter/Ret pairs: ${iterations.toLocaleString()}`);
    console.log(`  Total time: ${elapsed.toFixed(1)}ms`);
    console.log(`  Speed: ${Number(pairsPerSec).toLocaleString()} pairs/sec`);

    // Should handle at least 100K enter+ret pairs/sec
    expect(parseFloat(pairsPerSec)).toBeGreaterThan(100_000);
  });

  it("measures deep value encoding speed", () => {
    const complexObj = {
      name: "test",
      items: [1, 2, 3, 4, 5],
      nested: { a: { b: { c: 42 } } },
      tags: new Set(["a", "b", "c"]),
    };

    const iterations = 50_000;

    // Warm up
    for (let i = 0; i < 1000; i++) {
      encodeValue(complexObj);
    }

    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      encodeValue(complexObj);
    }
    const elapsed = performance.now() - start;

    const encodingsPerSec = (iterations / (elapsed / 1000)).toFixed(0);

    console.log(`\n--- Deep Value Encoding Benchmark ---`);
    console.log(`  Encodings: ${iterations.toLocaleString()}`);
    console.log(`  Total time: ${elapsed.toFixed(1)}ms`);
    console.log(
      `  Speed: ${Number(encodingsPerSec).toLocaleString()} encodings/sec`,
    );

    // Should handle at least 50K complex encodings/sec
    expect(parseFloat(encodingsPerSec)).toBeGreaterThan(50_000);
  });
});

// =============================================
// benchmark_trace_size
// =============================================
describe("benchmark_trace_size", () => {
  it("measures trace size for a 1000-step program", () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "ct-bench-trace-size-"),
    );

    try {
      // Create a program that generates ~1000 steps
      const sourceCode = `
function work(n) {
  var sum = 0;
  for (var i = 0; i < n; i++) {
    sum = sum + i;
  }
  return sum;
}

// Each call to work(N) produces roughly N*2 steps (loop condition + body)
// plus enter+ret. So work(200) x 5 calls ~= 1000+ steps
var r1 = work(200);
var r2 = work(200);
var r3 = work(200);
var r4 = work(200);
var r5 = work(200);
`;

      const srcDir = path.join(tmpDir, "src");
      fs.mkdirSync(srcDir, { recursive: true });
      const srcFile = path.join(srcDir, "bench-trace-size.js");
      fs.writeFileSync(srcFile, sourceCode);

      const outDir = path.join(tmpDir, "traces");

      const cliPath = CLI_PATH;
      const result = execFileSync(
        process.execPath,
        [cliPath, "record", srcFile, "--out-dir", outDir],
        {
          cwd: PROJECT_ROOT,
          encoding: "utf-8",
          timeout: 30000,
        },
      );

      const traceDirMatch = result.match(/Trace written to:\s*(.+)/);
      expect(traceDirMatch).not.toBeNull();
      const traceDir = traceDirMatch![1].trim();

      // Read trace and measure
      const traceJsonPath = path.join(traceDir, "trace.json");
      const traceContent = fs.readFileSync(traceJsonPath, "utf-8");
      const traceEvents = JSON.parse(traceContent);

      const totalEvents = traceEvents.length;
      const stepEvents = traceEvents.filter(
        (e: { type: string }) => e.type === "Step",
      ).length;
      const callEvents = traceEvents.filter(
        (e: { type: string }) => e.type === "Call",
      ).length;
      const returnEvents = traceEvents.filter(
        (e: { type: string }) => e.type === "Return",
      ).length;
      const traceSize = Buffer.byteLength(traceContent, "utf-8");

      console.log(`\n--- Trace Size Benchmark ---`);
      console.log(`  Total events: ${totalEvents}`);
      console.log(`  Step events: ${stepEvents}`);
      console.log(`  Call events: ${callEvents}`);
      console.log(`  Return events: ${returnEvents}`);
      console.log(`  trace.json size: ${(traceSize / 1024).toFixed(1)} KB`);
      console.log(`  Bytes per event: ${(traceSize / totalEvents).toFixed(1)}`);

      // Sanity checks
      expect(stepEvents).toBeGreaterThan(500); // Should have many step events
      expect(callEvents).toBeGreaterThanOrEqual(6); // 5 work() + 1 <module>
      expect(callEvents).toBe(returnEvents); // Balanced calls/returns
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

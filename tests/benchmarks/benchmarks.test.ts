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
import {
  requireCtPrint,
  ctPrintJson,
  findCtFile,
  type CtPrintBundle,
} from "../helpers/ct-print.js";

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

    // The yardstick: a plain recursive walk of the same value that builds a
    // comparable tagged tree (no depth/size budgets, no cycle tracking). It
    // runs in the same process, interleaved with encodeValue, so whatever
    // the host is doing slows both alike. An absolute rate cannot be held
    // to: the same build measured ~1M encodings/s on an idle workstation,
    // ~40K with two cores starved, and 24K on a busy CI runner.
    const referenceWalk = (v: unknown): unknown => {
      if (v === null || typeof v !== "object") {
        return { kind: typeof v, value: v };
      }
      if (v instanceof Set) {
        return { kind: "set", items: Array.from(v, referenceWalk) };
      }
      if (Array.isArray(v)) {
        return { kind: "array", items: v.map(referenceWalk) };
      }
      const fields = [];
      for (const key of Object.keys(v)) {
        fields.push({
          name: key,
          value: referenceWalk((v as Record<string, unknown>)[key]),
        });
      }
      return { kind: "object", fields };
    };

    // Blocks of 1,250 calls of each, alternated. At least 20 (50,000 calls
    // in all, as many as the benchmark made when it timed encodeValue
    // alone), and then on until neither has run a new fastest block for 10
    // blocks, or for at most 10 s.
    const minBlocks = 20;
    const settledAfter = 10;
    const capMs = 10_000;
    const perBlock = 1_250;

    // Warm up both, so neither is measured before the JIT has compiled it.
    for (let i = 0; i < 1000; i++) {
      encodeValue(complexObj);
      referenceWalk(complexObj);
    }

    // Compare each one's fastest block. Interference only ever adds time to
    // a block, so the fastest is the closest to what the code costs. Going
    // on until the fastest blocks settle is for V8's optimising compiler,
    // a background thread: on a starved host it can leave encodeValue
    // unoptimised for many blocks after the smaller walk was optimised.
    // Measured with two cores shared by 24 CPU hogs, the median of the
    // blocks' ratios ranged from 0.07 to 22.7, and the fastest blocks'
    // ratio of 20 blocks reached 21.6 once; settled, it stays within
    // 0.85-1.41, as on an idle host.
    const encodeBlocks: number[] = [];
    const walkBlocks: number[] = [];
    let lastNewFastest = 0;
    const began = performance.now();
    for (let b = 0; ; b++) {
      let start = performance.now();
      for (let i = 0; i < perBlock; i++) encodeValue(complexObj);
      const e = performance.now() - start;
      start = performance.now();
      for (let i = 0; i < perBlock; i++) referenceWalk(complexObj);
      const w = performance.now() - start;
      if (
        b === 0 ||
        e < Math.min(...encodeBlocks) ||
        w < Math.min(...walkBlocks)
      ) {
        lastNewFastest = b;
      }
      encodeBlocks.push(e);
      walkBlocks.push(w);
      if (b + 1 >= minBlocks && b - lastNewFastest >= settledAfter) break;
      if (performance.now() - began > capMs) break;
    }
    const blocks = encodeBlocks.length;
    const ratio = Math.min(...encodeBlocks) / Math.min(...walkBlocks);
    const encodeMs = encodeBlocks.reduce((a, b) => a + b, 0);
    const iterations = blocks * perBlock;
    const encodingsPerSec = iterations / (encodeMs / 1000);

    console.log(`\n--- Deep Value Encoding Benchmark ---`);
    console.log(`  Encodings: ${iterations.toLocaleString()}`);
    console.log(`  Total time: ${encodeMs.toFixed(1)}ms`);
    console.log(
      `  Speed: ${Math.round(encodingsPerSec).toLocaleString()} encodings/sec`,
    );
    console.log(
      `  Cost relative to a plain walk (fastest of ${blocks} blocks each): ${ratio.toFixed(2)}x`,
    );

    // encodeValue measured 0.85-1.41x the plain walk, idle and under load
    // alike. Three times the walk's cost means it has picked up real extra
    // work per value, whatever the host's speed.
    expect(ratio).toBeLessThan(3);
    // A hang guard, not a speed bound: the verdict is the ratio above, which
    // the test's duration does not enter. The blocks stop by themselves
    // within their 10 s cap, which a starved host can reach, past vitest's
    // 5 s default; an encodeValue slow enough to matter fails the ratio
    // whatever the host, long before 60 s.
  }, 60_000);
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

      // Measure the produced CTFS bundle.
      requireCtPrint();
      const ctFile = findCtFile(traceDir);
      const bundle = ctPrintJson(ctFile) as CtPrintBundle;
      const stepEvents = (bundle.steps ?? []).length;
      const ctSize = fs.statSync(ctFile).size;

      console.log(`\n--- Trace Size Benchmark (CTFS) ---`);
      console.log(`  Step events: ${stepEvents}`);
      console.log(`  Functions: ${(bundle.functions ?? []).length}`);
      console.log(`  Values: ${(bundle.values ?? []).length}`);
      console.log(`  .ct container size: ${(ctSize / 1024).toFixed(1)} KB`);
      if (stepEvents > 0) {
        console.log(`  Bytes per step: ${(ctSize / stepEvents).toFixed(1)}`);
      }

      // Sanity checks
      expect(stepEvents).toBeGreaterThan(500); // Should have many step events
      // Cannot assert call/return balance without a CTFS reader at this
      // layer; the structural anchor of a well-populated container with
      // many steps + functions is the strongest claim we can make
      // through ct-print's public surface.
      expect((bundle.functions ?? []).length).toBeGreaterThanOrEqual(2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

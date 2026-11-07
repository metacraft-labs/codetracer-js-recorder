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
import * as swc from "@swc/core";
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
// Measuring against a reference
// =============================================
//
// An absolute rate (events/sec, files/sec) is a statement about the host as
// much as about the code: the same build measured ~1M value encodings/s on an
// idle workstation, ~40K with two cores starved, and 24K on a busy CI runner.
// So each benchmark times its subject against a reference workload that does
// the plain version of the same job, in the same process, interleaved with
// it: whatever the host is doing slows both alike, and the verdict is what
// the subject costs relative to the reference.

/** What {@link relativeCost} measured. */
interface RelativeCost {
  /** The subject's fastest block over the reference's fastest block. */
  ratio: number;
  /** Blocks run of each. */
  blocks: number;
  /** All of the subject's blocks, in ms. */
  subjectMs: number;
}

/**
 * Time `subject` against `reference` in alternating blocks of `perBlock`
 * calls each and compare each one's fastest block. Interference only ever
 * adds time to a block, so the fastest is the closest to what the code
 * costs. The blocks go on, past at least `minBlocks` and 3 s, until neither
 * has run a new fastest block for 10 blocks, or for at most 15 s: on a
 * starved host V8's optimising compiler, a background thread, can leave the
 * subject unoptimised for many blocks after a smaller reference was
 * optimised (measured with two cores shared by 24 CPU hogs: the median of
 * the blocks' ratios for deep value encoding ranged from 0.07 to 22.7, and
 * the fastest blocks' ratio over a fixed 20 blocks reached 21.6 once; with
 * eight cores shared by 64 hogs and the rest of the suite, instrument()
 * settled at 10 to 16 times its reference within 25 passes).
 */
function relativeCost(
  subject: () => void,
  reference: () => void,
  opts: { perBlock: number; minBlocks?: number; warmup?: number },
): RelativeCost {
  const minBlocks = opts.minBlocks ?? 20;
  const settledAfter = 10;
  const minMs = 3_000;
  const capMs = 15_000;
  // Warm up both, so neither is measured before the JIT has compiled it.
  for (let i = 0; i < (opts.warmup ?? 1000); i++) {
    subject();
    reference();
  }
  const subjectBlocks: number[] = [];
  const referenceBlocks: number[] = [];
  let lastNewFastest = 0;
  const began = performance.now();
  for (let b = 0; ; b++) {
    let start = performance.now();
    for (let i = 0; i < opts.perBlock; i++) subject();
    const s = performance.now() - start;
    start = performance.now();
    for (let i = 0; i < opts.perBlock; i++) reference();
    const r = performance.now() - start;
    if (
      b === 0 ||
      s < Math.min(...subjectBlocks) ||
      r < Math.min(...referenceBlocks)
    ) {
      lastNewFastest = b;
    }
    subjectBlocks.push(s);
    referenceBlocks.push(r);
    const elapsed = performance.now() - began;
    if (
      b + 1 >= minBlocks &&
      b - lastNewFastest >= settledAfter &&
      elapsed >= minMs
    ) {
      break;
    }
    if (elapsed > capMs) break;
  }
  return {
    ratio: Math.min(...subjectBlocks) / Math.min(...referenceBlocks),
    blocks: subjectBlocks.length,
    subjectMs: subjectBlocks.reduce((a, b) => a + b, 0),
  };
}

/**
 * The time limit of a benchmark: a hang guard, not a speed bound. The
 * verdict is a ratio, which the test's duration does not enter; the blocks
 * stop by themselves within their 15 s cap, which a starved host can reach,
 * past vitest's 5 s default.
 */
const BENCH_TIMEOUT = 60_000;

/**
 * How much dearer than its reference each subject may be. Measured on the
 * shared build host under its own load: instrument() 2.3-3.4x a plain SWC
 * parse and print; and under that load and with two cores shared by 24 CPU
 * hogs alike: a step 1.3-1.7x a plain buffer push, an enter and a return
 * 1.6-3.3x a plain walk and push. Each bound is 1.5 to 2 times the dearest seen, so a subject that
 * does its work per call several times over fails, whatever the host; the
 * absolute floors these replace (100 files/s, 1M steps/s, 100K pairs/s)
 * failed only on a slowdown of some 20 times on an idle host, and failed
 * with no slowdown at all on a busy one.
 *
 * instrument() is the exception: with eight cores shared by 64 CPU hogs it
 * measured 9 to 16 times its reference in about half the runs, and with two
 * cores shared by 24 CPU hogs 15 to 46 times in every run, also over 150
 * passes, for a reason not yet found (a reference that also rebuilds the
 * tree in JavaScript did no better, and V8's helper threads are not it:
 * `--single-threaded` measured the same). Its bound still fails there, as
 * does the floor of 100 files/s it replaces, which the eight-core runs met
 * in 2 of 16.
 */
const INSTRUMENT_MAX_RATIO = 7;
const STEP_MAX_RATIO = 4;
const ENTER_RET_MAX_RATIO = 5;

/**
 * The plain version of value encoding: a recursive walk that builds a
 * comparable tagged tree, with no depth or size budgets and no cycle
 * tracking.
 */
function referenceWalk(v: unknown): unknown {
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
}

/**
 * The plain version of the runtime's event buffer (`EventBuffer.push` in
 * packages/runtime/src/buffer.ts): a kind and an id into typed arrays, an
 * attachment beside them, and a reset when full.
 */
function referenceRing(capacity: number): {
  push(kind: number, id: number, value?: object): void;
} {
  const kinds = new Uint8Array(capacity);
  const ids = new Uint32Array(capacity);
  let values: object[] = [];
  let n = 0;
  return {
    push(kind: number, id: number, value?: object): void {
      kinds[n] = kind;
      ids[n] = id;
      if (value !== undefined) values.push({ eventIndex: n, ...value });
      n += 1;
      if (n >= capacity) {
        n = 0;
        values = [];
      }
    },
  };
}

// =============================================
// benchmark_instrumentation_speed
// =============================================
describe("benchmark_instrumentation_speed", () => {
  it(
    "measures instrumentation speed on examples directory",
    () => {
      const files = fs
        .readdirSync(EXAMPLES_DIR)
        .filter((f) => f.endsWith(".js"))
        .map((f) => ({
          name: f,
          code: fs.readFileSync(path.join(EXAMPLES_DIR, f), "utf-8"),
        }));

      expect(files.length).toBeGreaterThan(0);

      // The reference: what instrumenting is built on, a plain SWC parse of
      // the same file and a print of it with a source map, as instrument()
      // does around its own pass over the tree.
      const plainRoundTrip = (file: { name: string; code: string }): void => {
        const module = swc.parseSync(file.code, {
          syntax: "ecmascript",
          target: "es2022",
          comments: false,
        });
        swc.printSync(module, { sourceMaps: true, filename: file.name });
      };

      // One call of either is one pass over every example file.
      const cost = relativeCost(
        () => {
          for (const file of files) {
            instrument(file.code, { filename: file.name });
          }
        },
        () => {
          for (const file of files) plainRoundTrip(file);
        },
        { perBlock: 1, warmup: 3 },
      );

      const totalFiles = files.length * cost.blocks;
      const filesPerSec = totalFiles / (cost.subjectMs / 1000);

      console.log(`\n--- Instrumentation Benchmark ---`);
      console.log(`  Files: ${files.length} example files`);
      console.log(`  Passes: ${cost.blocks}`);
      console.log(`  Total time: ${cost.subjectMs.toFixed(1)}ms`);
      console.log(`  Speed: ${filesPerSec.toFixed(1)} files/sec`);
      console.log(
        `  Cost relative to a plain SWC parse and print (fastest pass of ${cost.blocks} each): ${cost.ratio.toFixed(2)}x`,
      );

      expect(cost.ratio).toBeLessThan(INSTRUMENT_MAX_RATIO);
    },
    BENCH_TIMEOUT,
  );
});

// =============================================
// benchmark_runtime_events_per_sec
// =============================================
describe("benchmark_runtime_events_per_sec", () => {
  it(
    "measures step events/sec in a tight loop",
    () => {
      const rt = createRuntime({
        bufferCapacity: 8192,
        skipProcessHooks: true,
        onFlush: () => {}, // discard to measure pure runtime overhead
      });
      const ring = referenceRing(8192);

      // The reference: the plain version of what a step records, a kind
      // and an id into the event buffer.
      const cost = relativeCost(
        () => rt.step(0),
        () => ring.push(1, 0),
        { perBlock: 5_000 },
      );
      rt.flush();

      const iterations = cost.blocks * 5_000;
      const eventsPerSec = iterations / (cost.subjectMs / 1000);

      console.log(`\n--- Runtime Step Events Benchmark ---`);
      console.log(`  Events: ${iterations.toLocaleString()}`);
      console.log(`  Total time: ${cost.subjectMs.toFixed(1)}ms`);
      console.log(
        `  Speed: ${Math.round(eventsPerSec).toLocaleString()} events/sec`,
      );
      console.log(
        `  Cost relative to a plain buffer push (fastest of ${cost.blocks} blocks each): ${cost.ratio.toFixed(2)}x`,
      );

      expect(cost.ratio).toBeLessThan(STEP_MAX_RATIO);
    },
    BENCH_TIMEOUT,
  );

  it(
    "measures enter+ret events/sec with value encoding",
    () => {
      const rt = createRuntime({
        bufferCapacity: 8192,
        skipProcessHooks: true,
        onFlush: () => {},
      });
      const ring = referenceRing(8192);

      const fakeArgs = (function (_x: number, _y: string) {
        return arguments;
      })(42, "hello");

      // The reference: the plain version of an enter and a return, each
      // argument and the return value walked into a tagged value and
      // pushed with its event.
      const cost = relativeCost(
        () => {
          rt.enter(0, fakeArgs);
          rt.ret(0, 42);
        },
        () => {
          const args: unknown[] = [];
          for (let i = 0; i < fakeArgs.length; i++) {
            args.push(referenceWalk(fakeArgs[i]));
          }
          ring.push(2, 0, { args });
          ring.push(3, 0, { returnValue: referenceWalk(42) });
        },
        { perBlock: 2_500, warmup: 500 },
      );
      rt.flush();

      const iterations = cost.blocks * 2_500;
      const pairsPerSec = iterations / (cost.subjectMs / 1000);

      console.log(`\n--- Runtime Enter+Ret Events Benchmark ---`);
      console.log(`  Enter/Ret pairs: ${iterations.toLocaleString()}`);
      console.log(`  Total time: ${cost.subjectMs.toFixed(1)}ms`);
      console.log(
        `  Speed: ${Math.round(pairsPerSec).toLocaleString()} pairs/sec`,
      );
      console.log(
        `  Cost relative to a plain walk and push (fastest of ${cost.blocks} blocks each): ${cost.ratio.toFixed(2)}x`,
      );

      expect(cost.ratio).toBeLessThan(ENTER_RET_MAX_RATIO);
    },
    BENCH_TIMEOUT,
  );

  it(
    "measures deep value encoding speed",
    () => {
      const complexObj = {
        name: "test",
        items: [1, 2, 3, 4, 5],
        nested: { a: { b: { c: 42 } } },
        tags: new Set(["a", "b", "c"]),
      };

      // The reference: the plain walk of the same value. Blocks of 1,250,
      // at least 20 (50,000 calls of each).
      const cost = relativeCost(
        () => encodeValue(complexObj),
        () => referenceWalk(complexObj),
        { perBlock: 1_250 },
      );

      const iterations = cost.blocks * 1_250;
      const encodingsPerSec = iterations / (cost.subjectMs / 1000);

      console.log(`\n--- Deep Value Encoding Benchmark ---`);
      console.log(`  Encodings: ${iterations.toLocaleString()}`);
      console.log(`  Total time: ${cost.subjectMs.toFixed(1)}ms`);
      console.log(
        `  Speed: ${Math.round(encodingsPerSec).toLocaleString()} encodings/sec`,
      );
      console.log(
        `  Cost relative to a plain walk (fastest of ${cost.blocks} blocks each): ${cost.ratio.toFixed(2)}x`,
      );

      // encodeValue measured 0.85-1.41x the plain walk, idle and under
      // load alike. Three times the walk's cost means it has picked up real
      // extra work per value, whatever the host's speed.
      expect(cost.ratio).toBeLessThan(3);
    },
    BENCH_TIMEOUT,
  );
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

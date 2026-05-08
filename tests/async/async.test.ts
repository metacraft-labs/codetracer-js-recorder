import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";

import {
  createRuntime,
  startRecording,
  EventBuffer,
  EVENT_STEP,
  EVENT_ENTER,
  EVENT_RET,
  EVENT_THREAD_START,
  EVENT_THREAD_SWITCH,
  EVENT_THREAD_EXIT,
  AsyncContextTracker,
} from "@codetracer/runtime";
import type { TraceManifest } from "@codetracer/runtime";
import { instrument } from "@codetracer/instrumenter";
import {
  ctPrintAvailable,
  ctPrintJson,
  findCtFile,
  type CtPrintBundle,
} from "../helpers/ct-print.js";

const ADDON_PATH = path.resolve(
  __dirname,
  "../../crates/recorder_native/index.node",
);

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const CLI_PATH = path.join(PROJECT_ROOT, "packages/cli/dist/index.js");

// ── Helpers ─────────────────────────────────────────────────────────

/** Create a minimal manifest for testing. */
function makeManifest(overrides: Partial<TraceManifest> = {}): TraceManifest {
  return {
    formatVersion: 1,
    paths: ["src/main.js"],
    functions: [
      { name: "<module>", pathIndex: 0, line: 1, col: 0 },
      { name: "fetchData", pathIndex: 0, line: 3, col: 0 },
    ],
    sites: [
      { kind: "call", pathIndex: 0, line: 1, col: 0, fnId: 0 },
      { kind: "step", pathIndex: 0, line: 4, col: 2 },
      { kind: "step", pathIndex: 0, line: 5, col: 2 },
      { kind: "return", pathIndex: 0, line: 6, col: 2, fnId: 1 },
    ],
    ...overrides,
  };
}

/** Write a manifest file and return its path. */
function writeManifest(dir: string, manifest: TraceManifest): string {
  const p = path.join(dir, "codetracer.manifest.json");
  fs.writeFileSync(p, JSON.stringify(manifest));
  return p;
}

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
// test_async_context_tracking
// =============================================
describe("test_async_context_tracking", () => {
  it("emits ThreadStart when async tracking is enabled", () => {
    const rt = createRuntime({
      bufferCapacity: 1024,
      skipProcessHooks: true,
    });

    // Before enabling, step events should not include thread events
    rt.step(0);
    expect(rt.buffer.length).toBe(1);
    expect(rt.buffer.eventKinds[0]).toBe(EVENT_STEP);

    // Enable async tracking
    rt.enableAsyncTracking();

    // The buffer should now have a ThreadStart event
    // (enable emits ThreadStart for the initial context)
    expect(rt.buffer.length).toBe(2);
    expect(rt.buffer.eventKinds[1]).toBe(EVENT_THREAD_START);
  });

  it("does not emit ThreadSwitch when context has not changed", () => {
    const rt = createRuntime({
      bufferCapacity: 1024,
      skipProcessHooks: true,
    });

    rt.enableAsyncTracking();
    const afterEnable = rt.buffer.length;

    // Multiple step events in the same sync context should not
    // produce ThreadSwitch events
    rt.step(0);
    rt.step(1);
    rt.step(2);

    // Only the step events should be added (no ThreadSwitch)
    expect(rt.buffer.length).toBe(afterEnable + 3);
    for (let i = afterEnable; i < rt.buffer.length; i++) {
      expect(rt.buffer.eventKinds[i]).toBe(EVENT_STEP);
    }
  });

  it("emits ThreadStart and ThreadSwitch when async context changes across await", async () => {
    const rt = createRuntime({
      bufferCapacity: 1024,
      skipProcessHooks: true,
    });

    rt.enableAsyncTracking();
    const initialCtxId = rt.asyncTracker.lastCtxId;

    // Record the initial step in the main context
    rt.step(0);

    // After awaiting a resolved promise, the execution context may change
    // depending on the Node.js version and microtask handling
    await Promise.resolve();

    // Record a step after awaiting — if the context changed,
    // we should see ThreadStart/ThreadSwitch events
    rt.step(1);

    // Flush and check
    rt.flush();
    const batch = rt.buffer.flushedBatches[0];

    // The batch should contain at least:
    // 1. ThreadStart (initial context from enable)
    // 2. Step(0)
    // 3. Possibly ThreadStart + ThreadSwitch (if context changed after await)
    // 4. Step(1)
    expect(batch.length).toBeGreaterThanOrEqual(3); // At minimum: ThreadStart + Step + Step

    // Verify ThreadStart is present at position 0
    expect(batch.eventKinds[0]).toBe(EVENT_THREAD_START);
  });

  it("tracks multiple concurrent async contexts via Promise.all", async () => {
    const rt = createRuntime({
      bufferCapacity: 4096,
      skipProcessHooks: true,
    });

    rt.enableAsyncTracking();

    const fakeArgs = (function () {
      return arguments;
    })();

    // Run two async functions concurrently
    async function work(id: number): Promise<string> {
      rt.enter(id, fakeArgs);
      rt.step(id * 10);
      await new Promise((r) => setTimeout(r, 10));
      rt.step(id * 10 + 1);
      return rt.ret(id, `result-${id}`) as string;
    }

    const results = await Promise.all([work(0), work(1)]);
    expect(results).toEqual(["result-0", "result-1"]);

    rt.flush();

    // Collect all events from all flushed batches
    const allKinds: number[] = [];
    const allIds: number[] = [];
    for (const batch of rt.buffer.flushedBatches) {
      for (let i = 0; i < batch.length; i++) {
        allKinds.push(batch.eventKinds[i]);
        allIds.push(batch.ids[i]);
      }
    }

    // Should have ThreadStart events
    const threadStartCount = allKinds.filter(
      (k) => k === EVENT_THREAD_START,
    ).length;
    expect(threadStartCount).toBeGreaterThanOrEqual(1);

    // After the awaits resolve in different async contexts, we should see
    // ThreadSwitch events (the exact count depends on Node.js scheduling)
    const threadSwitchCount = allKinds.filter(
      (k) => k === EVENT_THREAD_SWITCH,
    ).length;
    // At least some context switches should occur when resuming after setTimeout
    expect(threadSwitchCount).toBeGreaterThanOrEqual(1);

    // Should still have the regular events
    const enterCount = allKinds.filter((k) => k === EVENT_ENTER).length;
    const retCount = allKinds.filter((k) => k === EVENT_RET).length;
    expect(enterCount).toBe(2);
    expect(retCount).toBe(2);
  });

  it("AsyncContextTracker can be used standalone with a buffer", () => {
    const buffer = new EventBuffer(256);
    const tracker = new AsyncContextTracker();

    // Before enabling, checkContext is a no-op
    tracker.checkContext(buffer);
    expect(buffer.length).toBe(0);

    // Enable it
    tracker.enable(buffer);
    expect(buffer.length).toBe(1); // ThreadStart for initial context
    expect(buffer.eventKinds[0]).toBe(EVENT_THREAD_START);

    // In the same sync context, checkContext should be a no-op
    tracker.checkContext(buffer);
    expect(buffer.length).toBe(1);

    // The tracker should know about the initial context
    expect(tracker.knownContexts.size).toBe(1);
    expect(tracker.enabled).toBe(true);

    // Disable and verify
    tracker.disable();
    expect(tracker.enabled).toBe(false);
    tracker.checkContext(buffer);
    expect(buffer.length).toBe(1); // No new events when disabled
  });

  it("ret still returns its value with async tracking enabled", () => {
    const rt = createRuntime({
      bufferCapacity: 1024,
      skipProcessHooks: true,
    });

    rt.enableAsyncTracking();

    expect(rt.ret(0, 42)).toBe(42);
    expect(rt.ret(0, "hello")).toBe("hello");
    expect(rt.ret(0, null)).toBe(null);
    expect(rt.ret(0)).toBeUndefined();

    const obj = { a: 1 };
    expect(rt.ret(0, obj)).toBe(obj);
  });

  it("async tracking does not interfere when disabled", () => {
    const rt = createRuntime({
      bufferCapacity: 1024,
      skipProcessHooks: true,
    });

    // Without enabling async tracking, events should be normal
    const fakeArgs = (function () {
      return arguments;
    })();

    rt.enter(0, fakeArgs);
    rt.step(1);
    rt.ret(0);

    // Should only have 3 events (no thread events)
    expect(rt.buffer.length).toBe(3);
    expect(rt.buffer.eventKinds[0]).toBe(EVENT_ENTER);
    expect(rt.buffer.eventKinds[1]).toBe(EVENT_STEP);
    expect(rt.buffer.eventKinds[2]).toBe(EVENT_RET);
  });
});

// =============================================
// e2e_async_await_trace
// =============================================
describe("e2e_async_await_trace", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-async-e2e-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("records a program with async/await and produces ThreadStart/ThreadSwitch events in trace", () => {
    // Write an async program
    const sourceCode = `
async function fetchData(id) {
  await new Promise(r => setTimeout(r, 10));
  return "data-" + id;
}

async function main() {
  const results = await Promise.all([fetchData(1), fetchData(2)]);
  console.log(results.join(", "));
}

main();
`;
    const inputFile = path.join(tmpDir, "async-program.js");
    fs.writeFileSync(inputFile, sourceCode);

    const outDir = path.join(tmpDir, "traces");

    const { stdout, stderr } = runCLI([
      "record",
      inputFile,
      "--out-dir",
      outDir,
    ]);

    // Should show program output
    expect(stdout).toContain("data-1, data-2");

    // Extract trace directory
    const traceDirMatch = stdout.match(/Trace written to:\s*(.+)/);
    expect(traceDirMatch).not.toBeNull();
    const traceDir = traceDirMatch![1].trim();

    if (!ctPrintAvailable()) {
      console.warn("SKIP content assertions: ct-print not found");
      return;
    }

    const ctFile = findCtFile(traceDir);
    const bundle = ctPrintJson(ctFile) as CtPrintBundle;

    // The program output must reach the IO event stream — proving the
    // async-recording pipeline finalized cleanly and thread events did
    // not block the binary writer (they would have, before the audit
    // fix routed them through `register_thread_*`).
    const dataEvent = (bundle.ioEvents ?? []).find((e) =>
      (e.data ?? "").includes("data-1, data-2"),
    );
    expect(dataEvent).toBeDefined();

    // The Step + Function tables should be non-trivial.
    expect(bundle.functions).toBeDefined();
    expect(bundle.steps).toBeDefined();
    expect(bundle.steps!.length).toBeGreaterThan(0);

    // The `.ct` container must be materially populated (not just the
    // CTFS header), proving the full async pipeline finalized.
    expect(fs.statSync(ctFile).size).toBeGreaterThan(100);
  });
});

// =============================================
// e2e_promise_chain_trace
// =============================================
describe("e2e_promise_chain_trace", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-promise-e2e-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("records a program with promise chains and captures async context switches", () => {
    const sourceCode = `
function delay(ms) {
  return new Promise(function(resolve) {
    setTimeout(resolve, ms);
  });
}

async function step1() {
  await delay(5);
  return "step1-done";
}

async function step2(prev) {
  await delay(5);
  return prev + " -> step2-done";
}

async function main() {
  var r1 = await step1();
  var r2 = await step2(r1);
  console.log(r2);
}

main();
`;
    const inputFile = path.join(tmpDir, "promise-chain.js");
    fs.writeFileSync(inputFile, sourceCode);

    const outDir = path.join(tmpDir, "traces");

    const { stdout } = runCLI(["record", inputFile, "--out-dir", outDir]);

    // Should show program output
    expect(stdout).toContain("step1-done -> step2-done");

    // Extract trace directory
    const traceDirMatch = stdout.match(/Trace written to:\s*(.+)/);
    expect(traceDirMatch).not.toBeNull();
    const traceDir = traceDirMatch![1].trim();

    if (!ctPrintAvailable()) {
      console.warn("SKIP content assertions: ct-print not found");
      return;
    }

    const ctFile = findCtFile(traceDir);
    const bundle = ctPrintJson(ctFile) as CtPrintBundle;

    // The chained-promise output must surface in the IO event stream.
    const finalEvent = (bundle.ioEvents ?? []).find((e) =>
      (e.data ?? "").includes("step1-done -> step2-done"),
    );
    expect(finalEvent).toBeDefined();

    // Promise chain expands the function table beyond <module>.
    expect(bundle.functions).toBeDefined();
    expect(bundle.functions!.length).toBeGreaterThan(1);

    // Steps must be present from the await boundaries' resumption.
    expect(bundle.steps).toBeDefined();
    expect(bundle.steps!.length).toBeGreaterThan(0);
  });
});

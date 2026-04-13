import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  createRuntime,
  startRecording,
  loadNativeAddon,
  EVENT_STEP,
  EVENT_ENTER,
  EVENT_RET,
} from "@codetracer/runtime";
import type { TraceManifest } from "@codetracer/runtime";
import { instrument } from "@codetracer/instrumenter";
import { parseTraceEvents } from "../helpers/parse-trace.js";

const ADDON_PATH = path.resolve(
  __dirname,
  "../../crates/recorder_native/index.node",
);

// ── Helpers ─────────────────────────────────────────────────────────

/** Create a minimal manifest for testing. */
function makeManifest(overrides: Partial<TraceManifest> = {}): TraceManifest {
  return {
    formatVersion: 1,
    paths: ["src/main.js"],
    functions: [
      { name: "<module>", pathIndex: 0, line: 1, col: 0 },
      { name: "main", pathIndex: 0, line: 3, col: 0 },
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

// =============================================
// test_addon_start_recording
// =============================================
describe("test_addon_start_recording", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-addon-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a trace directory when startRecording is called", () => {
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

    expect(session.handle).toBeGreaterThan(0);
    expect(typeof session.stop).toBe("function");

    // The trace directory should exist
    const traceDir = session.stop();
    expect(fs.existsSync(traceDir)).toBe(true);
    expect(fs.existsSync(path.join(traceDir, "trace.json"))).toBe(true);
    expect(fs.existsSync(path.join(traceDir, "trace_metadata.json"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(traceDir, "trace_paths.json"))).toBe(true);
  });

  it("writes correct trace_metadata.json", () => {
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
      program: "my-app.js",
      args: ["--verbose", "input.txt"],
      format: "json",
      skipProcessHooks: true,
    });

    const traceDir = session.stop();

    const metadata = JSON.parse(
      fs.readFileSync(path.join(traceDir, "trace_metadata.json"), "utf-8"),
    );
    expect(metadata.language).toBe("javascript");
    expect(metadata.program).toBe("my-app.js");
    expect(metadata.args).toEqual(["--verbose", "input.txt"]);
    expect(metadata.recorder).toBe("codetracer-js-recorder");
    expect(metadata.format).toBe("json");
  });

  it("writes correct trace_paths.json from manifest", () => {
    const manifest = makeManifest({
      paths: ["src/main.js", "src/utils.js", "lib/helpers.js"],
    });
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

    const traceDir = session.stop();

    const paths = JSON.parse(
      fs.readFileSync(path.join(traceDir, "trace_paths.json"), "utf-8"),
    );
    expect(paths).toEqual(["src/main.js", "src/utils.js", "lib/helpers.js"]);
  });
});

// =============================================
// test_addon_append_events_batch
// =============================================
describe("test_addon_append_events_batch", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-addon-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("records step, call, and return events from batches", () => {
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

    // Simulate runtime events: enter fn 0, step at site 1, step at site 2, ret fn 0
    const fakeArgs = (function () {
      return arguments;
    })();
    rt.enter(0, fakeArgs);
    rt.step(1);
    rt.step(2);
    rt.ret(0);

    const traceDir = session.stop();

    const traceEvents = parseTraceEvents(
      JSON.parse(fs.readFileSync(path.join(traceDir, "trace.json"), "utf-8")),
    );

    // First events are pre-registered paths and functions
    const pathEvents = traceEvents.filter(
      (e: { type: string }) => e.type === "Path",
    );
    const funcEvents = traceEvents.filter(
      (e: { type: string }) => e.type === "Function",
    );
    const stepEvents = traceEvents.filter(
      (e: { type: string }) => e.type === "Step",
    );
    const callEvents = traceEvents.filter(
      (e: { type: string }) => e.type === "Call",
    );
    const returnEvents = traceEvents.filter(
      (e: { type: string }) => e.type === "Return",
    );

    // Should have 1 path registered
    expect(pathEvents.length).toBe(1);
    expect(pathEvents[0].path).toBe("src/main.js");

    // Should have 2 functions registered
    expect(funcEvents.length).toBe(2);
    expect(funcEvents[0].name).toBe("<module>");
    expect(funcEvents[1].name).toBe("main");

    // Should have 2 step events
    expect(stepEvents.length).toBe(2);
    // Site 1 is { kind: "step", pathIndex: 0, line: 4 }
    expect(stepEvents[0].pathIndex).toBe(0);
    expect(stepEvents[0].line).toBe(4);
    // Site 2 is { kind: "step", pathIndex: 0, line: 5 }
    expect(stepEvents[1].pathIndex).toBe(0);
    expect(stepEvents[1].line).toBe(5);

    // Should have 1 call event (fnId 0)
    expect(callEvents.length).toBe(1);
    expect(callEvents[0].fnId).toBe(0);

    // Should have 1 return event
    expect(returnEvents.length).toBe(1);
  });

  it("handles multiple flush batches correctly", () => {
    const manifest = makeManifest();
    const manifestPath = writeManifest(tmpDir, manifest);

    // Use a tiny buffer capacity so it flushes often
    const rt = createRuntime({
      bufferCapacity: 4,
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

    // Push 6 step events — with capacity 4, this triggers auto-flush after 4
    for (let i = 0; i < 6; i++) {
      rt.step(1); // site 1 = step at line 4
    }

    const traceDir = session.stop();

    const traceEvents = parseTraceEvents(
      JSON.parse(fs.readFileSync(path.join(traceDir, "trace.json"), "utf-8")),
    );

    const stepEvents = traceEvents.filter(
      (e: { type: string }) => e.type === "Step",
    );
    // All 6 step events should be recorded across multiple batches
    expect(stepEvents.length).toBe(6);
  });
});

// =============================================
// test_addon_source_file_copying
// =============================================
describe("test_addon_source_file_copying", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-addon-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("copies source files to the files/ directory in the trace", () => {
    // Create actual source files that the manifest references
    const srcDir = path.join(tmpDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const mainContent = 'console.log("hello");';
    const utilContent = "export function add(a, b) { return a + b; }";
    fs.writeFileSync(path.join(srcDir, "main.js"), mainContent);
    fs.writeFileSync(path.join(srcDir, "util.js"), utilContent);

    // Use absolute paths in manifest so the addon can find them
    const mainPath = path.join(srcDir, "main.js");
    const utilPath = path.join(srcDir, "util.js");

    const manifest = makeManifest({
      paths: [mainPath, utilPath],
      functions: [
        { name: "<module>", pathIndex: 0, line: 1, col: 0 },
        { name: "add", pathIndex: 1, line: 1, col: 0 },
      ],
      sites: [{ kind: "step", pathIndex: 0, line: 1, col: 0 }],
    });
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

    const traceDir = session.stop();

    // The files/ directory should exist
    const filesDir = path.join(traceDir, "files");
    expect(fs.existsSync(filesDir)).toBe(true);

    // Both source files should be copied (absolute paths have leading / stripped)
    const stripLeadingSlash = (p: string) =>
      p.startsWith("/") ? p.slice(1) : p;
    const copiedMain = path.join(filesDir, stripLeadingSlash(mainPath));
    const copiedUtil = path.join(filesDir, stripLeadingSlash(utilPath));
    expect(fs.existsSync(copiedMain)).toBe(true);
    expect(fs.existsSync(copiedUtil)).toBe(true);

    // Content should match
    expect(fs.readFileSync(copiedMain, "utf-8")).toBe(mainContent);
    expect(fs.readFileSync(copiedUtil, "utf-8")).toBe(utilContent);
  });
});

// =============================================
// test_trace_format_compliance
// =============================================
describe("test_trace_format_compliance", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-addon-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("end-to-end: instrument, execute, and verify trace has correct events", () => {
    // Step 1: Instrument a simple JS program
    const sourceCode = `
function greet(name) {
  return "Hello, " + name;
}
greet("World");
`;
    const filename = "test-program.js";
    const { code: instrumentedCode, manifestSlice } = instrument(sourceCode, {
      filename,
    });

    // Step 2: Build a full manifest from the slice
    const manifest: TraceManifest = {
      formatVersion: 1,
      paths: manifestSlice.paths,
      functions: manifestSlice.functions,
      sites: manifestSlice.sites,
    };

    const manifestPath = writeManifest(tmpDir, manifest);

    // Step 3: Create runtime and start recording
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
      program: filename,
      args: [],
      format: "json",
      skipProcessHooks: true,
    });

    // Step 4: Execute the instrumented code with our runtime as __ct
    const wrappedCode = `
      const __ct = {
        step: function(siteId) { rt.step(siteId); },
        enter: function(fnId, args) { rt.enter(fnId, args); },
        ret: function(fnId, value) { return rt.ret(fnId, value); },
      };
      ${instrumentedCode}
    `;
    const fn = new Function("rt", wrappedCode);
    fn(rt);

    // Step 5: Stop recording and get trace directory
    const traceDir = session.stop();

    // Step 6: Verify the trace
    expect(fs.existsSync(traceDir)).toBe(true);

    const traceEvents = parseTraceEvents(
      JSON.parse(fs.readFileSync(path.join(traceDir, "trace.json"), "utf-8")),
    );

    // Should have Path events
    const pathEvents = traceEvents.filter(
      (e: { type: string }) => e.type === "Path",
    );
    expect(pathEvents.length).toBe(manifest.paths.length);
    expect(pathEvents[0].path).toBe(filename);

    // Should have Function events
    const funcEvents = traceEvents.filter(
      (e: { type: string }) => e.type === "Function",
    );
    expect(funcEvents.length).toBe(manifest.functions.length);
    // Should have at least <module> and greet
    const funcNames = funcEvents.map((e: { name: string }) => e.name);
    expect(funcNames).toContain("<module>");
    expect(funcNames).toContain("greet");

    // Should have Step events
    const stepEvents = traceEvents.filter(
      (e: { type: string }) => e.type === "Step",
    );
    expect(stepEvents.length).toBeGreaterThan(0);

    // Should have Call events (enter events)
    const callEvents = traceEvents.filter(
      (e: { type: string }) => e.type === "Call",
    );
    expect(callEvents.length).toBeGreaterThan(0);

    // Should have Return events
    const returnEvents = traceEvents.filter(
      (e: { type: string }) => e.type === "Return",
    );
    expect(returnEvents.length).toBeGreaterThan(0);

    // Verify correct ordering: the first runtime events after pre-registration
    // should be Call/Step/Return in a plausible sequence.
    // The pre-registered events are Paths then Functions.
    // After that, runtime events should start.
    const runtimeEvents = traceEvents.filter(
      (e: { type: string }) =>
        e.type === "Step" || e.type === "Call" || e.type === "Return",
    );

    // The first runtime event should be a Call (entering <module>)
    expect(runtimeEvents[0].type).toBe("Call");

    // The last runtime event should be a Return (exiting <module>)
    expect(runtimeEvents[runtimeEvents.length - 1].type).toBe("Return");

    // Verify trace_metadata.json
    const metadata = JSON.parse(
      fs.readFileSync(path.join(traceDir, "trace_metadata.json"), "utf-8"),
    );
    expect(metadata.language).toBe("javascript");
    expect(metadata.program).toBe(filename);
    expect(metadata.recorder).toBe("codetracer-js-recorder");

    // Verify trace_paths.json
    const tracePaths = JSON.parse(
      fs.readFileSync(path.join(traceDir, "trace_paths.json"), "utf-8"),
    );
    expect(tracePaths).toEqual(manifest.paths);
  });
});

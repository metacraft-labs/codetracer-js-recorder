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
      skipProcessHooks: true,
    });

    expect(session.handle).toBeGreaterThan(0);
    expect(typeof session.stop).toBe("function");

    // The trace directory should exist with the canonical CTFS .ct
    // container plus operational JSON sidecars.  The legacy `trace.json`
    // events sidecar must NOT exist (Recorder-CLI-Conventions.md §4 —
    // CTFS-only).
    const traceDir = session.stop();
    expect(fs.existsSync(traceDir)).toBe(true);
    expect(fs.existsSync(path.join(traceDir, "trace.json"))).toBe(false);
    expect(fs.existsSync(path.join(traceDir, "trace_metadata.json"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(traceDir, "trace_paths.json"))).toBe(true);
    const ctFiles = fs.readdirSync(traceDir).filter((f) => f.endsWith(".ct"));
    expect(ctFiles.length).toBeGreaterThanOrEqual(1);
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
    // §4: format is hard-pinned to "ctfs" — no `--format` selector exists.
    expect(metadata.format).toBe("ctfs");
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

    if (!ctPrintAvailable()) {
      console.warn("SKIP content assertions: ct-print not found");
      return;
    }
    const ctFile = findCtFile(traceDir);
    const bundle = ctPrintJson(ctFile) as CtPrintBundle;

    // The CTFS bundle should report the manifest path and the two
    // declared functions.
    expect(bundle.paths).toBeDefined();
    expect(bundle.paths!.some((p) => p.endsWith("src/main.js"))).toBe(true);
    expect(bundle.functions).toContain("<module>");
    expect(bundle.functions).toContain("main");

    // Should have at least 2 step events — the simulated
    // rt.step(1)/rt.step(2) plus possibly synthetic step records the
    // Nim writer emits at the start() boundary.
    expect(bundle.steps).toBeDefined();
    expect(bundle.steps!.length).toBeGreaterThanOrEqual(2);
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
      skipProcessHooks: true,
    });

    // Push 6 step events — with capacity 4, this triggers auto-flush after 4
    for (let i = 0; i < 6; i++) {
      rt.step(1); // site 1 = step at line 4
    }

    const traceDir = session.stop();

    if (!ctPrintAvailable()) {
      console.warn("SKIP content assertions: ct-print not found");
      return;
    }
    const ctFile = findCtFile(traceDir);
    const bundle = ctPrintJson(ctFile) as CtPrintBundle;

    // All 6 step events should be recorded across multiple batches —
    // possibly with additional synthetic steps the Nim writer emits at
    // the start() boundary.  We require at least 6.
    expect(bundle.steps).toBeDefined();
    expect(bundle.steps!.length).toBeGreaterThanOrEqual(6);
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

    if (!ctPrintAvailable()) {
      console.warn("SKIP content assertions: ct-print not found");
      return;
    }
    const ctFile = findCtFile(traceDir);
    const bundle = ctPrintJson(ctFile) as CtPrintBundle;

    // Paths: the manifest's lone path should be present.
    expect(bundle.paths).toBeDefined();
    expect(bundle.paths!.some((p) => p.endsWith(filename))).toBe(true);

    // Functions: <module> + greet from the instrumented program.
    expect(bundle.functions).toBeDefined();
    expect(bundle.functions).toContain("<module>");
    expect(bundle.functions).toContain("greet");

    // Steps must be emitted on every line transition.
    expect(bundle.steps).toBeDefined();
    expect(bundle.steps!.length).toBeGreaterThan(0);

    // Verify trace_metadata.json sidecar.
    const metadata = JSON.parse(
      fs.readFileSync(path.join(traceDir, "trace_metadata.json"), "utf-8"),
    );
    expect(metadata.language).toBe("javascript");
    expect(metadata.program).toBe(filename);
    expect(metadata.recorder).toBe("codetracer-js-recorder");
    expect(metadata.format).toBe("ctfs");

    // Verify trace_paths.json sidecar.
    const tracePaths = JSON.parse(
      fs.readFileSync(path.join(traceDir, "trace_paths.json"), "utf-8"),
    );
    expect(tracePaths).toEqual(manifest.paths);
  });
});

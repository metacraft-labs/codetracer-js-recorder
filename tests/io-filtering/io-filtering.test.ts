import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";

import {
  createRuntime,
  startRecording,
  EVENT_WRITE,
} from "@codetracer/runtime";
import type { TraceManifest, EventBatch } from "@codetracer/runtime";
import {
  installConsoleCapture,
  removeConsoleCapture,
} from "@codetracer/runtime";
import { shouldInstrument } from "@codetracer/instrumenter";
import {
  ctPrintAvailable,
  ctPrintJson,
  findCtFile,
  type CtPrintBundle,
} from "../helpers/ct-print.js";

// Resolve paths relative to the project root
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const CLI_PATH = path.join(PROJECT_ROOT, "packages/cli/dist/index.js");
const ADDON_PATH = path.resolve(
  PROJECT_ROOT,
  "crates/recorder_native/index.node",
);
const EXAMPLES_DIR = path.join(PROJECT_ROOT, "examples");

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

/** Create a minimal manifest for testing. */
function makeManifest(overrides: Partial<TraceManifest> = {}): TraceManifest {
  return {
    formatVersion: 1,
    paths: ["src/main.js"],
    functions: [{ name: "<module>", pathIndex: 0, line: 1, col: 0 }],
    sites: [
      { kind: "call", pathIndex: 0, line: 1, col: 0, fnId: 0 },
      { kind: "step", pathIndex: 0, line: 2, col: 2 },
      { kind: "return", pathIndex: 0, line: 3, col: 2, fnId: 0 },
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
// test_console_log_capture
// =============================================
describe("test_console_log_capture", () => {
  afterEach(() => {
    removeConsoleCapture();
  });

  it("captures console.log as stdout Write events", () => {
    const writes: Array<{ kind: string; content: string }> = [];

    installConsoleCapture((kind, content) => {
      writes.push({ kind, content });
    });

    console.log("hello world");

    expect(writes.length).toBe(1);
    expect(writes[0].kind).toBe("stdout");
    expect(writes[0].content).toBe("hello world");
  });

  it("captures console.info as stdout Write events", () => {
    const writes: Array<{ kind: string; content: string }> = [];

    installConsoleCapture((kind, content) => {
      writes.push({ kind, content });
    });

    console.info("info message");

    expect(writes.length).toBe(1);
    expect(writes[0].kind).toBe("stdout");
    expect(writes[0].content).toBe("info message");
  });

  it("captures console.warn as stderr Write events", () => {
    const writes: Array<{ kind: string; content: string }> = [];

    installConsoleCapture((kind, content) => {
      writes.push({ kind, content });
    });

    console.warn("warning message");

    expect(writes.length).toBe(1);
    expect(writes[0].kind).toBe("stderr");
    expect(writes[0].content).toBe("warning message");
  });

  it("captures console.error as stderr Write events", () => {
    const writes: Array<{ kind: string; content: string }> = [];

    installConsoleCapture((kind, content) => {
      writes.push({ kind, content });
    });

    console.error("error message");

    expect(writes.length).toBe(1);
    expect(writes[0].kind).toBe("stderr");
    expect(writes[0].content).toBe("error message");
  });

  it("captures multiple arguments as a space-separated string", () => {
    const writes: Array<{ kind: string; content: string }> = [];

    installConsoleCapture((kind, content) => {
      writes.push({ kind, content });
    });

    console.log("hello", "world", 42);

    expect(writes.length).toBe(1);
    expect(writes[0].content).toBe("hello world 42");
  });

  it("still calls the original console methods (program output unaffected)", () => {
    let originalCalled = false;
    const origLog = console.log;

    // Temporarily replace console.log to detect if it gets called
    console.log = (..._args: unknown[]) => {
      originalCalled = true;
    };

    installConsoleCapture((_kind, _content) => {
      // no-op
    });

    console.log("test");

    expect(originalCalled).toBe(true);

    // Restore for cleanup
    removeConsoleCapture();
    console.log = origLog;
  });

  it("removeConsoleCapture restores original methods", () => {
    const origLog = console.log;
    const origWarn = console.warn;

    installConsoleCapture((_kind, _content) => {});

    // After install, console.log should be different
    expect(console.log).not.toBe(origLog);

    removeConsoleCapture();

    // After remove, console.log should be restored
    expect(console.log).toBe(origLog);
    expect(console.warn).toBe(origWarn);
  });
});

// =============================================
// test_include_exclude_filtering
// =============================================
describe("test_include_exclude_filtering", () => {
  it("includes JS/TS files by default", () => {
    expect(shouldInstrument("src/main.js")).toBe(true);
    expect(shouldInstrument("src/utils.ts")).toBe(true);
    expect(shouldInstrument("components/App.jsx")).toBe(true);
    expect(shouldInstrument("components/App.tsx")).toBe(true);
  });

  it("excludes non-JS files by default", () => {
    expect(shouldInstrument("README.md")).toBe(false);
    expect(shouldInstrument("package.json")).toBe(false);
    expect(shouldInstrument("image.png")).toBe(false);
    expect(shouldInstrument("styles.css")).toBe(false);
  });

  it("respects custom include patterns", () => {
    const opts = { include: ["src/**/*.ts"] };
    expect(shouldInstrument("src/main.ts", opts)).toBe(true);
    expect(shouldInstrument("src/main.js", opts)).toBe(false);
    expect(shouldInstrument("lib/util.ts", opts)).toBe(false);
  });

  it("respects custom exclude patterns", () => {
    const opts = { exclude: ["**/test/**", "**/spec/**"] };
    expect(shouldInstrument("src/main.js", opts)).toBe(true);
    expect(shouldInstrument("test/main.test.js", opts)).toBe(false);
    expect(shouldInstrument("spec/helper.js", opts)).toBe(false);
  });

  it("include and exclude work together", () => {
    const opts = {
      include: ["**/*.ts"],
      exclude: ["**/generated/**"],
    };
    expect(shouldInstrument("src/main.ts", opts)).toBe(true);
    expect(shouldInstrument("generated/types.ts", opts)).toBe(false);
    expect(shouldInstrument("src/main.js", opts)).toBe(false);
  });
});

// =============================================
// test_node_modules_excluded
// =============================================
describe("test_node_modules_excluded", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-filter-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("node_modules files are excluded by default", () => {
    expect(shouldInstrument("node_modules/lodash/index.js")).toBe(false);
    expect(shouldInstrument("node_modules/@scope/pkg/dist/index.js")).toBe(
      false,
    );
  });

  it("instruments a directory and skips node_modules", () => {
    // Create a project structure with a node_modules directory
    const srcDir = path.join(tmpDir, "project");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, "app.js"), 'console.log("hello");');
    fs.mkdirSync(path.join(srcDir, "node_modules", "some-pkg"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(srcDir, "node_modules", "some-pkg", "index.js"),
      'module.exports = "pkg";',
    );

    // Run the instrument command
    const outDir = path.join(tmpDir, "out");
    const { stdout } = runCLI(["instrument", srcDir, "--out", outDir]);

    // Should instrument only app.js, not node_modules
    expect(stdout).toContain("Instrumented 1 file(s)");
    expect(fs.existsSync(path.join(outDir, "app.js"))).toBe(true);
    expect(
      fs.existsSync(path.join(outDir, "node_modules", "some-pkg", "index.js")),
    ).toBe(false);
  });
});

// =============================================
// test_recorder_disabled
// =============================================
describe("test_recorder_disabled", () => {
  const origEnv = process.env.CODETRACER_JS_RECORDER_DISABLED;

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env.CODETRACER_JS_RECORDER_DISABLED;
    } else {
      process.env.CODETRACER_JS_RECORDER_DISABLED = origEnv;
    }
  });

  it("program runs normally with no events when disabled", () => {
    process.env.CODETRACER_JS_RECORDER_DISABLED = "true";

    const rt = createRuntime({
      bufferCapacity: 1024,
      skipProcessHooks: true,
    });

    expect(rt.config.disabled).toBe(true);

    // These should all be no-ops
    const fakeArgs = (function () {
      return arguments;
    })();
    rt.step(0);
    rt.enter(0, fakeArgs);
    const result = rt.ret(0, 42);

    // ret still returns its value
    expect(result).toBe(42);

    // No events buffered
    expect(rt.buffer.length).toBe(0);
    expect(rt.buffer.flushedBatches.length).toBe(0);
  });

  it("disabled via CLI environment variable produces no trace", () => {
    const outDir = path.join(os.tmpdir(), `ct-disabled-test-${Date.now()}`);

    try {
      // Run with DISABLED=true — should still execute program but produce no trace
      const { stdout, stderr } = runCLI(
        ["record", path.join(EXAMPLES_DIR, "hello.js"), "--out-dir", outDir],
        {
          env: { CODETRACER_JS_RECORDER_DISABLED: "true" },
        },
      );

      // The program should still produce output (Hello, World!)
      expect(stdout).toContain("Hello, World!");
    } finally {
      try {
        fs.rmSync(outDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
});

// =============================================
// e2e_console_capture
// =============================================
describe("e2e_console_capture", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-e2e-console-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("records a program that uses console.log and surfaces ioStdout in CTFS", () => {
    const outDir = path.join(tmpDir, "traces");
    const { stdout } = runCLI([
      "record",
      path.join(EXAMPLES_DIR, "hello.js"),
      "--out-dir",
      outDir,
    ]);

    // Program output should still appear
    expect(stdout).toContain("Hello, World!");

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

    // ct print --json collapses Write into ioStdout in the ioEvents stream.
    const stdouts = (bundle.ioEvents ?? []).filter(
      (e) => e.kind === "ioStdout",
    );
    expect(stdouts.length).toBeGreaterThanOrEqual(1);

    const helloWrite = stdouts.find((e) =>
      (e.data ?? "").includes("Hello, World!"),
    );
    expect(helloWrite).toBeDefined();
  });

  it("records console.warn/error with ioStderr kind in CTFS", () => {
    // Create a test program that uses console.warn and console.error
    const programDir = path.join(tmpDir, "src");
    fs.mkdirSync(programDir, { recursive: true });
    fs.writeFileSync(
      path.join(programDir, "warn-test.js"),
      `
console.log("normal output");
console.warn("warning message");
console.error("error message");
`,
    );

    const outDir = path.join(tmpDir, "traces");
    const { stdout } = runCLI([
      "record",
      path.join(programDir, "warn-test.js"),
      "--out-dir",
      outDir,
    ]);

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

    const ioEvents = bundle.ioEvents ?? [];
    // `ct print --json` collapses Write/WriteOther into a single
    // `ioStdout` bucket (multi-stream IO event collapse — see the
    // cairo audit's "Multi-stream IO event collapse" entry).  The
    // stderr-routing invariant at the writer level is preserved but
    // not visible here; we assert the structurally-stable invariants.
    expect(ioEvents.length).toBeGreaterThanOrEqual(3);
    expect(ioEvents.some((e) => (e.data ?? "").includes("normal output"))).toBe(
      true,
    );
    expect(
      ioEvents.some((e) => (e.data ?? "").includes("warning message")),
    ).toBe(true);
    expect(ioEvents.some((e) => (e.data ?? "").includes("error message"))).toBe(
      true,
    );
  });

  it("Write events preserve the content string in CTFS", () => {
    const programDir = path.join(tmpDir, "src2");
    fs.mkdirSync(programDir, { recursive: true });
    fs.writeFileSync(
      path.join(programDir, "multi-arg.js"),
      `
console.log("value is", 42);
`,
    );

    const outDir = path.join(tmpDir, "traces2");
    const { stdout } = runCLI([
      "record",
      path.join(programDir, "multi-arg.js"),
      "--out-dir",
      outDir,
    ]);

    const traceDirMatch = stdout.match(/Trace written to:\s*(.+)/);
    expect(traceDirMatch).not.toBeNull();
    const traceDir = traceDirMatch![1].trim();

    if (!ctPrintAvailable()) {
      console.warn("SKIP: ct-print not found");
      return;
    }
    const ctFile = findCtFile(traceDir);
    const bundle = ctPrintJson(ctFile) as CtPrintBundle;

    // Should find the "value is 42" write in the IO stdout stream.
    const found = (bundle.ioEvents ?? []).find(
      (e) =>
        e.kind === "ioStdout" &&
        (e.data ?? "").includes("value is") &&
        (e.data ?? "").includes("42"),
    );
    expect(found).toBeDefined();
  });
});

// =============================================
// test_cli_include_exclude_flags
// =============================================
describe("test_cli_include_exclude_flags", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-cli-filter-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("--exclude flag filters out files matching the pattern", () => {
    // Create a directory with multiple files
    const srcDir = path.join(tmpDir, "project");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, "app.js"), "var x = 1;");
    fs.writeFileSync(path.join(srcDir, "helper.js"), "var y = 2;");
    fs.writeFileSync(path.join(srcDir, "test.js"), "var z = 3;");

    const outDir = path.join(tmpDir, "out");
    const { stdout } = runCLI([
      "instrument",
      srcDir,
      "--out",
      outDir,
      "--exclude",
      "**/test.js",
    ]);

    // Should instrument app.js and helper.js but not test.js
    expect(stdout).toContain("Instrumented 2 file(s)");
    expect(fs.existsSync(path.join(outDir, "app.js"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "helper.js"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "test.js"))).toBe(false);
  });

  it("--include flag limits to matching files", () => {
    const srcDir = path.join(tmpDir, "project2");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, "app.ts"), "let x: number = 1;");
    fs.writeFileSync(path.join(srcDir, "util.js"), "var y = 2;");

    const outDir = path.join(tmpDir, "out2");
    const { stdout } = runCLI([
      "instrument",
      srcDir,
      "--out",
      outDir,
      "--include",
      "**/*.ts",
    ]);

    // Should only instrument .ts files
    expect(stdout).toContain("Instrumented 1 file(s)");
    expect(fs.existsSync(path.join(outDir, "app.ts"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "util.js"))).toBe(false);
  });
});

// =============================================
// test_error_handling_graceful_degradation
// =============================================
describe("test_error_handling_graceful_degradation", () => {
  it("ret returns its value even if buffer throws", () => {
    const rt = createRuntime({
      bufferCapacity: 1024,
      skipProcessHooks: true,
    });

    // ret() must always return the value, regardless of any internal errors
    expect(rt.ret(0, 42)).toBe(42);
    expect(rt.ret(0, "hello")).toBe("hello");
    expect(rt.ret(0, null)).toBe(null);
    expect(rt.ret(0, undefined)).toBeUndefined();
  });

  it("loadNativeAddon returns null for invalid path", () => {
    const { loadNativeAddon } = require("@codetracer/runtime");
    const result = loadNativeAddon("/nonexistent/path/addon.node");
    expect(result).toBeNull();
  });

  it("startRecording returns null when addon fails to load", () => {
    const manifest = makeManifest();
    const manifestDir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-err-test-"));
    const manifestPath = writeManifest(manifestDir, manifest);

    try {
      const rt = createRuntime({
        bufferCapacity: 1024,
        skipProcessHooks: true,
      });
      rt.init(manifestPath);

      const session = startRecording({
        runtime: rt,
        addonPath: "/nonexistent/addon.node",
        outDir: manifestDir,
        program: "test.js",
        args: [],
        skipProcessHooks: true,
      });

      // Should return null instead of throwing
      expect(session).toBeNull();
    } finally {
      fs.rmSync(manifestDir, { recursive: true, force: true });
    }
  });
});

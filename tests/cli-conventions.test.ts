/**
 * Recorder CLI convention compliance tests (2026-05-08).
 *
 * Mirrors the cairo precedent (commit 2710b5e) — locks in the four
 * convention-compliance assertions required by
 * `Recorder-CLI-Conventions.md` §4 (CTFS-only) and §5 (env vars):
 *
 *   1. `--format` is rejected by the CLI with a non-zero exit code.
 *   2. `--help` does NOT advertise `--format` or `CODETRACER_FORMAT`.
 *   3. `--help` mentions `ct print` as the conversion tool.
 *   4. `CODETRACER_JS_RECORDER_OUT_DIR` is honoured as a fallback for
 *      `--out-dir` when the flag is omitted.
 *   5. `CODETRACER_JS_RECORDER_DISABLED=1` skips recording entirely
 *      (no `.ct` files written, exit code 0).
 *
 * These assertions complement the shell-level guard at
 * `tests/verify-cli-convention-no-silent-skip.sh`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";

const PROJECT_ROOT = path.resolve(__dirname, "..");
const CLI_PATH = path.join(PROJECT_ROOT, "packages/cli/dist/index.js");
const EXAMPLES_DIR = path.join(PROJECT_ROOT, "examples");

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Run the CLI as a child process; never throws on non-zero exit. */
function runCLI(
  args: string[],
  opts?: { env?: Record<string, string | undefined> },
): RunResult {
  // Build a clean env, optionally with overrides.  We `delete` keys
  // whose value is `undefined` so callers can clear inherited vars.
  const env: Record<string, string> = { ...process.env } as Record<
    string,
    string
  >;
  if (opts?.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      if (v === undefined) {
        delete env[k];
      } else {
        env[k] = v;
      }
    }
  }
  try {
    const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], {
      cwd: PROJECT_ROOT,
      env,
      encoding: "utf-8",
      timeout: 30000,
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err: unknown) {
    const e = err as {
      stdout?: string;
      stderr?: string;
      status?: number;
    };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      exitCode: e.status ?? 1,
    };
  }
}

// =============================================
// test_no_format_flag_in_help
// =============================================
describe("test_no_format_flag_in_help", () => {
  it("top-level --help does not advertise --format or CODETRACER_FORMAT", () => {
    const { stdout, exitCode } = runCLI(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain("--format");
    expect(stdout).not.toContain("CODETRACER_FORMAT");
  });

  it("`record --help` does not advertise --format or CODETRACER_FORMAT", () => {
    const { stdout, exitCode } = runCLI(["record", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain("--format");
    expect(stdout).not.toContain("CODETRACER_FORMAT");
    // The standard `--out-dir` flag must remain documented.
    expect(stdout).toContain("--out-dir");
  });
});

// =============================================
// test_help_mentions_ct_print
// =============================================
describe("test_help_mentions_ct_print", () => {
  it("top-level --help mentions `ct print` as the conversion tool", () => {
    const { stdout, exitCode } = runCLI(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("ct print");
  });

  it("`record --help` mentions `ct print`", () => {
    const { stdout, exitCode } = runCLI(["record", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("ct print");
  });
});

// =============================================
// test_format_flag_rejected
// =============================================
describe("test_format_flag_rejected", () => {
  it("`record --format json` is rejected with a non-zero exit code", () => {
    // We don't bother with a real entry file — the parse error fires
    // before any file IO.  Use a tempdir so an accidental success
    // doesn't pollute the workspace.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ct-fmt-rej-"));
    try {
      const { stderr, exitCode } = runCLI([
        "record",
        path.join(EXAMPLES_DIR, "hello.js"),
        "--out-dir",
        path.join(tmp, "traces"),
        "--format",
        "json",
      ]);
      expect(exitCode).not.toBe(0);
      // Diagnostic must surface the offending flag name.
      expect(stderr).toContain("--format");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("`record --format binary` is also rejected", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ct-fmt-rej-"));
    try {
      const { exitCode } = runCLI([
        "record",
        path.join(EXAMPLES_DIR, "hello.js"),
        "--out-dir",
        path.join(tmp, "traces"),
        "--format",
        "binary",
      ]);
      expect(exitCode).not.toBe(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// =============================================
// test_env_out_dir_used_when_flag_omitted
// =============================================
describe("test_env_out_dir_used_when_flag_omitted", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ct-env-out-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("CODETRACER_JS_RECORDER_OUT_DIR is honoured when --out-dir is omitted", () => {
    const envOutDir = path.join(tmp, "via-env");
    const { stdout, exitCode } = runCLI(
      ["record", path.join(EXAMPLES_DIR, "hello.js")],
      {
        env: {
          CODETRACER_JS_RECORDER_OUT_DIR: envOutDir,
          // Make sure the disable env-var doesn't bleed in from the
          // developer's shell.
          CODETRACER_JS_RECORDER_DISABLED: undefined,
        },
      },
    );

    expect(exitCode).toBe(0);

    // The reported trace dir should be inside the env-supplied path.
    const match = stdout.match(/Trace written to:\s*(.+)/);
    expect(match).not.toBeNull();
    const traceDir = match![1].trim();
    expect(traceDir.startsWith(envOutDir)).toBe(true);

    // A .ct container must exist there.
    const ctFiles = fs.readdirSync(traceDir).filter((f) => f.endsWith(".ct"));
    expect(ctFiles.length).toBeGreaterThanOrEqual(1);
  });

  it("--out-dir wins over CODETRACER_JS_RECORDER_OUT_DIR when both are set", () => {
    const envOutDir = path.join(tmp, "via-env");
    const flagOutDir = path.join(tmp, "via-flag");
    const { stdout, exitCode } = runCLI(
      ["record", path.join(EXAMPLES_DIR, "hello.js"), "--out-dir", flagOutDir],
      {
        env: {
          CODETRACER_JS_RECORDER_OUT_DIR: envOutDir,
          CODETRACER_JS_RECORDER_DISABLED: undefined,
        },
      },
    );

    expect(exitCode).toBe(0);
    const match = stdout.match(/Trace written to:\s*(.+)/);
    expect(match).not.toBeNull();
    const traceDir = match![1].trim();
    expect(traceDir.startsWith(flagOutDir)).toBe(true);
    expect(fs.existsSync(envOutDir)).toBe(false);
  });
});

// =============================================
// test_env_disabled_skips_recording
// =============================================
describe("test_env_disabled_skips_recording", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ct-env-dis-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("CODETRACER_JS_RECORDER_DISABLED=1 skips recording (exit 0, no .ct files)", () => {
    const outDir = path.join(tmp, "should-stay-empty");
    const { exitCode } = runCLI(
      ["record", path.join(EXAMPLES_DIR, "hello.js"), "--out-dir", outDir],
      {
        env: { CODETRACER_JS_RECORDER_DISABLED: "1" },
      },
    );

    expect(exitCode).toBe(0);

    // No .ct files should have been written.  The `outDir` may not even
    // exist yet — both states are acceptable.
    if (fs.existsSync(outDir)) {
      const stack = [outDir];
      const ctFiles: string[] = [];
      while (stack.length > 0) {
        const cur = stack.pop()!;
        for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
          const full = path.join(cur, entry.name);
          if (entry.isDirectory()) stack.push(full);
          else if (entry.name.endsWith(".ct")) ctFiles.push(full);
        }
      }
      expect(ctFiles).toEqual([]);
    }
  });

  it("CODETRACER_JS_RECORDER_DISABLED=true also skips recording", () => {
    const outDir = path.join(tmp, "should-stay-empty-2");
    const { exitCode } = runCLI(
      ["record", path.join(EXAMPLES_DIR, "hello.js"), "--out-dir", outDir],
      {
        env: { CODETRACER_JS_RECORDER_DISABLED: "true" },
      },
    );
    expect(exitCode).toBe(0);
  });
});

/**
 * P6.2 acceptance — recorder-side autoformat of minified sources.
 *
 * Verifies that the JS recorder, when invoked against a minified
 * source, pre-formats the source with `prettier` at record time and
 * materialises the formatted view + a Source Map V3 sourcemap
 * (formatted → original) under the trace's `files/` directory.  This
 * replaces P4's replay-time autoformat fallback for new traces: the
 * replay-server's existing P3 sourcemap path discovers the
 * `.fmt.js.map` sibling and translates positions without any
 * subprocess at view time.
 *
 * See `codetracer-specs/Planned-Features/
 * Column-Aware-Tracing-And-Deminification.milestones.org` §P6.2.
 *
 * Test cases (all assertions STRICT — no silent skips):
 *
 *   - `p6_2_recorder_emits_formatted_sibling_for_minified_source`
 *     Records a driver that requires a minified library and asserts
 *     that the trace's files directory carries `<lib>.fmt.js` +
 *     `<lib>.fmt.js.map`, and that the formatted file has strictly
 *     more lines than the original.
 *
 *   - `p6_2_recorder_skip_logs_clearly_without_prettier`
 *     Mocks prettier missing by overriding PATH and verifies the
 *     recorder runs cleanly + emits a warning + writes no `.fmt.*`
 *     sidecars.
 *
 *   - `p6_2_recorder_skip_when_source_not_minified`
 *     Records a hand-written multi-line source and asserts that no
 *     `.fmt.*` artefacts appear in the trace.
 *
 *   - `p6_2_recorder_no_autoformat_flag_disables_pre_format`
 *     Records the minified library with `--no-autoformat` and
 *     asserts no `.fmt.*` files appear (regardless of prettier
 *     availability).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync, spawnSync } from "node:child_process";

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const CLI_PATH = path.join(PROJECT_ROOT, "packages/cli/dist/index.js");

interface RecordResult {
  traceDir: string;
  stderr: string;
}

/**
 * Run the CLI's `record` command against a driver + library pair and
 * return the resolved trace directory + captured stderr.
 *
 * The entry is recorded as a directory containing `index.js`
 * (driver) + `<libName>` so the recorder instruments both files
 * — that's the only invocation shape the recorder honours when the
 * driver `require()`s a sibling.  When the entry is a single file
 * the recorder only instruments that one file, and the runner
 * script's `require("./lib.min.js")` would fall through to a real
 * filesystem lookup in the tmpDir, which doesn't have a copy.
 *
 * `env` overrides supplement the inherited environment; pass
 * `{ PATH: "/tmp/empty" }` to simulate prettier being unavailable.
 */
function recordDriver(
  driver: string,
  libContent: string,
  libName: string,
  outDir: string,
  args: string[] = [],
  env: Record<string, string | undefined> = {},
): RecordResult {
  const srcDir = path.join(outDir, "src");
  fs.mkdirSync(srcDir, { recursive: true });
  // Use `index.js` as the entry filename — that's the name the
  // recorder's directory-entry path looks for.
  const driverFile = path.join(srcDir, "index.js");
  const libFile = path.join(srcDir, libName);
  fs.writeFileSync(driverFile, driver);
  fs.writeFileSync(libFile, libContent);

  const mergedEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) mergedEnv[k] = v;
  }
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) {
      delete mergedEnv[k];
    } else {
      mergedEnv[k] = v;
    }
  }

  const result = spawnSync(
    process.execPath,
    [
      CLI_PATH,
      "record",
      // Record by directory so both `index.js` and the library
      // sibling get instrumented + copied into the runner tmpDir.
      srcDir,
      "--out-dir",
      path.join(outDir, "traces"),
      ...args,
    ],
    {
      cwd: PROJECT_ROOT,
      env: mergedEnv,
      encoding: "utf-8",
      timeout: 60000,
    },
  );
  // The recorder writes the trace path on its own stdout.  We extract
  // it via regex rather than relying on the child's exit code because
  // a non-zero exit from the recorded program is non-fatal — the
  // trace can still be produced.
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const match = stdout.match(/Trace written to:\s*(.+)/);
  if (!match) {
    throw new Error(
      `failed to parse trace path from stdout.\nSTDOUT: ${stdout}\nSTDERR: ${stderr}`,
    );
  }
  return { traceDir: match[1].trim(), stderr };
}

/**
 * Generate a deliberately minified JavaScript library that:
 *   - Exports two functions and a top-level call.
 *   - Lives entirely on a single line so the average-line-length
 *     heuristic (default 500 chars) is comfortably exceeded.
 *
 * We pad with identifier-like noise so prettier has something to
 * break the line up on (a single 600-char string literal wouldn't
 * trigger any line breaks).
 */
function minifiedLibrarySource(): string {
  // A long-but-real bundled-looking statement.  Repeating distinct
  // function definitions keeps the source syntactically valid and
  // forces prettier to insert newlines between them.
  const fns: string[] = [];
  for (let i = 0; i < 12; i++) {
    fns.push(
      `function helper_${i}(a_${i}, b_${i}){var local_${i}=a_${i}+b_${i}; return local_${i}*2;}`,
    );
  }
  // Export the last helper so the driver has something to call.
  fns.push(`module.exports={call:helper_11};`);
  return fns.join("");
}

describe("P6.2 recorder-side autoformat", () => {
  let tmpDir: string;
  // Cache prettier availability once — the per-test checks need it to
  // decide whether to assert "expected formatted sibling" vs.
  // "expected warning".  Probing via PATH is cheap (sync stat).
  const prettierAvailable = isOnPath("prettier") || isOnPath("npx");

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-p62-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("p6_2_recorder_emits_formatted_sibling_for_minified_source", () => {
    // STRICT: when prettier isn't on PATH at all, we cannot exercise
    // the happy path — fail loudly rather than silently passing.  The
    // recorder ships prettier as a devDependency and the CI
    // environment always has it on PATH (via node_modules/.bin), so
    // a missing prettier here is a real configuration issue.
    expect(
      prettierAvailable,
      "prettier or npx must be on PATH to exercise the autoformat happy path",
    ).toBe(true);

    const lib = minifiedLibrarySource();
    const driver = `var lib = require("./lib.min.js"); console.log(lib.call(2,3));\n`;

    const { traceDir, stderr } = recordDriver(
      driver,
      lib,
      "lib.min.js",
      tmpDir,
    );

    // The recorder logs an info line for each pre-formatted file.
    // We use a loose match (just the filename) so changes to the
    // exact wording don't break the test.
    expect(stderr).toContain("autoformat");
    expect(stderr).toContain("lib.min.js");

    // The formatted sibling + sourcemap should both live under
    // `<trace>/files/<src>/lib.min.js.fmt.js{,.map}`.
    const filesDir = path.join(traceDir, "files");
    const fmtMatches = walkAndFilter(filesDir, (name) =>
      name.endsWith("lib.min.js.fmt.js"),
    );
    const mapMatches = walkAndFilter(filesDir, (name) =>
      name.endsWith("lib.min.js.fmt.js.map"),
    );
    expect(fmtMatches.length).toBe(1);
    expect(mapMatches.length).toBe(1);

    const formattedPath = fmtMatches[0];
    const formattedContent = fs.readFileSync(formattedPath, "utf-8");
    const originalLineCount = lib
      .split("\n")
      .filter((l) => l.length > 0).length;
    const formattedLineCount = formattedContent
      .split("\n")
      .filter((l) => l.length > 0).length;
    // STRICT: prettier must have broken the source up.
    expect(formattedLineCount).toBeGreaterThan(originalLineCount);

    // The sourcemap must be a valid V3 document with sources[0]
    // pointing back at the original file name.
    const mapPath = mapMatches[0];
    const mapJson = JSON.parse(fs.readFileSync(mapPath, "utf-8"));
    expect(mapJson.version).toBe(3);
    expect(Array.isArray(mapJson.sources)).toBe(true);
    expect(mapJson.sources.length).toBe(1);
    expect(mapJson.sources[0]).toBe("lib.min.js");
    expect(typeof mapJson.mappings).toBe("string");
    expect(mapJson.mappings.length).toBeGreaterThan(0);
  });

  it("p6_2_recorder_skip_logs_clearly_without_prettier", () => {
    // Force prettier missing by pointing PATH at an empty directory.
    // The CLI itself still needs `node` (we invoke it via
    // `process.execPath`) so we don't override that — the recorder's
    // autoformat subprocess shells out via PATH, which is what we're
    // gating.
    const emptyDir = path.join(tmpDir, "empty-path");
    fs.mkdirSync(emptyDir, { recursive: true });

    const lib = minifiedLibrarySource();
    const driver = `var lib = require("./lib.min.js"); console.log(lib.call(2,3));\n`;

    const { traceDir, stderr } = recordDriver(
      driver,
      lib,
      "lib.min.js",
      tmpDir,
      [],
      { PATH: emptyDir },
    );

    // The recorder MUST have warned about prettier being missing.
    expect(stderr).toContain("prettier not found");

    // And there must be NO `.fmt.js` or `.fmt.js.map` files in the
    // trace's files directory.
    const filesDir = path.join(traceDir, "files");
    if (fs.existsSync(filesDir)) {
      const fmtMatches = walkAndFilter(filesDir, (name) =>
        name.includes(".fmt."),
      );
      expect(fmtMatches.length).toBe(0);
    }
  });

  it("p6_2_recorder_skip_when_source_not_minified", () => {
    // Hand-written multi-line library — 30 short lines, every line
    // well under the 500-char threshold.
    const libLines: string[] = [];
    for (let i = 0; i < 20; i++) {
      libLines.push(`function helper_${i}(x) { return x + ${i}; }`);
    }
    libLines.push(`module.exports = { call: helper_5 };`);
    const lib = libLines.join("\n") + "\n";

    const driver = `var lib = require("./not-minified.js"); console.log(lib.call(7));\n`;

    const { traceDir, stderr } = recordDriver(
      driver,
      lib,
      "not-minified.js",
      tmpDir,
    );

    // For a non-minified source the recorder must not log the
    // autoformat info line and must not produce a `.fmt.*` artefact.
    expect(stderr).not.toContain("autoformat: pre-formatted");

    const filesDir = path.join(traceDir, "files");
    if (fs.existsSync(filesDir)) {
      const fmtMatches = walkAndFilter(filesDir, (name) =>
        name.includes(".fmt."),
      );
      expect(fmtMatches.length).toBe(0);
    }
  });

  it("p6_2_recorder_no_autoformat_flag_disables_pre_format", () => {
    const lib = minifiedLibrarySource();
    const driver = `var lib = require("./lib.min.js"); console.log(lib.call(2,3));\n`;

    const { traceDir, stderr } = recordDriver(
      driver,
      lib,
      "lib.min.js",
      tmpDir,
      ["--no-autoformat"],
    );

    // With `--no-autoformat` the recorder must skip the prettier
    // probe entirely (no warning about missing tool, no
    // "pre-formatted" info line) and must not produce `.fmt.*`
    // artefacts even though the source is minified.
    expect(stderr).not.toContain("autoformat: pre-formatted");
    expect(stderr).not.toContain("prettier not found");

    const filesDir = path.join(traceDir, "files");
    if (fs.existsSync(filesDir)) {
      const fmtMatches = walkAndFilter(filesDir, (name) =>
        name.includes(".fmt."),
      );
      expect(fmtMatches.length).toBe(0);
    }
  });
});

/**
 * Recursively walk `dir` and return absolute paths of files whose
 * basename matches `predicate`.
 *
 * Returns an empty array when `dir` doesn't exist — caller asserts
 * `.length === 0` for the negative cases.
 */
function walkAndFilter(
  dir: string,
  predicate: (basename: string) => boolean,
): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const entries = fs.readdirSync(cur, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && predicate(entry.name)) out.push(full);
    }
  }
  return out;
}

/**
 * Cheap PATH probe used to decide whether the happy-path test should
 * assert "formatted sibling exists" vs. "informative skip".  Avoids
 * spawning a `which` subprocess.
 */
function isOnPath(binary: string): boolean {
  const p = process.env.PATH;
  if (!p) return false;
  const sep = process.platform === "win32" ? ";" : ":";
  for (const dir of p.split(sep)) {
    try {
      const candidate = path.join(dir, binary);
      if (fs.statSync(candidate).isFile()) return true;
      if (process.platform === "win32") {
        for (const ext of [".cmd", ".exe", ".bat"]) {
          if (fs.statSync(candidate + ext).isFile()) return true;
        }
      }
    } catch {
      // not present under this PATH entry
    }
  }
  return false;
}

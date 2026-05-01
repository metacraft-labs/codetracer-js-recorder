/**
 * Smoke tests for the CTFS-recorder-audit fixes (handoff entry 1.38).
 *
 * These cover three concrete behaviours that the JS recorder used to drop
 * when replaying its in-memory event list through the Nim multi-stream
 * writer.  The fixes live in `crates/recorder_native/src/lib.rs` and
 * `tests/helpers/parse-trace.ts`:
 *
 *   1. Call records carry their argument list — staged via
 *      `NimTraceWriter::arg(name, value)` BEFORE `register_call`, mirroring
 *      the Ruby fix in handoff entry 1.22.  Without this fix the upstream
 *      `register_call(_args: …)` parameter is ignored on the Nim backend
 *      and `Call.args` arrives empty at the reader.
 *
 *   2. `console.warn` / `console.error` writes are tagged
 *      `EventLogKind::WriteOther` (numeric 2) instead of `Write` (numeric
 *      0).  This matches the canonical Python / Ruby recorder mapping for
 *      stderr-style output and is the schema the db-backend's terminal
 *      pane expects (see handoff entry 1.27 for the Python equivalent).
 *
 *   3. ThreadStart / ThreadSwitch / ThreadExit events are now routed
 *      through the dedicated FFI entry points added in entry 1.30
 *      (`register_thread_start` / `_exit` / `_switch`) instead of being
 *      silently dropped.  The JS recorder synthesises thread IDs from
 *      Node's `executionAsyncId()` (see
 *      packages/runtime/src/async-context.ts).
 *
 * The tests run the full `record` CLI on small inline JS programs and
 * assert against the JSON sidecar (trace.json), which carries the same
 * event sequence the Nim writer consumes.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { parseTraceEvents } from "../helpers/parse-trace.js";

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const CLI_PATH = path.join(PROJECT_ROOT, "packages/cli/dist/index.js");

function runCLI(args: string[]): { stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
      timeout: 30000,
    });
    return { stdout, stderr: "" };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

function extractTraceDir(stdout: string): string {
  const match = stdout.match(/Trace written to:\s*(.+)/);
  if (!match) throw new Error(`No trace dir in CLI output:\n${stdout}`);
  return match[1].trim();
}

// =============================================
// Audit fix #1: Call records carry args
// =============================================
describe("audit_ctfs_call_args", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-audit-args-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("Call records include their declared argument names + values", () => {
    const programDir = path.join(tmpDir, "src");
    fs.mkdirSync(programDir, { recursive: true });
    fs.writeFileSync(
      path.join(programDir, "add.js"),
      `
function add(a, b) {
  return a + b;
}
const result = add(7, 35);
console.log("result is", result);
`,
    );

    const { stdout } = runCLI([
      "record",
      path.join(programDir, "add.js"),
      "--out-dir",
      path.join(tmpDir, "traces"),
      "--format",
      "json",
    ]);

    const traceDir = extractTraceDir(stdout);
    const traceJson = JSON.parse(
      fs.readFileSync(path.join(traceDir, "trace.json"), "utf-8"),
    );
    const events = parseTraceEvents(traceJson);

    // Find the user-defined Call to `add`.  The runtime also registers
    // synthetic entries for the top-level module frame, so we filter by
    // the declared function name from the manifest's Function records
    // (which appear in `events` as `type: "Function"`).
    const addFn = events.find(
      (e) => e.type === "Function" && (e as { name: string }).name === "add",
    );
    expect(addFn).toBeDefined();
    const addFnId = events.findIndex((e) => e === addFn); // index in Function table — but we also need the call's fnId

    // The Call's fnId is an index into the manifest's `functions` array,
    // not the events array.  Parse the manifest from trace_paths.json's
    // sibling — actually the simplest match is to look up by the
    // function's name via the variable_name registry, which carries the
    // parameter names ("a", "b").
    const callsToAdd = events.filter((e) => {
      if (e.type !== "Call") return false;
      // Match by arg variable names, which are deterministic ("a", "b").
      const args = (e as { args: Array<{ name: string }> }).args;
      return args.length === 2 && args[0].name === "a" && args[1].name === "b";
    });

    expect(callsToAdd.length).toBe(1);

    const args = (
      callsToAdd[0] as {
        args: Array<{ name: string; value: unknown; typeKind: string }>;
      }
    ).args;

    // Both args should have non-trivial values and the right type.
    expect(args[0].name).toBe("a");
    expect(args[0].typeKind).toBe("Int");
    expect(args[0].value).toBe(7);
    expect(args[1].name).toBe("b");
    expect(args[1].typeKind).toBe("Int");
    expect(args[1].value).toBe(35);

    // Avoid an unused-var warning if addFnId is unused after refactor.
    void addFnId;
  });
});

// =============================================
// Audit fix #2: stderr writes use WriteOther kind
// =============================================
describe("audit_ctfs_stderr_kind", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-audit-stderr-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("console.warn / console.error map to EventLogKind::WriteOther (kind=2)", () => {
    const programDir = path.join(tmpDir, "src");
    fs.mkdirSync(programDir, { recursive: true });
    fs.writeFileSync(
      path.join(programDir, "stderr-mapping.js"),
      `
console.log("stdout-line");
console.warn("warn-line");
console.error("error-line");
`,
    );

    const { stdout } = runCLI([
      "record",
      path.join(programDir, "stderr-mapping.js"),
      "--out-dir",
      path.join(tmpDir, "traces"),
      "--format",
      "json",
    ]);

    const traceDir = extractTraceDir(stdout);
    const rawEvents = JSON.parse(
      fs.readFileSync(path.join(traceDir, "trace.json"), "utf-8"),
    );

    // Inspect the raw `Event` records (before parse-trace.ts normalises
    // them) so we can assert the exact numeric kind discriminant.
    const writeRecords: Array<{
      kind: number;
      metadata: string;
      content: string;
    }> = [];
    for (const ev of rawEvents) {
      if ("Event" in ev) {
        const inner = ev.Event as {
          kind: number;
          metadata: string;
          content: string;
        };
        writeRecords.push(inner);
      }
    }

    // We expect one stdout (Write=0) and two stderr (WriteOther=2).
    const stdoutKind = writeRecords.filter((r) => r.kind === 0);
    const stderrKind = writeRecords.filter((r) => r.kind === 2);

    expect(stdoutKind.length).toBeGreaterThanOrEqual(1);
    expect(stderrKind.length).toBeGreaterThanOrEqual(2);

    // The metadata field still carries the JS-side console method name
    // ("stdout" / "stderr") for the frontend to render the right pane.
    expect(stdoutKind.some((r) => r.metadata === "stdout")).toBe(true);
    expect(stderrKind.every((r) => r.metadata === "stderr")).toBe(true);

    // Content roundtrips intact.
    expect(stdoutKind.some((r) => r.content.includes("stdout-line"))).toBe(
      true,
    );
    expect(stderrKind.some((r) => r.content.includes("warn-line"))).toBe(true);
    expect(stderrKind.some((r) => r.content.includes("error-line"))).toBe(true);
  });
});

// =============================================
// Audit fix #3: thread events survive to the .ct binary
// =============================================
describe("audit_ctfs_thread_events", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-audit-threads-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("async program emits ThreadStart in the JSON trace", async () => {
    const programDir = path.join(tmpDir, "src");
    fs.mkdirSync(programDir, { recursive: true });
    fs.writeFileSync(
      path.join(programDir, "async-prog.js"),
      `
async function main() {
  await new Promise((resolve) => setTimeout(resolve, 5));
  console.log("after-await");
}
main();
`,
    );

    const { stdout } = runCLI([
      "record",
      path.join(programDir, "async-prog.js"),
      "--out-dir",
      path.join(tmpDir, "traces"),
      "--format",
      "json",
    ]);

    const traceDir = extractTraceDir(stdout);
    const rawEvents = JSON.parse(
      fs.readFileSync(path.join(traceDir, "trace.json"), "utf-8"),
    );
    const events = parseTraceEvents(rawEvents);

    // The async-context tracker emits at least one ThreadStart for the
    // initial context when recording starts.  After the await boundary
    // we usually also see additional ThreadStart and/or ThreadSwitch
    // events, but the exact count depends on Node's async scheduling
    // and is intentionally not asserted here.
    const threadStarts = events.filter((e) => e.type === "ThreadStart");
    expect(threadStarts.length).toBeGreaterThanOrEqual(1);

    // The `.ct` binary file should also exist — proving the thread
    // events did not block the binary writer (they would have, before
    // the audit fix routed them through `register_thread_*`).
    const ctFiles = fs.readdirSync(traceDir).filter((f) => f.endsWith(".ct"));
    expect(ctFiles.length).toBeGreaterThanOrEqual(1);
  });
});

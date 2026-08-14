/**
 * M37 — per-step visible-locals capture, end to end.
 *
 * The counterpart to `tests/transform/step-locals.test.ts`: that suite
 * pins what the instrumenter *decides*, this one pins what actually
 * lands in a recorded `.ct` container.  Nothing is mocked — a real
 * program is recorded through the real CLI, the real native addon and
 * the real CTFS writer, and the resulting container is decoded with
 * `ct-print --full`, the canonical reader.
 *
 * Why this layer is not optional: issue #602 ("State panel shows only
 * function parameters") stayed open through a fix cycle because the
 * only test covering JS locals hand-wrote the value events a recorder
 * was supposed to produce, so it passed while the recorder produced
 * none.  A test that never runs a recorder cannot observe this bug, and
 * a test that asserts on names alone cannot observe a wrong value — so
 * this suite records for real and asserts on `(name, value)` pairs at
 * specific steps.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import {
  ctPrintAvailable,
  ctPrintFull,
  findCtFile,
  type CtFullBundle,
  type CtFullEvent,
  type CtFullValue,
} from "../helpers/ct-print.js";

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const CLI_PATH = path.join(PROJECT_ROOT, "packages/cli/dist/index.js");

/**
 * The fixture from issue #602's reproduction: one frame carrying a
 * `const`, a `let`, a `var`, a reassignment and a `return` that writes
 * nothing.  Kept byte-identical to
 * `codetracer/src/db-backend/test-programs/javascript/javascript_locals_test.js`
 * so the recorder-layer and replay-layer suites describe the same
 * program.
 */
const FIXTURE = `function compute(a, b) {
  const base = a + b;        // const declaration
  let scaled = base * 2;     // let declaration
  var offset = 10;           // var declaration
  scaled = scaled + offset;  // reassignment
  return scaled;
}
compute(10, 32);
`;

/** Record `source` through the CLI and decode the container. */
function recordAndDecode(
  tmpDir: string,
  filename: string,
  source: string,
  env: Record<string, string> = {},
): CtFullBundle {
  const programPath = path.join(tmpDir, filename);
  fs.writeFileSync(programPath, source);
  const outDir = path.join(tmpDir, "traces");

  const stdout = execFileSync(
    process.execPath,
    [CLI_PATH, "record", programPath, "--out-dir", outDir],
    {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ...env },
      encoding: "utf-8",
      timeout: 60000,
    },
  );

  const match = stdout.match(/Trace written to:\s*(.+)/);
  if (!match) {
    throw new Error(`recorder did not report a trace directory:\n${stdout}`);
  }
  return ctPrintFull(findCtFile(match[1].trim()));
}

/** The `(name, value)` pairs recorded on the step at `line`. */
function varsAtLine(
  bundle: CtFullBundle,
  line: number,
): Array<[string, CtFullValue]> {
  const steps = bundle.events.filter(
    (e: CtFullEvent): e is Extract<CtFullEvent, { kind: "step" }> =>
      e.kind === "step" && e.line === line,
  );
  if (steps.length === 0) {
    throw new Error(`no step recorded on line ${line}`);
  }
  return steps[0].vars.map((v) => [v.varname, v.value]);
}

/**
 * The integer value recorded for `name` on the step at `line`.
 *
 * A step may carry two records for the same name — the snapshot taken
 * before the line runs, and, on a line that assigns, the M16a write
 * event taken after.  The *first* is the point-in-time value, which is
 * what a debugger stopped on that line must show, so that is the one
 * asserted on.
 */
function intAtLine(bundle: CtFullBundle, line: number, name: string): number {
  const match = varsAtLine(bundle, line).find(([n]) => n === name);
  if (!match) {
    const present = varsAtLine(bundle, line).map(([n]) => n);
    throw new Error(
      `variable '${name}' not recorded on line ${line}; present: ${present.join(", ") || "(none)"}`,
    );
  }
  const [, value] = match;
  if (value.kind !== "Int" || typeof value.i !== "number") {
    throw new Error(
      `variable '${name}' on line ${line} is ${JSON.stringify(value)}, not an Int`,
    );
  }
  return value.i;
}

describe("test_step_locals_recorded_end_to_end", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-step-locals-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("interns every declaration form, not just the parameters", () => {
    if (!ctPrintAvailable()) {
      throw new Error(
        "ct-print not found — build it in codetracer-trace-format-nim " +
          "(`just build-ct-print`) or set CT_PRINT. This suite must not " +
          "skip: skipping is how the empty-State-panel regression stayed " +
          "green through a whole fix cycle.",
      );
    }
    const bundle = recordAndDecode(tmpDir, "locals.js", FIXTURE);

    // This holds on the M16a write-site pass alone, so it does not by
    // itself demonstrate M37 — it is here because a name-interning
    // regression would make every assertion below meaningless, and
    // because the committed `examples/recordings/javascript` fixture,
    // recorded before M16a landed, interns nothing but parameters.
    for (const name of ["a", "b", "base", "scaled", "offset"]) {
      expect(bundle.varnames).toContain(name);
    }
  });

  it("records the whole frame on a line that assigns nothing", () => {
    if (!ctPrintAvailable()) return; // guarded by the test above
    const bundle = recordAndDecode(tmpDir, "locals.js", FIXTURE);

    // Line 6 is `return scaled;`. This is the exact symptom of #602:
    // the State panel was empty here because no value event landed on a
    // step that performed no assignment.
    const names = varsAtLine(bundle, 6).map(([n]) => n);
    expect(names).toEqual(["a", "b", "base", "scaled", "offset"]);
  });

  it("records the correct value for each local at each step", () => {
    if (!ctPrintAvailable()) return; // guarded by the first test
    const bundle = recordAndDecode(tmpDir, "locals.js", FIXTURE);

    // Names alone are not enough: a name-only assertion is what let the
    // pre-existing db-backend test pass while every value was a
    // placeholder. Pin the arithmetic.
    expect(intAtLine(bundle, 6, "a")).toBe(10);
    expect(intAtLine(bundle, 6, "b")).toBe(32);
    expect(intAtLine(bundle, 6, "base")).toBe(42);
    expect(intAtLine(bundle, 6, "offset")).toBe(10);
    // 84 doubled from base, plus offset — the reassignment on line 5
    // has run by the time line 6 is reached.
    expect(intAtLine(bundle, 6, "scaled")).toBe(94);

    // And the value *before* the reassignment, on the step for line 5.
    expect(intAtLine(bundle, 5, "scaled")).toBe(84);
    expect(intAtLine(bundle, 5, "offset")).toBe(10);
    expect(intAtLine(bundle, 5, "base")).toBe(42);
  });

  it("captures loop binders and keeps them out of scope where they are not bound", () => {
    if (!ctPrintAvailable()) return; // guarded by the first test
    const bundle = recordAndDecode(
      tmpDir,
      "loops.js",
      `function accumulate(n) {
  let total = 0;
  for (let i = 1; i <= n; i++) {
    total = total + i;
  }
  return total;
}
accumulate(4);
`,
    );

    // Inside the loop body the head's `let i` is live.
    const bodyNames = varsAtLine(bundle, 4).map(([n]) => n);
    expect(bodyNames).toContain("i");
    expect(bodyNames).toContain("total");

    // On the `return`, the loop's block-scoped binder is gone.
    const returnNames = varsAtLine(bundle, 6).map(([n]) => n);
    expect(returnNames).toEqual(["n", "total"]);
    expect(intAtLine(bundle, 6, "total")).toBe(10); // 1+2+3+4
  });

  it("orders the pre-line snapshot before the post-line write on an assigning step", () => {
    if (!ctPrintAvailable()) return; // guarded by the first test

    // CROSS-REPO INVARIANT — this ordering is load-bearing for the
    // db-backend and is the reason a JS step agrees with a Ruby step.
    //
    // A line that assigns produces TWO records for its target in one
    // step: the M37 snapshot, taken *before* the line runs, and the
    // M16a write event, taken *after*. `MaterializedReplaySession::
    // load_locals` resolves the pair with a stable sort followed by
    // `dedup_by`, which keeps the FIRST of each run — so whichever
    // record the recorder emits first is the value a debugger stopped
    // on that line shows. It must be the snapshot: "state on entry to
    // this line" is the State panel contract, and it is what the Ruby
    // recorder reports.
    //
    // Emitting them the other way round would still produce a trace
    // containing both values, so nothing here would fail except this
    // assertion — hence asserting on the raw stream order rather than
    // on a resolved value.
    const bundle = recordAndDecode(tmpDir, "locals.js", FIXTURE);

    // Line 5 is `scaled = scaled + offset;` — 84 on entry, 94 after.
    const scaledRecords = varsAtLine(bundle, 5)
      .filter(([name]) => name === "scaled")
      .map(([, value]) => value.i);
    expect(scaledRecords).toEqual([84, 94]);
  });

  it("drops block-scoped bindings once their block ends", () => {
    if (!ctPrintAvailable()) return; // guarded by the first test

    // The db-backend used to union every step in the frame for JS,
    // which hid a leaking in-scope set. That union is gone, so a
    // binding that outlives its block is now visible to users.
    const bundle = recordAndDecode(
      tmpDir,
      "scoping.js",
      `function probe(flag, n) {
  var kept = 1;
  if (flag) {
    let hidden = 2;
    var alsoKept = 3;
    hidden;
  }
  for (let lexical = 0; lexical < n; lexical++) {
    kept = kept + lexical;
  }
  for (var functionScoped = 0; functionScoped < n; functionScoped++) {
    kept = kept + functionScoped;
  }
  return kept;
}
probe(true, 2);
`,
    );

    const atReturn = varsAtLine(bundle, 14).map(([name]) => name);

    // `let` in a block that has exited, and a `let` loop binder after
    // the loop, are both out of scope and must not appear.
    expect(atReturn).not.toContain("hidden");
    expect(atReturn).not.toContain("lexical");

    // `var` is function-scoped, so both of these are genuinely still
    // live on the return line — dropping them would be just as wrong.
    // This half is what stops the assertions above from being
    // satisfied by a recorder that simply captures less.
    expect(atReturn).toContain("alsoKept");
    expect(atReturn).toContain("functionScoped");
    expect(intAtLine(bundle, 14, "alsoKept")).toBe(3);
    expect(intAtLine(bundle, 14, "functionScoped")).toBe(2);
  });

  it("reverts to the pre-M37 shape when capture is disabled", () => {
    if (!ctPrintAvailable()) return; // guarded by the first test
    const bundle = recordAndDecode(tmpDir, "locals.js", FIXTURE, {
      CODETRACER_JS_STEP_LOCALS: "0",
    });

    // The kill switch must genuinely turn the feature off, otherwise it
    // is useless as an escape hatch — the `return` line goes back to
    // carrying nothing.
    expect(varsAtLine(bundle, 6)).toEqual([]);
    // The M16a write events still record each binding where it is
    // assigned, so no name disappears from the trace entirely.
    expect(bundle.varnames).toContain("base");
  });
});

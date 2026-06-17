/**
 * P2 acceptance — column-aware step emission via the canonical CTFS wire.
 *
 * Verifies that:
 *
 *  - With `column_aware: true` (the default), the JS recorder's traces
 *    carry the `FLAG_HAS_COLUMN_AWARE_STEPS` meta.dat flag (bit 4) and
 *    emit DeltaColumn events on the canonical wire.
 *  - The column field is surfaced on step events in `ct-print --full`
 *    output, sourced from the writer-side global_position_index byte-
 *    offset decoding.
 *  - The `--no-column-aware` opt-out (and explicit `columnAware: false`
 *    addon option) produces a line-only trace byte-for-byte identical
 *    in shape to the pre-P2 output (meta.dat flag bit 4 clear, no
 *    DeltaColumn events).
 *
 * See `codetracer-specs/Planned-Features/
 * Column-Aware-Tracing-And-Deminification.milestones.org` §P2 and
 * `codetracer-trace-format-spec/trace-events.md` §"Column Encoding".
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
} from "../helpers/ct-print.js";

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const CLI_PATH = path.join(PROJECT_ROOT, "packages/cli/dist/index.js");

function recordSource(
  src: string,
  outDir: string,
  args: string[] = [],
): string {
  const srcDir = path.join(outDir, "src");
  fs.mkdirSync(srcDir, { recursive: true });
  const srcFile = path.join(srcDir, "column-aware-fixture.js");
  fs.writeFileSync(srcFile, src);

  const result = execFileSync(
    process.execPath,
    [
      CLI_PATH,
      "record",
      srcFile,
      "--out-dir",
      path.join(outDir, "traces"),
      ...args,
    ],
    {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
      timeout: 30000,
    },
  );
  const match = result.match(/Trace written to:\s*(.+)/);
  if (!match) throw new Error(`failed to parse trace path: ${result}`);
  return match[1].trim();
}

describe("P2 column-aware step emission", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-p2-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("default-on: trace carries column-aware flag + column field on steps", () => {
    if (!ctPrintAvailable()) return;
    const src = `const a = 1;\nconst b = 2;\nconst c = a + b;\nconsole.log(c);\n`;
    const traceDir = recordSource(src, tmpDir);
    const ctFile = findCtFile(traceDir);

    const full = ctPrintFull(ctFile) as {
      metadata?: { flags?: { has_column_aware_steps?: boolean } };
      events: Array<{ kind: string; column?: number }>;
    };
    expect(full.metadata?.flags?.has_column_aware_steps).toBe(true);

    // At least one step event surfaces a column field (any positive
    // integer — the recorder's column extraction is SWC byte offsets
    // plus the canonical +1 conversion to 1-based columns).
    const stepWithColumn = full.events.find(
      (e) => e.kind === "step" && typeof e.column === "number",
    );
    expect(stepWithColumn).toBeDefined();
    expect(stepWithColumn!.column).toBeGreaterThanOrEqual(1);
  });

  it("--no-column-aware: legacy line-only trace, no column flag", () => {
    if (!ctPrintAvailable()) return;
    const src = `const a = 1;\nconst b = 2;\nconst c = a + b;\nconsole.log(c);\n`;
    const traceDir = recordSource(src, tmpDir, ["--no-column-aware"]);
    const ctFile = findCtFile(traceDir);

    const full = ctPrintFull(ctFile) as {
      metadata?: { flags?: { has_column_aware_steps?: boolean } };
    };
    expect(full.metadata?.flags?.has_column_aware_steps).toBe(false);
  });

  /**
   * Regression: when three or more statements live on the same source
   * line (separated by `;`), every emitted step must record its OWN
   * column.  Pre-fix the third (and subsequent) same-line statements
   * collapsed onto an earlier statement's column because the writer's
   * column cursor was modelled as "sticky across same-line
   * `register_step` calls" — but the Nim multi-stream writer actually
   * resets `lastGlobalLineIndex` to "column 1 of this line" on EVERY
   * `register_step`, regardless of line transition (see
   * `codetracer-trace-format-nim/src/codetracer_trace_writer/multi_stream_writer.nim:467,494`).
   * The Rust DeltaColumn delta therefore must always be computed
   * against column 1, not against the previous column.
   */
  it("multiple statements on one line each record distinct columns", () => {
    if (!ctPrintAvailable()) return;
    // Three `let` declarations separated by `;` on a single line.
    // SWC byte offsets within the line are 0, 12, 24 (0-based); the
    // recorder converts these to 1-based columns 1, 13, 25 on the wire.
    const src = `let a = 1; let b = 2; let c = 3;\nconsole.log(a, b, c);\n`;
    const traceDir = recordSource(src, tmpDir);
    const ctFile = findCtFile(traceDir);

    const full = ctPrintFull(ctFile) as {
      metadata?: { flags?: { has_column_aware_steps?: boolean } };
      events: Array<{ kind: string; line?: number; column?: number }>;
    };
    expect(full.metadata?.flags?.has_column_aware_steps).toBe(true);

    // Collect every step event that lives on the first source line.
    // The recorder lowers each TraceEvent::Step into a
    // (`register_step`, `write_delta_column`) pair on the writer-side
    // wire (`register_step` parks the cursor at column 1; the
    // `DeltaColumn` nudges it to the manifest-recorded column).  The
    // first member of every pair therefore re-surfaces as a column-1
    // event in `ct-print --full`'s output, so the meaningful per-
    // statement landing columns are the *distinct, non-1* values plus
    // the (single) column-1 entry for `let a = 1;` itself.
    const line1Cols = full.events
      .filter(
        (e) =>
          e.kind === "step" && e.line === 1 && typeof e.column === "number",
      )
      .map((e) => e.column!);
    const distinctLine1Cols = Array.from(new Set(line1Cols)).sort(
      (a, b) => a - b,
    );

    // Three statements ⇒ three distinct user-visible landing columns.
    // The source is `let a = 1; let b = 2; let c = 3;` so the three
    // statements start at byte offsets 0, 11, 22 (0-based), which the
    // recorder converts to 1-based columns 1, 12, 23 on the wire.
    //
    // Pre-fix the third statement collapsed onto the second
    // statement's column because the Rust delta-column path modelled
    // the writer's column cursor as sticky across same-line
    // `register_step` calls; the Nim writer actually resets the
    // cursor to column 1 on every `register_step`, so the recorder
    // emitted `DeltaColumn(11)` twice in a row, landing both the
    // second and third statements on column 12.
    expect(distinctLine1Cols).toEqual([1, 12, 23]);
  });
});

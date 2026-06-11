/**
 * Unit tests for `packages/instrumenter/src/autoformat.ts` —
 * recorder-side autoformat helpers.
 *
 * The integration-level happy path lives in
 * `tests/integration/recorder_autoformat.test.ts`; this file covers
 * the pure functions (heuristic + sourcemap generation + outcome
 * dispatch) without going through the recorder pipeline.
 *
 * See `codetracer-specs/Planned-Features/
 * Column-Aware-Tracing-And-Deminification.milestones.org` §P6.2.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import {
  looksMinified,
  generateInverseSourceMap,
  resolveBundledPrettier,
  runPrettier,
  tryAutoformat,
  autoformatEnabledByEnv,
  DEFAULT_MINIFIED_THRESHOLD,
} from "@codetracer/instrumenter";

describe("looksMinified", () => {
  it("detects long-line bundles above threshold", () => {
    // Single line ~600 chars; comfortably above the 500 default.
    const stmt = "function add(a,b){return a+b;}";
    const src = stmt.repeat(25);
    expect(looksMinified(src, DEFAULT_MINIFIED_THRESHOLD)).toBe(true);
  });

  it("returns false for hand-written multi-line code", () => {
    const src = Array(30).fill("var x = 1;").join("\n");
    expect(looksMinified(src, DEFAULT_MINIFIED_THRESHOLD)).toBe(false);
  });

  it("returns false on empty input", () => {
    expect(looksMinified("", DEFAULT_MINIFIED_THRESHOLD)).toBe(false);
    expect(looksMinified("\n\n   \n", DEFAULT_MINIFIED_THRESHOLD)).toBe(false);
  });

  it("respects a custom threshold", () => {
    // 60-char line: above 50, below 100.
    const src = "x".repeat(60);
    expect(looksMinified(src, 50)).toBe(true);
    expect(looksMinified(src, 100)).toBe(false);
  });
});

describe("generateInverseSourceMap", () => {
  it("produces a valid V3 document with a non-empty mappings string", () => {
    const original = "function alpha(){return 1;}function beta(){return 2;}";
    const formatted = [
      "function alpha() {",
      "  return 1;",
      "}",
      "function beta() {",
      "  return 2;",
      "}",
      "",
    ].join("\n");
    const map = generateInverseSourceMap(original, formatted, "lib.min.js");
    expect(map.version).toBe(3);
    expect(map.sources).toEqual(["lib.min.js"]);
    expect(map.sourcesContent?.[0]).toBe(original);
    // The mappings must encode at least one segment so the V3 parser
    // doesn't treat the whole file as unmapped.
    expect(map.mappings.length).toBeGreaterThan(0);
  });

  it("emits one segment per anchorable formatted line", () => {
    const original = "var alpha=1;var beta=2;var gamma=3;";
    const formatted = [
      "var alpha = 1;",
      "var beta = 2;",
      "var gamma = 3;",
    ].join("\n");
    const map = generateInverseSourceMap(original, formatted, "lib.js");
    // 3 formatted lines, each with a unique identifier anchor: 3
    // segments separated by `;`.  We assert presence-of-segments
    // rather than exact text because VLQ encoding is order-sensitive
    // and a refactor could legitimately shuffle deltas.
    const lineSegments = map.mappings.split(";");
    const nonEmpty = lineSegments.filter((s) => s.length > 0).length;
    expect(nonEmpty).toBeGreaterThanOrEqual(3);
  });

  it("parses back through the `sourcemap` consumer crate format", () => {
    // The sourcemap-translate crate (replay-server's P3 path) uses
    // the `sourcemap` Rust crate to parse these documents.  In
    // Node-land we can't load the Rust parser, but @jridgewell's
    // TraceMap implements the same V3 spec so we exercise the
    // round-trip here.
    const original = "function compute(x){return x*2;}var k=compute(7);";
    const formatted = [
      "function compute(x) {",
      "  return x * 2;",
      "}",
      "var k = compute(7);",
      "",
    ].join("\n");
    const map = generateInverseSourceMap(original, formatted, "lib.min.js");
    const {
      TraceMap,
      originalPositionFor,
    } = require("@jridgewell/trace-mapping");
    const tm = new TraceMap(JSON.stringify(map));
    // The first formatted line ("function compute(x) {") must anchor
    // back at the original source — `originalPositionFor` returns
    // the most-recent prior segment's source position.
    const pos = originalPositionFor(tm, { line: 1, column: 0 });
    expect(pos.source).toBe("lib.min.js");
    expect(typeof pos.line).toBe("number");
    expect(pos.line).toBe(1);
  });
});

describe("tryAutoformat", () => {
  it("returns 'skipped' when enabled is false", () => {
    const src = "x".repeat(600);
    const outcome = tryAutoformat(src, "input.js", { enabled: false });
    expect(outcome.kind).toBe("skipped");
  });

  it("returns 'not-minified' for short-line input", () => {
    const src = "var x = 1;\nvar y = 2;\n";
    const outcome = tryAutoformat(src, "input.js", { enabled: true });
    expect(outcome.kind).toBe("not-minified");
  });
});

describe("resolveBundledPrettier", () => {
  it("bundled_prettier_resolves_via_require", () => {
    // STRICT: the recorder declares `prettier` as a runtime
    // dependency of `@codetracer/instrumenter` so it ships inside the
    // recorder's `node_modules` tree.  This test proves the bundled
    // path is reachable from the instrumenter module itself — without
    // relying on the user's PATH.
    //
    // A `null` return here means either:
    //   1. The dependency was downgraded back to a devDependency
    //      (regression — the user opt-in path is gone).
    //   2. `npm install` was skipped (CI configuration regression).
    //
    // Both are real bugs we want to surface loudly, so the assertion
    // is STRICT (no silent skip).
    const resolved = resolveBundledPrettier();
    expect(resolved).not.toBeNull();
    expect(typeof resolved).toBe("string");
    // The resolved path must point at an existing file — a stale
    // pointer would mean the bin entry drifted away from the package
    // layout, which would break `runPrettier`'s `node <bin>` spawn.
    expect(fs.existsSync(resolved!)).toBe(true);
    // Sanity check: the resolved bin entry should live under a
    // directory called `prettier` (defensive — guards against
    // accidental resolution of an unrelated tool that happens to
    // declare `bin: "./prettier.js"`).
    expect(resolved!).toMatch(/[\\/]prettier[\\/]/);
  });

  it("bundled_prettier_actually_runs", () => {
    // End-to-end smoke: feed `runPrettier` a small minified-looking
    // input and assert that the bundled tier produced reformatted
    // output.  This proves we wired the `node <bin>` spawn correctly,
    // not just the path resolution.
    const input =
      "function a(b,c){const d=b+c;return d;}function e(f){return f*2;}";
    const outcome = runPrettier(input, "input.js");
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      // Prettier always inserts at least one newline between top-level
      // statements, so the formatted output must be multi-line.
      expect(outcome.stdout.split("\n").length).toBeGreaterThan(1);
      // And both function names from the input must survive the
      // pretty-print pass (prettier doesn't rename identifiers).
      expect(outcome.stdout).toContain("function a(b, c)");
      expect(outcome.stdout).toContain("function e(f)");
    }
  });
});

describe("autoformatEnabledByEnv", () => {
  it("returns true when CT_AUTOFORMAT is unset", () => {
    const orig = process.env.CT_AUTOFORMAT;
    delete process.env.CT_AUTOFORMAT;
    try {
      expect(autoformatEnabledByEnv()).toBe(true);
    } finally {
      if (orig !== undefined) process.env.CT_AUTOFORMAT = orig;
    }
  });

  it("recognises off-values case-insensitively", () => {
    const orig = process.env.CT_AUTOFORMAT;
    try {
      for (const v of ["0", "off", "false", "no", "OFF", "False"]) {
        process.env.CT_AUTOFORMAT = v;
        expect(autoformatEnabledByEnv()).toBe(false);
      }
      for (const v of ["1", "on", "true", "yes"]) {
        process.env.CT_AUTOFORMAT = v;
        expect(autoformatEnabledByEnv()).toBe(true);
      }
    } finally {
      if (orig === undefined) delete process.env.CT_AUTOFORMAT;
      else process.env.CT_AUTOFORMAT = orig;
    }
  });
});

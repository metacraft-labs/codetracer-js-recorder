/**
 * M16b verification suite: JavaScript complex assignment patterns.
 *
 * Covers the five verification tests pinned in
 * `codetracer-specs/Planned-Features/Value-Origin-Tracking.milestones.org`
 * §M16b — destructuring (object + array + nested + with defaults),
 * rest / spread, optional chaining, and the Path A confidence-1.0
 * recorder-side contract for the JS complex fixture.
 *
 * As with the M16a tests in `m16a.test.ts`, we inspect the
 * `ManifestSlice.sites` array the SWC visitor emits — the runtime
 * event-buffer round-trip is exercised by the integration suite.
 */

import { describe, it, expect } from "vitest";
import { instrument } from "@codetracer/instrumenter";
import type { ManifestSlice, SiteEntry } from "@codetracer/instrumenter";

function inst(code: string, filename = "test.js") {
  return instrument(code, { filename });
}

function writeSites(slice: ManifestSlice): SiteEntry[] {
  return slice.sites.filter((s) => s.kind === "write");
}

/**
 * M16b verification 1: object destructuring.
 *
 *   const { a, b } = obj;
 *
 * Each unpacked element produces an Assignment event with
 * `RValue::FieldAccess` keyed on the property name (and the RHS
 * identifier as the source).
 */
describe("test_js_recorder_emits_destructuring_assignments", () => {
  it("emits one FieldAccess write site per object-destructured element", () => {
    const result = inst(`const { a, b } = obj;`);
    const sites = writeSites(result.manifestSlice);

    const aSite = sites.find((s) => s.target === "a");
    const bSite = sites.find((s) => s.target === "b");
    expect(
      aSite,
      `expected write site for 'a' in ${JSON.stringify(sites)}`,
    ).toBeDefined();
    expect(
      bSite,
      `expected write site for 'b' in ${JSON.stringify(sites)}`,
    ).toBeDefined();

    expect(aSite!.rvalueKind).toBe("FieldAccess");
    expect(aSite!.rvalueSource).toBe("obj");
    expect(aSite!.rvalueField).toBe("a");

    expect(bSite!.rvalueKind).toBe("FieldAccess");
    expect(bSite!.rvalueSource).toBe("obj");
    expect(bSite!.rvalueField).toBe("b");

    // The instrumented source carries one `__ct.write` call per
    // unpacked element (plus any unrelated step calls).
    const writeCalls = result.code.match(/__ct\.write\(\d+\)/g) ?? [];
    expect(writeCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("handles renaming `{ a: x, b: y } = obj`", () => {
    const result = inst(`const { a: x, b: y } = obj;`);
    const sites = writeSites(result.manifestSlice);
    const xSite = sites.find((s) => s.target === "x");
    const ySite = sites.find((s) => s.target === "y");
    expect(xSite).toBeDefined();
    expect(ySite).toBeDefined();
    expect(xSite!.rvalueKind).toBe("FieldAccess");
    expect(xSite!.rvalueField).toBe("a");
    expect(ySite!.rvalueKind).toBe("FieldAccess");
    expect(ySite!.rvalueField).toBe("b");
  });

  it("handles defaults `{ a = 10 } = obj`", () => {
    const result = inst(`const { a = 10 } = obj;`);
    const sites = writeSites(result.manifestSlice);
    const aSite = sites.find((s) => s.target === "a");
    expect(aSite).toBeDefined();
    expect(aSite!.rvalueKind).toBe("FieldAccess");
    expect(aSite!.rvalueField).toBe("a");
  });

  it("handles nested object patterns `{ a: { b } } = obj`", () => {
    const result = inst(`const { a: { b } } = obj;`);
    const sites = writeSites(result.manifestSlice);
    const bSite = sites.find((s) => s.target === "b");
    expect(
      bSite,
      `expected nested write site for 'b' in ${JSON.stringify(sites)}`,
    ).toBeDefined();
    // The nested RHS is obj.a, not a bare identifier — the visitor
    // surfaces this as FieldAccess but without a source identifier
    // (the db-backend correlates via the value snapshot).
    expect(bSite!.rvalueKind).toBe("FieldAccess");
    expect(bSite!.rvalueField).toBe("b");
  });
});

/**
 * M16b verification 2: array destructuring.
 *
 *   const [a, b] = arr;
 *
 * Each unpacked element produces an Assignment event with
 * `RValue::IndexAccess` keyed on the element index.
 */
describe("test_js_recorder_emits_array_destructuring", () => {
  it("emits one IndexAccess write site per array-destructured element", () => {
    const result = inst(`const [a, b] = arr;`);
    const sites = writeSites(result.manifestSlice);
    const aSite = sites.find((s) => s.target === "a");
    const bSite = sites.find((s) => s.target === "b");
    expect(aSite).toBeDefined();
    expect(bSite).toBeDefined();

    expect(aSite!.rvalueKind).toBe("IndexAccess");
    expect(aSite!.rvalueSource).toBe("arr");
    expect(aSite!.rvalueIndex).toBe(0);

    expect(bSite!.rvalueKind).toBe("IndexAccess");
    expect(bSite!.rvalueSource).toBe("arr");
    expect(bSite!.rvalueIndex).toBe(1);
  });

  it("skips holes `[, b] = arr` and still indexes the bound element", () => {
    const result = inst(`const [, b] = arr;`);
    const sites = writeSites(result.manifestSlice);
    expect(sites.length).toBe(1);
    const bSite = sites[0];
    expect(bSite.target).toBe("b");
    expect(bSite.rvalueKind).toBe("IndexAccess");
    expect(bSite.rvalueIndex).toBe(1);
  });

  it("handles defaults `[a, b = 10] = arr`", () => {
    const result = inst(`const [a, b = 10] = arr;`);
    const sites = writeSites(result.manifestSlice);
    const aSite = sites.find((s) => s.target === "a");
    const bSite = sites.find((s) => s.target === "b");
    expect(aSite).toBeDefined();
    expect(bSite).toBeDefined();
    expect(aSite!.rvalueIndex).toBe(0);
    expect(bSite!.rvalueIndex).toBe(1);
    expect(bSite!.rvalueKind).toBe("IndexAccess");
  });

  it("handles nested array patterns `[a, [b, c]] = nested`", () => {
    const result = inst(`const [a, [b, c]] = nested;`);
    const sites = writeSites(result.manifestSlice);
    const aSite = sites.find((s) => s.target === "a");
    const bSite = sites.find((s) => s.target === "b");
    const cSite = sites.find((s) => s.target === "c");
    expect(aSite).toBeDefined();
    expect(bSite).toBeDefined();
    expect(cSite).toBeDefined();
    // Outer element 0 has the bare-source `nested`.
    expect(aSite!.rvalueSource).toBe("nested");
    expect(aSite!.rvalueIndex).toBe(0);
    // Nested elements know their index but the RHS is `nested[1]`,
    // not a bare identifier — source is left unresolved.
    expect(bSite!.rvalueKind).toBe("IndexAccess");
    expect(bSite!.rvalueIndex).toBe(0);
    expect(cSite!.rvalueKind).toBe("IndexAccess");
    expect(cSite!.rvalueIndex).toBe(1);
  });
});

/**
 * M16b verification 3: rest / spread destructuring.
 *
 *   const [a, ...rest] = arr;
 *
 * The first element produces `IndexAccess`; the rest binding is
 * tagged `Compound` because the slice is a derived composite.
 */
describe("test_js_recorder_emits_rest_spread_assignment", () => {
  it("tags `...rest` as Compound and `a` as IndexAccess", () => {
    const result = inst(`const [a, ...rest] = arr;`);
    const sites = writeSites(result.manifestSlice);
    const aSite = sites.find((s) => s.target === "a");
    const restSite = sites.find((s) => s.target === "rest");
    expect(aSite).toBeDefined();
    expect(restSite).toBeDefined();
    expect(aSite!.rvalueKind).toBe("IndexAccess");
    expect(aSite!.rvalueIndex).toBe(0);
    expect(restSite!.rvalueKind).toBe("Compound");
    expect(restSite!.rvalueSource).toBe("arr");
  });

  it("tags object `...rest` as Compound", () => {
    const result = inst(`const { a, ...rest } = obj;`);
    const sites = writeSites(result.manifestSlice);
    const aSite = sites.find((s) => s.target === "a");
    const restSite = sites.find((s) => s.target === "rest");
    expect(aSite).toBeDefined();
    expect(restSite).toBeDefined();
    expect(aSite!.rvalueKind).toBe("FieldAccess");
    expect(restSite!.rvalueKind).toBe("Compound");
    expect(restSite!.rvalueSource).toBe("obj");
  });
});

/**
 * M16b verification 4: optional chaining.
 *
 *   x = obj?.field;
 *
 * The visitor classifies the chain as `FieldAccess` so the db-backend
 * can correlate the chain against the snapshot value (which carries
 * `undefined` when the guard short-circuits).
 */
describe("test_js_recorder_emits_optional_chaining", () => {
  it("classifies `let x = obj?.field` as FieldAccess", () => {
    const result = inst(`let x = obj?.field;`);
    const sites = writeSites(result.manifestSlice);
    const xSite = sites.find((s) => s.target === "x");
    expect(xSite).toBeDefined();
    expect(xSite!.rvalueKind).toBe("FieldAccess");
    expect(xSite!.rvalueSource).toBe("obj");
    expect(xSite!.rvalueField).toBe("field");
  });

  it("classifies nullish coalescing `a = b ?? c` as Compound", () => {
    const result = inst(`let a = b ?? c;`);
    const sites = writeSites(result.manifestSlice);
    const aSite = sites.find((s) => s.target === "a");
    expect(aSite).toBeDefined();
    expect(aSite!.rvalueKind).toBe("Compound");
  });

  it("classifies template literal `s = \\`hi ${name}\\`` as Compound", () => {
    const result = inst("let s = `hi ${name}`;");
    const sites = writeSites(result.manifestSlice);
    const sSite = sites.find((s) => s.target === "s");
    expect(sSite).toBeDefined();
    expect(sSite!.rvalueKind).toBe("Compound");
  });

  it('classifies static computed string index `obj["f"]` as FieldAccess', () => {
    const result = inst(`let x = obj["f"];`);
    const sites = writeSites(result.manifestSlice);
    const xSite = sites.find((s) => s.target === "x");
    expect(xSite).toBeDefined();
    expect(xSite!.rvalueKind).toBe("FieldAccess");
    expect(xSite!.rvalueField).toBe("f");
  });
});

/**
 * M16b verification 5: Path A confidence-1.0 (recorder side, complex
 * fixture).
 *
 * SKIP-narrow: as with the M16a `_javascript_simple` test, the
 * confidence-1.0 surfacing is gated on the M16-series db-backend Path
 * A classifier extension.  This test verifies the *recorder* half of
 * the contract for the complex fixture — every link in the chain
 * `arr = [a, b]; const [first, second] = arr;` must surface as a
 * write site with `rvalueKind: "IndexAccess"` keyed on the field
 * name and source, which is the necessary condition for the
 * db-backend to classify the chain as Path A.
 */
describe("test_origin_chain_path_a_confidence_one_javascript_complex", () => {
  it("emits a contiguous typed chain through object destructuring", () => {
    const result = inst(`
const a = 10;
const b = 20;
const obj = { a, b };
const { a: first, b: second } = obj;
const sum = first;
`);
    const sites = writeSites(result.manifestSlice);
    const firstSite = sites.find((s) => s.target === "first");
    const secondSite = sites.find((s) => s.target === "second");
    const sumSite = sites.find((s) => s.target === "sum");
    expect(
      firstSite,
      `chain missing 'first': ${JSON.stringify(sites)}`,
    ).toBeDefined();
    expect(secondSite).toBeDefined();
    expect(sumSite).toBeDefined();

    // Object destructuring lands as FieldAccess on `obj`.
    expect(firstSite!.rvalueKind).toBe("FieldAccess");
    expect(firstSite!.rvalueSource).toBe("obj");
    expect(firstSite!.rvalueField).toBe("a");
    expect(secondSite!.rvalueKind).toBe("FieldAccess");
    expect(secondSite!.rvalueSource).toBe("obj");
    expect(secondSite!.rvalueField).toBe("b");

    // The chain terminator (sum -> first) is a Simple copy.
    expect(sumSite!.rvalueKind).toBe("Simple");
    expect(sumSite!.rvalueSource).toBe("first");
  });

  it("emits a contiguous typed chain through array destructuring", () => {
    const result = inst(`
const arr = [10, 20];
const [a, b] = arr;
const c = a;
`);
    const sites = writeSites(result.manifestSlice);
    const aSite = sites.find((s) => s.target === "a");
    const bSite = sites.find((s) => s.target === "b");
    const cSite = sites.find((s) => s.target === "c");
    expect(aSite).toBeDefined();
    expect(bSite).toBeDefined();
    expect(cSite).toBeDefined();
    expect(aSite!.rvalueKind).toBe("IndexAccess");
    expect(aSite!.rvalueSource).toBe("arr");
    expect(aSite!.rvalueIndex).toBe(0);
    expect(bSite!.rvalueKind).toBe("IndexAccess");
    expect(bSite!.rvalueSource).toBe("arr");
    expect(bSite!.rvalueIndex).toBe(1);
    expect(cSite!.rvalueKind).toBe("Simple");
    expect(cSite!.rvalueSource).toBe("a");
  });
});

/**
 * M16a verification suite: JavaScript Assignment events.
 *
 * Mirrors the Ruby tests in `codetracer-ruby-recorder/test/test_m16a_assignments.rb`
 * (and the Python tests in
 * `codetracer-python-recorder/.../runtime_tracer.rs::tests`).  We
 * inspect the instrumented JS source and the manifest write-site
 * entries the SWC visitor emits — the runtime-side event-buffer
 * round-trip is exercised by the existing integration test suite,
 * which we cross-link from the docstring on each test below.
 */

import { describe, it, expect } from "vitest";
import { instrument } from "@codetracer/instrumenter";
import type { ManifestSlice } from "@codetracer/instrumenter";

function inst(code: string, filename = "test.js") {
  return instrument(code, { filename });
}

/**
 * Helper: walk a ManifestSlice's `sites` array and pick out every
 * write site (`kind === "write"`), preserving manifest order.
 */
function writeSites(slice: ManifestSlice) {
  return slice.sites.filter((s) => s.kind === "write");
}

/**
 * M16a verification 3: simple assignment shape recognition.
 *
 *   const b = a;  =>  Assignment { target: "b", rvalueKind: "Simple", rvalueSource: "a" }
 */
describe("test_js_recorder_emits_assignment_for_simple_assignment", () => {
  it("emits a write site with RValue::Simple for `const b = a`", () => {
    const result = inst(`
const a = 10;
const b = a;
`);
    const sites = writeSites(result.manifestSlice);
    // We expect at least two write sites — one for `const a = 10`
    // (Literal) and one for `const b = a` (Simple).  We pin on the
    // *b* assignment for the verification.
    const bSite = sites.find((s) => s.target === "b");
    expect(
      bSite,
      `expected write site for 'b', got ${JSON.stringify(sites)}`,
    ).toBeDefined();
    expect(bSite!.rvalueKind).toBe("Simple");
    expect(bSite!.rvalueSource).toBe("a");

    // The instrumented source should contain a __ct.write(siteId)
    // call referencing the new write site.
    expect(result.code).toMatch(/__ct\.write\(\d+\)/);
  });

  it("emits a write site with RValue::Literal for `let a = 10`", () => {
    const result = inst(`let a = 10;`);
    const sites = writeSites(result.manifestSlice);
    const aSite = sites.find((s) => s.target === "a");
    expect(aSite).toBeDefined();
    expect(aSite!.rvalueKind).toBe("Literal");
  });

  it("emits a write site with RValue::FunctionReturn for `const r = foo()`", () => {
    const result = inst(`
function foo() { return 42; }
const r = foo();
`);
    const sites = writeSites(result.manifestSlice);
    const rSite = sites.find((s) => s.target === "r");
    expect(rSite).toBeDefined();
    expect(rSite!.rvalueKind).toBe("FunctionReturn");
  });

  it("emits write sites for assignment expressions (`a = expr`)", () => {
    const result = inst(`
let a = 1;
let b = 2;
a = b;
`);
    const sites = writeSites(result.manifestSlice);
    // Look for the LATE 'a' assignment that pulls from b.
    const aFromB = sites.find(
      (s) => s.target === "a" && s.rvalueKind === "Simple",
    );
    expect(aFromB).toBeDefined();
    expect(aFromB!.rvalueSource).toBe("b");
  });

  it("emits a write site with RValue::Compound for compound-assignment `a += 1`", () => {
    const result = inst(`
let a = 1;
a += 1;
`);
    const sites = writeSites(result.manifestSlice);
    const compound = sites.find(
      (s) => s.target === "a" && s.rvalueKind === "Compound",
    );
    expect(compound).toBeDefined();
  });
});

/**
 * M16a verification 5: Path A confidence-1.0 (recorder side).
 *
 * SKIP-narrow: the confidence-1.0 surfacing is gated on the
 * M16-series db-backend Path A classifier extension.  This test
 * verifies the *recorder* half of the contract — every link in the
 * chain `a -> b -> c` must surface as a write site with
 * `rvalueKind: "Simple"` (or `Literal` for the chain root).  Without
 * that the db-backend cannot classify the chain as Path A.
 */
describe("test_origin_chain_path_a_confidence_one_javascript_simple", () => {
  it("emits a contiguous Simple chain for `a = 10; b = a; c = b;`", () => {
    const result = inst(`
const a = 10;
const b = a;
const c = b;
`);
    const sites = writeSites(result.manifestSlice);
    const aSite = sites.find((s) => s.target === "a");
    const bSite = sites.find((s) => s.target === "b");
    const cSite = sites.find((s) => s.target === "c");
    expect(aSite).toBeDefined();
    expect(bSite).toBeDefined();
    expect(cSite).toBeDefined();

    expect(aSite!.rvalueKind).toBe("Literal");
    expect(bSite!.rvalueKind).toBe("Simple");
    expect(bSite!.rvalueSource).toBe("a");
    expect(cSite!.rvalueKind).toBe("Simple");
    expect(cSite!.rvalueSource).toBe("b");
  });
});

/**
 * Bonus: function parameter binding surfaces as a Compound write
 * site at function entry (the actual values flow through the call
 * args; the db-backend correlates them via the manifest function
 * signature).
 */
describe("test_js_recorder_emits_parameter_binding", () => {
  it("emits write sites for each named function parameter", () => {
    const result = inst(`
function add(x, y) {
  return x + y;
}
`);
    const sites = writeSites(result.manifestSlice);
    const xSite = sites.find((s) => s.target === "x");
    const ySite = sites.find((s) => s.target === "y");
    expect(xSite).toBeDefined();
    expect(ySite).toBeDefined();
    expect(xSite!.rvalueKind).toBe("Compound");
    expect(ySite!.rvalueKind).toBe("Compound");
  });
});

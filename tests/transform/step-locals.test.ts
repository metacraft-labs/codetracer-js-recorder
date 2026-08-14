/**
 * M37 — per-step visible-locals capture, instrumenter layer.
 *
 * These tests pin the *static* half of the fix: which names the SWC
 * visitor decides are in scope at each step site, what it writes into
 * the manifest, and what the emitted `__ct.step` call looks like.  The
 * end-to-end half (that those names and their values actually reach the
 * trace) lives in `tests/e2e/step-locals-recording.test.ts`.
 *
 * No mocks: every assertion runs the real SWC parse → transform →
 * codegen pipeline over real source text.
 *
 * Background: before M37 the JS recorder emitted a `Value` event for a
 * binding only on the step that wrote it (`__ct.enter` for parameters,
 * the M16a `__ct.write` pass for assignments).  That is enough to
 * reconstruct a variable's history but not to answer "what is in scope
 * at this step", so the State panel was empty on any line that did not
 * itself perform an assignment — the symptom reported in issue #602.
 */

import { describe, it, expect } from "vitest";
import { instrument } from "@codetracer/instrumenter";
import type { SiteEntry } from "@codetracer/instrumenter";

/** Instrument a snippet and hand back both halves of the result. */
function inst(code: string, options: Record<string, unknown> = {}) {
  const result = instrument(code, { filename: "test.js", ...options });
  return result;
}

/** All step sites from a manifest slice, in id order. */
function stepSites(sites: SiteEntry[]): SiteEntry[] {
  return sites.filter((s) => s.kind === "step");
}

/**
 * The capture list for the step site whose source line is `line`.
 *
 * Returns `[]` for a site that captures nothing, and throws when no
 * step site exists on that line — an assertion that silently passed
 * because the line was mis-identified would be worse than useless.
 */
function localsAtLine(sites: SiteEntry[], line: number): string[] {
  const matches = stepSites(sites).filter((s) => s.line === line);
  if (matches.length === 0) {
    const lines = stepSites(sites).map((s) => s.line);
    throw new Error(
      `no step site on line ${line}; step sites are on lines ${lines.join(", ")}`,
    );
  }
  return matches[0].vars ?? [];
}

// =============================================
// The reported bug: locals on a line that assigns nothing
// =============================================
describe("test_step_locals_reported_shape", () => {
  // The exact program from issue #602's reproduction, reduced to one
  // frame carrying all three declaration forms.
  const PROGRAM = `function compute(a, b) {
  const base = a + b;
  let scaled = base * 2;
  var offset = 10;
  scaled = scaled + offset;
  return scaled;
}
compute(10, 32);
`;

  it("captures every declared local on the return line", () => {
    const { manifestSlice } = inst(PROGRAM);

    // Line 6 is `return scaled;` — it writes nothing, so before M37 no
    // value event landed on it at all and the State panel was empty.
    expect(localsAtLine(manifestSlice.sites, 6)).toEqual([
      "a",
      "b",
      "base",
      "scaled",
      "offset",
    ]);
  });

  it("grows the capture list one declaration at a time", () => {
    const { manifestSlice } = inst(PROGRAM);
    const sites = manifestSlice.sites;

    // Each step sees exactly the bindings declared strictly before it.
    expect(localsAtLine(sites, 2)).toEqual(["a", "b"]);
    expect(localsAtLine(sites, 3)).toEqual(["a", "b", "base"]);
    expect(localsAtLine(sites, 4)).toEqual(["a", "b", "base", "scaled"]);
    expect(localsAtLine(sites, 5)).toEqual([
      "a",
      "b",
      "base",
      "scaled",
      "offset",
    ]);
  });

  it("emits the capture array positionally aligned with the manifest", () => {
    const { code, manifestSlice } = inst(PROGRAM);
    const collapsed = code.replace(/\s+/g, " ");

    // Find the site id for the `return` line and assert the generated
    // call passes exactly that site's names, in that order. The addon
    // zips the two positionally, so a mismatch here would attribute
    // values to the wrong variables.
    const returnSite = stepSites(manifestSlice.sites).find((s) => s.line === 6);
    expect(returnSite).toBeDefined();
    const siteId = manifestSlice.sites.indexOf(returnSite!);
    expect(collapsed).toContain(
      `__ct.step(${siteId}, [ a, b, base, scaled, offset ])`,
    );
  });
});

// =============================================
// Temporal dead zone
// =============================================
describe("test_step_locals_tdz", () => {
  it("never names a let/const at its own declaration step", () => {
    // Emitting `x` on the step that precedes `let x = 1` would evaluate
    // `x` inside its temporal dead zone and throw a ReferenceError from
    // inside instrumentation — recording must not change behaviour.
    const { manifestSlice } = inst(`function f() {
  let x = 1;
  const y = 2;
  return x + y;
}
`);
    expect(localsAtLine(manifestSlice.sites, 2)).toEqual([]);
    expect(localsAtLine(manifestSlice.sites, 3)).toEqual(["x"]);
    expect(localsAtLine(manifestSlice.sites, 4)).toEqual(["x", "y"]);
  });

  it("runs a TDZ-shaped program without throwing", () => {
    // The strongest form of the assertion above: execute the
    // instrumented output for real and require that it still produces
    // the program's answer.
    const { code } = inst(`function f() {
  let x = 1;
  const y = 2;
  return x + y;
}
globalThis.__result = f();
`);
    const calls: Array<unknown[]> = [];
    const ct = {
      step(_siteId: number, locals?: unknown[]) {
        if (locals) calls.push(locals);
      },
      enter() {},
      ret(_fnId: number, value?: unknown) {
        return value;
      },
      write() {},
    };
    const g = globalThis as unknown as Record<string, unknown>;
    const previous = g.__ct;
    g.__ct = ct;
    try {
      new Function(code)();
      expect(g.__result).toBe(3);
    } finally {
      g.__ct = previous;
    }
    // The last captured set is the `return` line: both bindings live.
    expect(calls[calls.length - 1]).toEqual([1, 2]);
  });
});

// =============================================
// Block scoping vs. var hoisting
// =============================================
describe("test_step_locals_scoping", () => {
  it("drops a block-scoped let once its block ends but keeps a var", () => {
    const { manifestSlice } = inst(`function f(flag) {
  if (flag) {
    let inner = 1;
    var hoisted = 2;
    inner;
  }
  return 0;
}
`);
    // Inside the block, after both declarations.
    expect(localsAtLine(manifestSlice.sites, 5)).toEqual([
      "flag",
      "hoisted",
      "inner",
    ]);
    // After the block: `let inner` is gone, `var hoisted` survives
    // because it is scoped to the function, not the block.
    expect(localsAtLine(manifestSlice.sites, 7)).toEqual(["flag", "hoisted"]);
  });

  it("scopes a for-loop let binder to the loop body", () => {
    const { manifestSlice } = inst(`function f(n) {
  let total = 0;
  for (let i = 0; i < n; i++) {
    total += i;
  }
  return total;
}
`);
    // Scope order: the function scope (parameter, then `let total`),
    // then the loop head's own block scope.
    expect(localsAtLine(manifestSlice.sites, 4)).toEqual(["n", "total", "i"]);
    expect(localsAtLine(manifestSlice.sites, 6)).toEqual(["n", "total"]);
  });

  it("captures for-of and catch binders", () => {
    const { manifestSlice } = inst(`function f(items) {
  for (const item of items) {
    item;
  }
  try {
    items.go();
  } catch (err) {
    err;
  }
  return 0;
}
`);
    expect(localsAtLine(manifestSlice.sites, 3)).toEqual(["items", "item"]);
    expect(localsAtLine(manifestSlice.sites, 8)).toEqual(["items", "err"]);
    // The catch binding does not leak past its block.
    expect(localsAtLine(manifestSlice.sites, 10)).toEqual(["items"]);
  });

  it("decomposes destructured parameters into their real binders", () => {
    // `extractParamNames` reports `_param0` for a destructured
    // parameter because that is the display name for the manifest's
    // signature; the capture list needs the names that actually exist
    // as bindings in the body.
    const { manifestSlice } =
      inst(`function f({ a, b: renamed }, [first], ...rest) {
  return a;
}
`);
    expect(localsAtLine(manifestSlice.sites, 2)).toEqual([
      "a",
      "renamed",
      "first",
      "rest",
    ]);
  });

  it("decomposes destructured declarations", () => {
    const { manifestSlice } = inst(`function f(src) {
  const { a, b: bee } = src;
  const [head, ...tail] = src.list;
  return a;
}
`);
    expect(localsAtLine(manifestSlice.sites, 4)).toEqual([
      "src",
      "a",
      "bee",
      "head",
      "tail",
    ]);
  });
});

// =============================================
// Frame isolation
// =============================================
describe("test_step_locals_frame_isolation", () => {
  it("reports only the innermost function's own locals", () => {
    // A nested function must not name its enclosing frame's bindings:
    // a closure can be called before an outer `let` it captures has
    // initialised, which would turn instrumentation into a
    // ReferenceError. It also matches the frame model the State panel
    // shows for Ruby and Python.
    const { manifestSlice } = inst(`function outer(a) {
  const outerLocal = 1;
  function inner(b) {
    const innerLocal = 2;
    return b;
  }
  return inner(a);
}
`);
    expect(localsAtLine(manifestSlice.sites, 5)).toEqual(["b", "innerLocal"]);
    expect(localsAtLine(manifestSlice.sites, 7)).toEqual(["a", "outerLocal"]);
  });

  it("captures an arrow function's parameters in its concise body", () => {
    const { manifestSlice } = inst(`const double = (value) => value * 2;
double(21);
`);
    expect(localsAtLine(manifestSlice.sites, 1)).toEqual(["value"]);
  });

  it("captures module-level bindings in the module frame", () => {
    const { manifestSlice } = inst(`const first = 1;
let second = 2;
second = first + second;
`);
    expect(localsAtLine(manifestSlice.sites, 1)).toEqual([]);
    expect(localsAtLine(manifestSlice.sites, 2)).toEqual(["first"]);
    expect(localsAtLine(manifestSlice.sites, 3)).toEqual(["first", "second"]);
  });

  it("does not capture function or class declarations", () => {
    // Both are hoisted bindings of little debugging value, and a class
    // binding carries a TDZ of its own.
    const { manifestSlice } = inst(`function f() {
  function helper() {}
  class Thing {}
  const value = 1;
  return value;
}
`);
    expect(localsAtLine(manifestSlice.sites, 5)).toEqual(["value"]);
  });

  it("does not capture `arguments`", () => {
    // `__ct.enter` already records the call's arguments; re-reading the
    // object on every step would materialise it again for no new
    // information.
    const { code } = inst(`function f() {
  return arguments.length;
}
`);
    expect(code).not.toMatch(/__ct\.step\(\d+,\s*\[\s*arguments/);
  });
});

// =============================================
// Budgets and the kill switch
// =============================================
describe("test_step_locals_budget", () => {
  /** A function body declaring `count` distinct locals. */
  function programWithLocals(count: number): string {
    const decls = Array.from(
      { length: count },
      (_, i) => `  const v${i} = ${i};`,
    ).join("\n");
    return `function f() {\n${decls}\n  return 0;\n}\n`;
  }

  it("caps the number of locals captured per step", () => {
    const count = 40;
    const { manifestSlice } = inst(programWithLocals(count), {
      maxStepLocals: 8,
    });
    // The `return` statement sits on the line after the declarations.
    const locals = localsAtLine(manifestSlice.sites, count + 2);
    expect(locals).toHaveLength(8);
    // Truncation keeps the first names in scope order, which is stable
    // across runs (parameters first, then declaration order).
    expect(locals).toEqual(["v0", "v1", "v2", "v3", "v4", "v5", "v6", "v7"]);
  });

  it("does not truncate an ordinary frame at the default cap", () => {
    const { manifestSlice } = inst(programWithLocals(20));
    expect(localsAtLine(manifestSlice.sites, 22)).toHaveLength(20);
  });

  it("restores the pre-M37 shape when disabled", () => {
    const { code, manifestSlice } = inst(
      `function f(a) {
  const b = a + 1;
  return b;
}
`,
      { stepLocals: false },
    );
    for (const site of stepSites(manifestSlice.sites)) {
      expect(site.vars).toBeUndefined();
    }
    // Every step call is the bare one-argument form.
    expect(code).not.toMatch(/__ct\.step\(\d+,/);
    expect(code).toMatch(/__ct\.step\(\d+\)/);
  });
});

// =============================================
// The instrumented program still behaves identically
// =============================================
describe("test_step_locals_semantics_preserved", () => {
  it("runs a program using every capture shape without error", () => {
    const source = `
function shapes({ a }, [b], ...rest) {
  var acc = a + b;
  for (let i = 0; i < 3; i++) {
    acc += i;
  }
  for (const r of rest) {
    acc += r;
  }
  try {
    if (acc < 0) throw new Error("negative");
  } catch (err) {
    acc = 0;
  }
  const arrow = (z) => z + acc;
  return arrow(1);
}
globalThis.__shapesResult = shapes({ a: 1 }, [2], 3, 4);
`;
    const { code } = inst(source);
    const g = globalThis as unknown as Record<string, unknown>;
    const previous = g.__ct;
    g.__ct = {
      step() {},
      enter() {},
      ret(_fnId: number, value?: unknown) {
        return value;
      },
      write() {},
    };
    try {
      new Function(code)();
      // 1 + 2 + (0+1+2) + 3 + 4 = 13, then arrow(1) = 14.
      expect(g.__shapesResult).toBe(14);
    } finally {
      g.__ct = previous;
    }
  });
});

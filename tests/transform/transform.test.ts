import { describe, it, expect } from "vitest";
import { instrument } from "@codetracer/instrumenter";
import type { ManifestSlice } from "@codetracer/instrumenter";

/**
 * Helper: instrument code and return the result.
 */
function inst(code: string, filename = "test.js") {
  return instrument(code, { filename });
}

/**
 * Create a no-op __ct mock for semantic equivalence testing.
 */
function createNoopCt() {
  return {
    step(_siteId: number) {},
    enter(_fnId: number, _args: IArguments) {},
    ret(_fnId: number, value?: unknown) {
      return value;
    },
  };
}

// =============================================
// test_step_insertion_basic
// =============================================
describe("test_step_insertion_basic", () => {
  it("inserts __ct.step calls before statements in a function", () => {
    const result = inst(`
function foo() {
  let x = 1;
  let y = 2;
  return x + y;
}
`);
    const code = result.code;

    // Should have step calls before each statement
    const stepMatches = code.match(/__ct\.step\(\d+\)/g);
    expect(stepMatches).not.toBeNull();
    // At least 3 step calls inside the function (let x, let y, return)
    // plus 1 for the function declaration itself at module level
    expect(stepMatches!.length).toBeGreaterThanOrEqual(4);

    // Steps should appear before the statements
    const lines = code.split("\n").map((l) => l.trim());
    const letXIdx = lines.findIndex((l) => l.startsWith("let x"));
    const stepBeforeLetX = lines.findIndex(
      (l, i) => l.startsWith("__ct.step(") && i < letXIdx && i > 0,
    );
    expect(stepBeforeLetX).toBeGreaterThan(-1);
  });

  it("does not insert step before empty statements", () => {
    const result = inst(`
function foo() {
  ;
  let x = 1;
}
`);
    const code = result.code;
    // The empty statement should not get a step call
    // Count steps inside function — should be 1 for `let x`
    const fnBody = code.split("__ct.enter(1, arguments);")[1];
    const stepsInFn = (fnBody?.match(/__ct\.step\(\d+\)/g) || []).length;
    expect(stepsInFn).toBe(1);
  });
});

// =============================================
// test_enter_return_rewrite
// =============================================
describe("test_enter_return_rewrite", () => {
  it("inserts __ct.enter at the beginning of function body", () => {
    const result = inst(`
function foo(a, b) {
  return a + b;
}
`);
    const code = result.code;
    // The function body should start with __ct.enter(fnId, arguments)
    expect(code).toContain("__ct.enter(1, arguments)");
  });

  it("rewrites return statements to use __ct.ret", () => {
    const result = inst(`
function add(a, b) {
  return a + b;
}
`);
    const code = result.code;
    expect(code).toContain("return __ct.ret(1, a + b)");
  });

  it("rewrites void return to __ct.ret(fnId)", () => {
    const result = inst(`
function doSomething() {
  if (true) return;
  console.log("hi");
}
`);
    const code = result.code;
    expect(code).toContain("return __ct.ret(1)");
  });

  it("adds implicit __ct.ret for functions without explicit return", () => {
    const result = inst(`
function greet(name) {
  console.log("Hello " + name);
}
`);
    const code = result.code;
    // Should have __ct.ret(1) at the end of the function
    const fnBodyMatch = code.match(/function greet\(name\)\s*\{([\s\S]*?)\n\}/);
    expect(fnBodyMatch).not.toBeNull();
    expect(fnBodyMatch![1]).toContain("__ct.ret(1)");
  });

  it("instruments module-level code as a top-level function", () => {
    const result = inst(`
const x = 1;
console.log(x);
`);
    const code = result.code;
    // Module-level enter
    expect(code).toContain("__ct.enter(0, arguments)");
    // Module-level ret at the end
    const lines = code.trim().split("\n");
    const lastLine = lines[lines.length - 1].trim();
    expect(lastLine).toMatch(/__ct\.ret\(0\)/);
  });
});

// =============================================
// test_arrow_function_instrumentation
// =============================================
describe("test_arrow_function_instrumentation", () => {
  it("transforms arrow function with expression body", () => {
    const result = inst(`const add = (a, b) => a + b;`);
    const code = result.code;
    // Arrow should be expanded to block body
    expect(code).toContain("__ct.enter(1, arguments)");
    expect(code).toContain("return __ct.ret(1, a + b)");
  });

  it("transforms arrow function with block body", () => {
    const result = inst(`
const add = (a, b) => {
  return a + b;
};
`);
    const code = result.code;
    expect(code).toContain("__ct.enter(1, arguments)");
    expect(code).toContain("return __ct.ret(1, a + b)");
  });

  it("handles arrow with no return in block body", () => {
    const result = inst(`
const log = (msg) => {
  console.log(msg);
};
`);
    const code = result.code;
    expect(code).toContain("__ct.enter(1, arguments)");
    // Should have implicit ret at end
    expect(code).toContain("__ct.ret(1)");
  });
});

// =============================================
// test_manifest_generation
// =============================================
describe("test_manifest_generation", () => {
  it("generates manifest with correct paths, functions, and sites", () => {
    const result = inst(
      `
function greet(name) {
  return "Hello, " + name;
}
greet("World");
`,
      "src/main.js",
    );

    const m: ManifestSlice = result.manifestSlice;

    // Should have the file path
    expect(m.paths).toEqual(["src/main.js"]);

    // Should have at least 2 functions: <module> and greet
    expect(m.functions.length).toBeGreaterThanOrEqual(2);
    expect(m.functions[0].name).toBe("<module>");
    expect(m.functions[1].name).toBe("greet");

    // All functions should reference pathIndex 0
    for (const fn of m.functions) {
      expect(fn.pathIndex).toBe(0);
    }

    // Should have call, return, and step sites
    const callSites = m.sites.filter((s) => s.kind === "call");
    const returnSites = m.sites.filter((s) => s.kind === "return");
    const stepSites = m.sites.filter((s) => s.kind === "step");

    expect(callSites.length).toBeGreaterThanOrEqual(2); // module + greet
    expect(returnSites.length).toBeGreaterThanOrEqual(2); // module + greet
    expect(stepSites.length).toBeGreaterThanOrEqual(1);

    // call sites should have fnId
    for (const site of callSites) {
      expect(site.fnId).toBeDefined();
      expect(typeof site.fnId).toBe("number");
    }

    // return sites should have fnId
    for (const site of returnSites) {
      expect(site.fnId).toBeDefined();
      expect(typeof site.fnId).toBe("number");
    }
  });

  it("assigns sequential siteIds (indices)", () => {
    const result = inst(`
function foo() { return 1; }
function bar() { return 2; }
`);

    // Sites should be a flat array with sequential indices
    const m = result.manifestSlice;
    expect(m.sites.length).toBeGreaterThan(0);

    // Each site's implicit index (its position in the array) is its siteId
    // Verify all sites have valid fields
    for (const site of m.sites) {
      expect(["step", "call", "return"]).toContain(site.kind);
      expect(typeof site.pathIndex).toBe("number");
      expect(typeof site.line).toBe("number");
      expect(typeof site.col).toBe("number");
    }
  });
});

// =============================================
// test_use_strict_preserved
// =============================================
describe("test_use_strict_preserved", () => {
  it("does not insert instrumentation before module-level directive", () => {
    const result = inst(`"use strict";
var x = 1;`);
    const code = result.code;
    const lines = code
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    // "use strict" should be the first line
    expect(lines[0]).toMatch(/^["']use strict["']/);

    // No __ct call should precede it
    const useStrictIdx = code.indexOf("use strict");
    const firstCtCall = code.indexOf("__ct.");
    expect(firstCtCall).toBeGreaterThan(useStrictIdx);
  });

  it("does not insert instrumentation before function-level directive", () => {
    const result = inst(`
function foo() {
  "use strict";
  return 1;
}
`);
    const code = result.code;

    // Inside the function body, "use strict" should come before __ct.enter
    const fnBody = code.split(/function foo\(\)\s*\{/)[1];
    expect(fnBody).toBeDefined();

    const useStrictPos = fnBody!.indexOf('"use strict"');
    const enterPos = fnBody!.indexOf("__ct.enter(");
    expect(useStrictPos).toBeLessThan(enterPos);
  });
});

// =============================================
// test_super_call_ordering
// =============================================
describe("test_super_call_ordering", () => {
  it("delays __ct.enter until after super() in derived constructors", () => {
    const result = inst(`
class Base {}
class Child extends Base {
  constructor() {
    super();
    this.x = 1;
  }
}
`);
    const code = result.code;

    // Base has no constructor, so only Child has one in the output.
    // Find the constructor body — there should be exactly one.
    const ctorMatch = code.match(/constructor\(\)\s*\{([\s\S]*?)\n\s{4}\}/);
    expect(ctorMatch).not.toBeNull();

    const ctorBody = ctorMatch![1];
    const superPos = ctorBody.indexOf("super()");
    const enterPos = ctorBody.indexOf("__ct.enter(");

    expect(superPos).toBeGreaterThan(-1);
    expect(enterPos).toBeGreaterThan(-1);
    expect(enterPos).toBeGreaterThan(superPos);
  });

  it("places __ct.enter at the start for base class constructors", () => {
    const result = inst(`
class Base {
  constructor() {
    this.x = 1;
  }
}
`);
    const code = result.code;

    // In base class, __ct.enter should be at the start
    const ctorMatch = code.match(/constructor\(\)\s*\{([\s\S]*?)\n\s{4}\}/);
    expect(ctorMatch).not.toBeNull();

    const ctorBody = ctorMatch![1];
    const enterPos = ctorBody.indexOf("__ct.enter(");
    const thisAssignPos = ctorBody.indexOf("this.x");

    expect(enterPos).toBeGreaterThan(-1);
    expect(enterPos).toBeLessThan(thisAssignPos);
  });
});

// =============================================
// test_semantic_equivalence
// =============================================
describe("test_semantic_equivalence", () => {
  it("instrumented code produces same output with no-op __ct", () => {
    const original = `
function factorial(n) {
  if (n <= 1) return 1;
  return n * factorial(n - 1);
}

function main() {
  const results = [];
  for (let i = 0; i <= 5; i++) {
    results.push(factorial(i));
  }
  return results;
}
`;

    // Run original
    const originalFn = new Function(original + "\nreturn main();");
    const originalResult = originalFn();

    // Instrument
    const { code: instrumentedCode } = inst(original);

    // Run instrumented with no-op __ct
    const wrappedCode = `
      const __ct = {
        step: function(_siteId) {},
        enter: function(_fnId, _args) {},
        ret: function(_fnId, value) { return value; },
      };
      ${instrumentedCode}
      return main();
    `;
    const instrumentedFn = new Function(wrappedCode);
    const instrumentedResult = instrumentedFn();

    expect(instrumentedResult).toEqual(originalResult);
    expect(instrumentedResult).toEqual([1, 1, 2, 6, 24, 120]);
  });

  it("instrumented arrow functions produce same output", () => {
    const original = `
const double = (x) => x * 2;
const add = (a, b) => { return a + b; };
`;

    // Run original — use Function body for the original
    const originalFn = new Function(
      original + "\nreturn [double(5), add(3, 4)];",
    );
    const originalResult = originalFn();

    // Instrument only the function definitions (no top-level return)
    const { code: instrumentedCode } = inst(original);

    const wrappedCode = `
      const __ct = {
        step: function(_siteId) {},
        enter: function(_fnId, _args) {},
        ret: function(_fnId, value) { return value; },
      };
      ${instrumentedCode}
      return [double(5), add(3, 4)];
    `;

    const instrumentedFn = new Function(wrappedCode);
    const instrumentedResult = instrumentedFn();

    expect(instrumentedResult).toEqual(originalResult);
    expect(instrumentedResult).toEqual([10, 7]);
  });

  it("instrumented code handles complex control flow", () => {
    const original = `
function classify(n) {
  if (n < 0) return "negative";
  if (n === 0) return "zero";
  if (n % 2 === 0) return "even";
  return "odd";
}
`;
    const originalFn = new Function(
      original +
        "\nreturn [classify(-5), classify(0), classify(4), classify(7)];",
    );
    const originalResult = originalFn();

    // Instrument only the function definition (no top-level return)
    const { code } = inst(original);

    const wrappedCode = `
      const __ct = {
        step: function(_siteId) {},
        enter: function(_fnId, _args) {},
        ret: function(_fnId, value) { return value; },
      };
      ${code}
      return [classify(-5), classify(0), classify(4), classify(7)];
    `;

    const instrumentedFn = new Function(wrappedCode);
    const instrumentedResult = instrumentedFn();

    expect(instrumentedResult).toEqual(originalResult);
    expect(instrumentedResult).toEqual(["negative", "zero", "even", "odd"]);
  });
});

// =============================================
// Additional edge case tests
// =============================================
describe("edge cases", () => {
  it("handles nested functions", () => {
    const result = inst(`
function outer() {
  function inner() {
    return 42;
  }
  return inner();
}
`);
    const code = result.code;

    // Both outer and inner should get enter/ret
    expect(code).toContain("__ct.enter(1, arguments)"); // outer
    expect(code).toContain("__ct.enter(2, arguments)"); // inner

    // Both should have returns wrapped
    expect(code).toMatch(/__ct\.ret\(2, 42\)/);
  });

  it("handles class methods", () => {
    const result = inst(`
class Calculator {
  add(a, b) {
    return a + b;
  }
  subtract(a, b) {
    return a - b;
  }
}
`);
    const code = result.code;
    const m = result.manifestSlice;

    // Should have functions for both methods
    const fnNames = m.functions.map((f) => f.name);
    expect(fnNames).toContain("add");
    expect(fnNames).toContain("subtract");
  });

  it("handles while loop without braces", () => {
    const result = inst(`
function countdown(n) {
  while (n > 0) n--;
  return n;
}
`);
    const code = result.code;

    // The while body should be wrapped in a block with step
    expect(code).toMatch(/while\s*\(n > 0\)\s*\{/);
    expect(code).toContain("__ct.step(");
  });

  it("handles switch statements", () => {
    const result = inst(`
function describe(x) {
  switch (x) {
    case 1: return "one";
    case 2: return "two";
    default: return "other";
  }
}
`);
    const code = result.code;
    expect(code).toContain("__ct.ret(1,");
  });

  it("handles try/catch/finally", () => {
    const result = inst(`
function safe(fn) {
  try {
    return fn();
  } catch (e) {
    return null;
  } finally {
    console.log("done");
  }
}
`);
    const code = result.code;

    // Should have steps in try, catch, and finally blocks
    expect(code).toContain("__ct.step(");
    // Return in try should be wrapped
    expect(code).toContain("__ct.ret(1,");
  });

  it("handles TypeScript files", () => {
    const result = inst(
      `
function greet(name: string): string {
  return "Hello, " + name;
}
`,
      "test.ts",
    );
    const code = result.code;
    // Should produce valid output (TypeScript annotations preserved)
    expect(code).toContain("__ct.enter(1, arguments)");
    expect(code).toContain("__ct.ret(1,");
  });

  it("handles import and export statements", () => {
    // Imports should not get step calls
    const result = inst(
      `
import { foo } from "./foo";
export const bar = foo();
`,
      "test.ts",
    );
    const code = result.code;
    // Import should not be preceded by __ct.step
    const importIdx = code.indexOf("import");
    const codeBeforeImport = code.substring(0, importIdx);
    // There should be no __ct.step call between the enter and the import
    const enterIdx = codeBeforeImport.indexOf("__ct.enter(");
    const stepsBeforeImport = codeBeforeImport
      .substring(enterIdx)
      .match(/__ct\.step/g);
    expect(stepsBeforeImport).toBeNull();
  });

  it("handles object methods (method shorthand)", () => {
    const result = inst(`
const obj = {
  greet(name) {
    return "Hi " + name;
  }
};
`);
    const code = result.code;
    const m = result.manifestSlice;

    // Should have a function entry for "greet"
    const fnNames = m.functions.map((f) => f.name);
    expect(fnNames).toContain("greet");
  });
});

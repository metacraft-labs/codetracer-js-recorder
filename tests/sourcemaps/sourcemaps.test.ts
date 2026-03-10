import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { instrument } from "@codetracer/instrumenter";
import { transformSync } from "@swc/core";
import type { ManifestSlice } from "@codetracer/instrumenter";

// Resolve paths relative to the project root
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const CLI_PATH = path.join(PROJECT_ROOT, "packages/cli/dist/index.js");

/**
 * Helper to run the CLI as a child process.
 */
function runCLI(
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string> },
): { stdout: string; stderr: string } {
  try {
    const result = execFileSync(process.execPath, [CLI_PATH, ...args], {
      cwd: opts?.cwd ?? PROJECT_ROOT,
      env: { ...process.env, ...opts?.env },
      encoding: "utf-8",
      timeout: 30000,
    });
    return { stdout: result, stderr: "" };
  } catch (err: unknown) {
    const execErr = err as {
      stdout?: string;
      stderr?: string;
      status?: number;
    };
    return {
      stdout: execErr.stdout ?? "",
      stderr: execErr.stderr ?? "",
    };
  }
}

/**
 * Create a simple source map JSON mapping generated-JS to an original TS file.
 *
 * The mapping structure:
 * - Original file: `origFile` (e.g., "src/main.ts")
 * - Generated file: `genFile` (e.g., "dist/main.js")
 * - lineMapping: array of [genLine, origLine] pairs (1-based)
 *
 * We build a simple source map that maps each generated line to the
 * corresponding original line at column 0.
 */
function createSimpleSourceMap(opts: {
  origFile: string;
  genFile?: string;
  lineMapping: [number, number][]; // [genLine (1-based), origLine (1-based)]
  sourcesContent?: string;
}): string {
  // Use @jridgewell/gen-mapping to build a proper source map
  const {
    GenMapping,
    toEncodedMap,
    addMapping,
    setSourceContent,
  } = require("@jridgewell/gen-mapping");

  const gen = new GenMapping({ file: opts.genFile });

  for (const [genLine, origLine] of opts.lineMapping) {
    addMapping(gen, {
      generated: { line: genLine, column: 0 },
      source: opts.origFile,
      original: { line: origLine, column: 0 },
    });
  }

  if (opts.sourcesContent) {
    setSourceContent(gen, opts.origFile, opts.sourcesContent);
  }

  return JSON.stringify(toEncodedMap(gen));
}

/**
 * Encode a source map as an inline data URL comment.
 */
function inlineSourceMapComment(sourceMapJson: string): string {
  const base64 = Buffer.from(sourceMapJson).toString("base64");
  return `//# sourceMappingURL=data:application/json;base64,${base64}`;
}

// =============================================
// test_sourcemap_inline_resolution
// =============================================
describe("test_sourcemap_inline_resolution", () => {
  it("resolves inline source map to original TS file paths and line numbers", () => {
    // Original TypeScript source (fictional — not on disk)
    const originalTs = `// src/main.ts
interface Config {
  name: string;
  value: number;
}

function greet(config: Config): string {
  return "Hello, " + config.name;
}

const result = greet({ name: "World", value: 42 });
console.log(result);
`;

    // "Compiled" JS output (what tsc might produce, simplified)
    // Line mapping (1-based):
    //   generated line 1 -> original line 7  (function greet)
    //   generated line 2 -> original line 8  (return statement)
    //   generated line 3 -> original line 8  (closing brace)
    //   generated line 4 -> original line 11 (const result)
    //   generated line 5 -> original line 12 (console.log)
    const generatedJs = `function greet(config) {
  return "Hello, " + config.name;
}
const result = greet({ name: "World", value: 42 });
console.log(result);
`;

    const sourceMap = createSimpleSourceMap({
      origFile: "src/main.ts",
      lineMapping: [
        [1, 7],
        [2, 8],
        [3, 9],
        [4, 11],
        [5, 12],
      ],
      sourcesContent: originalTs,
    });

    const codeWithInlineMap =
      generatedJs + "\n" + inlineSourceMapComment(sourceMap);

    const result = instrument(codeWithInlineMap, {
      filename: "dist/main.js",
    });

    const m = result.manifestSlice;

    // The manifest should reference the original TS file, not the generated JS
    expect(m.paths).toContain("src/main.ts");

    // The "greet" function should be registered with original line numbers
    const greetFn = m.functions.find((f) => f.name === "greet");
    expect(greetFn).toBeDefined();

    // greet's pathIndex should point to the original TS file
    const tsPathIndex = m.paths.indexOf("src/main.ts");
    expect(tsPathIndex).toBeGreaterThanOrEqual(0);
    expect(greetFn!.pathIndex).toBe(tsPathIndex);

    // greet's line should be the original line (7), not the generated line (1)
    expect(greetFn!.line).toBe(7);

    // Sites should also reference original lines
    const stepSites = m.sites.filter((s) => s.kind === "step");
    const sitesForTs = stepSites.filter((s) => s.pathIndex === tsPathIndex);
    expect(sitesForTs.length).toBeGreaterThan(0);

    // At least one site should have an original line >= 7
    const hasOriginalLines = sitesForTs.some((s) => s.line >= 7);
    expect(hasOriginalLines).toBe(true);
  });

  it("falls back to generated path when source map resolution fails", () => {
    // Code without any source map
    const code = `function hello() { return 42; }`;

    const result = instrument(code, { filename: "test.js" });
    const m = result.manifestSlice;

    // Should use the generated file path
    expect(m.paths).toContain("test.js");
    expect(m.paths).not.toContain("src/main.ts");
  });
});

// =============================================
// test_sourcemap_external_resolution
// =============================================
describe("test_sourcemap_external_resolution", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-sm-external-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves external .map file to original source paths", () => {
    const originalTs = `// Original TypeScript
function add(a: number, b: number): number {
  return a + b;
}
export default add;
`;

    const generatedJs = `function add(a, b) {
  return a + b;
}
export default add;
`;

    const sourceMap = createSimpleSourceMap({
      origFile: "src/math.ts",
      genFile: "dist/math.js",
      lineMapping: [
        [1, 2],
        [2, 3],
        [3, 4],
        [4, 5],
      ],
      sourcesContent: originalTs,
    });

    // Write the generated JS and .map file to disk
    const jsPath = path.join(tmpDir, "math.js");
    const mapPath = path.join(tmpDir, "math.js.map");

    const jsWithRef = generatedJs + `\n//# sourceMappingURL=math.js.map\n`;

    fs.writeFileSync(jsPath, jsWithRef);
    fs.writeFileSync(mapPath, sourceMap);

    // Instrument with the path pointing to the actual file
    const code = fs.readFileSync(jsPath, "utf-8");
    const result = instrument(code, { filename: jsPath });
    const m = result.manifestSlice;

    // Should reference the original TS file
    expect(m.paths).toContain("src/math.ts");

    // The "add" function should reference the original TS
    const addFn = m.functions.find((f) => f.name === "add");
    expect(addFn).toBeDefined();

    const tsPathIndex = m.paths.indexOf("src/math.ts");
    expect(addFn!.pathIndex).toBe(tsPathIndex);
    // Original line for `function add` is line 2
    expect(addFn!.line).toBe(2);
  });

  it("includes sourcesContent in the manifest", () => {
    const originalTs = `const x: number = 42;\nconsole.log(x);\n`;

    const generatedJs = `const x = 42;\nconsole.log(x);\n`;

    const sourceMap = createSimpleSourceMap({
      origFile: "src/simple.ts",
      lineMapping: [
        [1, 1],
        [2, 2],
      ],
      sourcesContent: originalTs,
    });

    const codeWithInlineMap =
      generatedJs + "\n" + inlineSourceMapComment(sourceMap);

    const result = instrument(codeWithInlineMap, {
      filename: "dist/simple.js",
    });
    const m = result.manifestSlice;

    // sourcesContent should be populated
    expect(m.sourcesContent).toBeDefined();
    expect(m.sourcesContent!["src/simple.ts"]).toBe(originalTs);
  });
});

// =============================================
// test_explicit_source_map_option
// =============================================
describe("test_explicit_source_map_option", () => {
  it("uses explicitly provided source map via options", () => {
    const generatedJs = `function multiply(a, b) {
  return a * b;
}
`;

    const sourceMap = createSimpleSourceMap({
      origFile: "src/multiply.ts",
      lineMapping: [
        [1, 5],
        [2, 6],
        [3, 7],
      ],
    });

    const result = instrument(generatedJs, {
      filename: "dist/multiply.js",
      inputSourceMap: sourceMap,
    });
    const m = result.manifestSlice;

    expect(m.paths).toContain("src/multiply.ts");

    const mulFn = m.functions.find((f) => f.name === "multiply");
    expect(mulFn).toBeDefined();

    const tsPathIndex = m.paths.indexOf("src/multiply.ts");
    expect(mulFn!.pathIndex).toBe(tsPathIndex);
    expect(mulFn!.line).toBe(5);
  });
});

// =============================================
// e2e_typescript_trace
// =============================================
describe("e2e_typescript_trace", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-sm-ts-e2e-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("compiles TypeScript with SWC, instruments with source map, and verifies trace references .ts file", () => {
    // Write a small TypeScript file
    const tsSource = `// A simple TypeScript program
interface Greeting {
  message: string;
  count: number;
}

function createGreeting(name: string, count: number): Greeting {
  return {
    message: "Hello, " + name,
    count: count,
  };
}

const greeting: Greeting = createGreeting("World", 3);
console.log(greeting.message);
`;

    const tsFile = path.join(tmpDir, "src", "hello.ts");
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(tsFile, tsSource);

    // Compile with @swc/core transformSync
    const swcResult = transformSync(tsSource, {
      filename: tsFile,
      sourceMaps: true,
      jsc: {
        parser: { syntax: "typescript" },
        target: "es2022",
      },
    });

    expect(swcResult.code).toBeDefined();
    expect(swcResult.map).toBeDefined();

    // Write the compiled JS with inline source map
    const distDir = path.join(tmpDir, "dist");
    fs.mkdirSync(distDir, { recursive: true });
    const jsFile = path.join(distDir, "hello.js");

    // Write JS with inline source map
    const base64Map = Buffer.from(swcResult.map!).toString("base64");
    const jsWithMap =
      swcResult.code +
      `\n//# sourceMappingURL=data:application/json;base64,${base64Map}\n`;
    fs.writeFileSync(jsFile, jsWithMap);

    // Instrument the generated JS
    const jsCode = fs.readFileSync(jsFile, "utf-8");
    const instResult = instrument(jsCode, { filename: jsFile });
    const m = instResult.manifestSlice;

    // The manifest should reference the original .ts file
    // SWC may use the absolute path from the filename option
    const tsPathInManifest = m.paths.find(
      (p) => p.endsWith("hello.ts") || p.includes("hello.ts"),
    );
    expect(tsPathInManifest).toBeDefined();

    // The createGreeting function should be present
    const createGreetingFn = m.functions.find(
      (f) => f.name === "createGreeting",
    );
    expect(createGreetingFn).toBeDefined();

    // Its pathIndex should point to the TS file
    const tsPathIndex = m.paths.indexOf(tsPathInManifest!);
    expect(createGreetingFn!.pathIndex).toBe(tsPathIndex);

    // Its line should be from the original TS source (line 7)
    expect(createGreetingFn!.line).toBe(7);

    // Verify the instrumented code still works with a no-op __ct
    const wrappedCode = `
      const __ct = {
        step: function(_siteId) {},
        enter: function(_fnId, _args) {},
        ret: function(_fnId, value) { return value; },
      };
      ${instResult.code}
    `;
    // Should not throw
    const fn = new Function(wrappedCode);
    expect(() => fn()).not.toThrow();
  });
});

// =============================================
// test_sources_content_in_files
// =============================================
describe("test_sources_content_in_files", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-sm-files-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("manifest sourcesContent is preserved through merge", () => {
    const originalTs = `function hello(): string { return "world"; }\n`;
    const generatedJs = `function hello() { return "world"; }\n`;

    const sourceMap = createSimpleSourceMap({
      origFile: "src/hello.ts",
      lineMapping: [[1, 1]],
      sourcesContent: originalTs,
    });

    const codeWithMap = generatedJs + "\n" + inlineSourceMapComment(sourceMap);

    const result = instrument(codeWithMap, {
      filename: "dist/hello.js",
    });
    const m = result.manifestSlice;

    // Verify sourcesContent is in the manifest slice
    expect(m.sourcesContent).toBeDefined();
    expect(m.sourcesContent!["src/hello.ts"]).toBe(originalTs);

    // Build a full manifest like the CLI does
    const manifest = {
      formatVersion: 1,
      paths: m.paths,
      functions: m.functions,
      sites: m.sites,
      sourcesContent: m.sourcesContent,
    };

    const manifestJson = JSON.stringify(manifest, null, 2);
    const parsed = JSON.parse(manifestJson);

    // The serialized manifest should have sourcesContent
    expect(parsed.sourcesContent).toBeDefined();
    expect(parsed.sourcesContent["src/hello.ts"]).toBe(originalTs);
  });
});

// =============================================
// test_chained_source_map
// =============================================
describe("test_chained_source_map", () => {
  it("produces a chained source map from instrumented code through to original source", () => {
    const originalTs = `function add(a: number, b: number): number {
  return a + b;
}
`;
    const generatedJs = `function add(a, b) {
  return a + b;
}
`;

    const sourceMap = createSimpleSourceMap({
      origFile: "src/add.ts",
      lineMapping: [
        [1, 1],
        [2, 2],
        [3, 3],
      ],
      sourcesContent: originalTs,
    });

    const codeWithMap = generatedJs + "\n" + inlineSourceMapComment(sourceMap);

    const result = instrument(codeWithMap, { filename: "dist/add.js" });

    // Should produce a source map
    expect(result.map).toBeDefined();

    // The source map should be valid JSON
    const mapParsed = JSON.parse(result.map!);
    expect(mapParsed.version).toBe(3);

    // The chained source map should reference the original TS file
    expect(mapParsed.sources).toContain("src/add.ts");

    // If sourcesContent is available, it should be carried through
    if (mapParsed.sourcesContent) {
      const tsIndex = mapParsed.sources.indexOf("src/add.ts");
      expect(mapParsed.sourcesContent[tsIndex]).toBe(originalTs);
    }
  });

  it("output source map references original source without input map", () => {
    // When there is no input source map, the output map should reference
    // the generated file itself
    const code = `function foo() { return 1; }\n`;
    const result = instrument(code, { filename: "test.js" });

    expect(result.map).toBeDefined();
    const mapParsed = JSON.parse(result.map!);
    expect(mapParsed.version).toBe(3);
  });
});

// =============================================
// test_no_sourcemap_unchanged_behavior
// =============================================
describe("test_no_sourcemap_unchanged_behavior", () => {
  it("behaves identically to pre-sourcemap code when no source map present", () => {
    const code = `
function factorial(n) {
  if (n <= 1) return 1;
  return n * factorial(n - 1);
}
const result = factorial(5);
`;

    const result = instrument(code, { filename: "test.js" });
    const m = result.manifestSlice;

    // Should only have the generated file path
    expect(m.paths).toEqual(["test.js"]);

    // Should NOT have sourcesContent
    expect(m.sourcesContent).toBeUndefined();

    // All functions should reference pathIndex 0
    for (const fn of m.functions) {
      expect(fn.pathIndex).toBe(0);
    }

    // All sites should reference pathIndex 0
    for (const site of m.sites) {
      expect(site.pathIndex).toBe(0);
    }
  });
});

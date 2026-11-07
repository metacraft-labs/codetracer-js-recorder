/**
 * Post-bundle instrumentation must leave a bundle's behaviour unchanged
 * apart from the `__ct` calls (spec/CLI/recorders/js.md `instrument`: the
 * output is a drop-in replacement for the input; JS-Boundary-Recording.md
 * §8: replay runs the instrumented copy of the deployed bundle).
 *
 * The bundles are made by the real bundlers (esbuild, rollup, webpack: root
 * devDependencies) from one small program that exercises the shapes their
 * runtimes emit: an ES module importing a CommonJS module (esbuild's
 * `__commonJS`/`__toESM`, webpack's `__webpack_require__`), TypeScript's
 * CommonJS output re-exporting with `__exportStar`/`__createBinding`
 * (compiled by the real `typescript`), a namespace import, and comma
 * expressions in returns and arrow bodies; and each bundler's minified
 * output too, where comma expressions are everywhere. Every bundle is
 * instrumented the way replay instruments a deployed bundle
 * (`instrumentTree`, the `instrument` command's own code, with
 * `--relative-paths`), and the original and the instrumented copy are run
 * in a Node `vm` context; their results must be equal.
 *
 * One test double, and why: `__ct` is a no-op object whose `ret` returns its
 * value. What is under test is the transform's semantics, which a recording
 * runtime would only obscure (it observes values; it must not change them).
 *
 * Negative control: the program's own result is asserted to be the expected
 * literal, so a bundle that does nothing cannot pass by agreeing with an
 * instrumented copy that does nothing. The transform defect this guards
 * (`__ct.ret(id, a, b)` for `return a, b`) turned the esbuild and minified
 * bundles red here.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import { createRequire } from "node:module";

import { instrumentTree } from "../../packages/cli/src/instrument-cmd.js";

const requireFromHere = createRequire(__filename);
const esbuild = requireFromHere("esbuild") as typeof import("esbuild");
const { rollup } = requireFromHere("rollup") as typeof import("rollup");
const webpack = requireFromHere("webpack") as typeof import("webpack");
const ts = requireFromHere("typescript") as typeof import("typescript");

/** CommonJS, with comma expressions in its returns. */
const UTIL_CJS = `
let calls = 0;
module.exports = function counter(step) {
  return calls += step, calls;
};
module.exports.reset = () => (calls = 0, calls);
`;

/** TypeScript, compiled to CommonJS: `export *` becomes `__exportStar`. */
const LIB_TS = `
export * from "./inner";
export const CONST = { event: { load: 5 } };
`;
const INNER_TS = `
export function inner(n: number): number {
  let r = 0;
  for (let i = 0; i < n; i++) r += i;
  return r;
}
export const INNER = "inner";
`;

/** Plain ES modules, for the bundlers that need no CommonJS support. */
const ESM_HELPERS = `
export function pick(xs) {
  let i = 0;
  return i = xs.length - 1, xs[i];
}
export const twice = (f, x) => (x = f(x), f(x));
export default function label(s) {
  return "<" + s + ">";
}
`;

const ESM_MAIN = `
import label, { pick, twice } from "./helpers.mjs";
import * as ns from "./helpers.mjs";
const out = [];
out.push(pick([1, 2, 3]), twice((v) => v * 3, 2), label("x"));
out.push(Object.keys(ns).sort().join(","));
out.push(ns.pick(["a", "b"]));
globalThis.__result = JSON.stringify(out);
`;

/** The full program: ESM importing CommonJS and TypeScript's CommonJS. */
const MAIN = `
import counter from "./util.cjs";
import * as lib from "./lib.js";
import { pick, twice } from "./helpers.mjs";
const out = [];
out.push(counter(2), counter(3), counter.reset());
out.push(lib.inner(4), lib.CONST.event.load, lib.INNER);
// Bundlers differ on whether a CommonJS namespace has a \`default\`.
out.push(Object.keys(lib).filter((k) => k !== "default").sort().join(","));
out.push(pick([1, 2, 3]), twice((v) => v + 1, 1));
globalThis.__result = JSON.stringify(out);
`;

const MAIN_EXPECTED = JSON.stringify([
  2,
  5,
  0,
  6,
  5,
  "inner",
  "CONST,INNER,inner",
  3,
  3,
]);
const ESM_EXPECTED = JSON.stringify([3, 18, "<x>", "default,pick,twice", "b"]);

let dir: string;
let src: string;
/** Bundle file (relative to `bundles/`) to the result its program must give. */
const bundles = new Map<string, string>();

function write(rel: string, content: string): void {
  const p = path.join(src, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function compileTs(source: string): string {
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
}

async function runWebpack(
  entry: string,
  outFile: string,
  mode: "development" | "production",
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    webpack(
      {
        mode,
        devtool: false,
        target: "web",
        context: src,
        entry,
        output: {
          path: path.dirname(outFile),
          filename: path.basename(outFile),
        },
      },
      (err, stats) => {
        if (err) return reject(err);
        if (stats?.hasErrors()) {
          return reject(new Error(stats.toString("errors-only")));
        }
        resolve();
      },
    );
  });
}

/** Run a bundle in a fresh context and return what it left in `__result`. */
function run(code: string, withCt: boolean): string {
  const sandbox: Record<string, unknown> = {
    module: { exports: {} },
    exports: {},
    require: () => {
      throw new Error("a bundle must not require at run time");
    },
  };
  if (withCt) {
    sandbox.__ct = {
      enter() {},
      step() {},
      write() {},
      ret(_id: number, value?: unknown) {
        return value;
      },
    };
  }
  const context = vm.createContext(sandbox);
  vm.runInContext(code, context, { timeout: 10_000 });
  return String(vm.runInContext("globalThis.__result", context));
}

beforeAll(async () => {
  dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ct-post-bundle-semantics-")),
  );
  src = path.join(dir, "src");
  write("util.cjs", UTIL_CJS);
  write("lib.js", compileTs(LIB_TS));
  write("inner.js", compileTs(INNER_TS));
  write("helpers.mjs", ESM_HELPERS);
  write("main.mjs", MAIN);
  write("esm-main.mjs", ESM_MAIN);
  // The compiled library must be the shape the defect was found in.
  expect(fs.readFileSync(path.join(src, "lib.js"), "utf-8")).toContain(
    "__exportStar",
  );

  const out = path.join(dir, "bundles");
  for (const format of ["iife", "cjs", "esm"] as const) {
    for (const minify of [false, true]) {
      const rel = `esbuild-${format}${minify ? "-min" : ""}.js`;
      await esbuild.build({
        entryPoints: [path.join(src, "main.mjs")],
        outfile: path.join(out, rel),
        bundle: true,
        format,
        minify,
        platform: "browser",
        target: "es2020",
        logLevel: "warning",
      });
      bundles.set(rel, MAIN_EXPECTED);
    }
  }
  for (const mode of ["development", "production"] as const) {
    const rel = `webpack-${mode}.js`;
    await runWebpack("./main.mjs", path.join(out, rel), mode);
    bundles.set(rel, MAIN_EXPECTED);
  }
  const rolled = await rollup({ input: path.join(src, "esm-main.mjs") });
  for (const format of ["iife", "es"] as const) {
    const rel = `rollup-${format}.js`;
    await rolled.write({ file: path.join(out, rel), format });
    bundles.set(rel, ESM_EXPECTED);
  }
  await rolled.close();
}, 120_000);

afterAll(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe("post-bundle instrumentation keeps a bundle's behaviour", () => {
  it("instrumented_bundles_of_esbuild_rollup_and_webpack_behave_as_the_originals", () => {
    const original = path.join(dir, "bundles");
    const instrumented = path.join(dir, "instrumented");
    const result = instrumentTree({
      src: original,
      outDir: instrumented,
      relativePaths: true,
    });
    expect(result.failures).toEqual([]);

    expect(bundles.size).toBe(10);
    const outcomes: Record<string, { original: string; instrumented: string }> =
      {};
    for (const [rel, expected] of bundles) {
      const before = run(
        fs.readFileSync(path.join(original, rel), "utf-8"),
        false,
      );
      expect(before, `${rel} as bundled`).toBe(expected);
      const code = fs.readFileSync(path.join(instrumented, rel), "utf-8");
      // The copy is instrumented, not passed through.
      expect(code, rel).toContain("__ct.ret(");
      let after: string;
      try {
        after = run(code, true);
      } catch (e) {
        after = `threw: ${(e as Error).message}`;
      }
      outcomes[rel] = { original: before, instrumented: after };
    }
    // One comparison over every bundle, so a failure names all of them.
    const results = (k: "original" | "instrumented") =>
      Object.fromEntries(Object.entries(outcomes).map(([r, o]) => [r, o[k]]));
    expect(results("instrumented")).toEqual(results("original"));
  });
});

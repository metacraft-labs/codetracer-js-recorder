/**
 * The dynamic `import()` seam's rewrite (CodeTracer's JS-Boundary-Recording
 * specification §6, §8.1, §10.1; `packages/boundary-shim/src/import-seam.ts`):
 * every call of the bundle, and only calls, becomes a call of the shim's
 * seam with the `import()` kept in the page's own module; the rewrite is
 * exactly undone for the build hash; a script whose calls the parser cannot
 * find is refused, naming it; a chunk's source map follows the edits. The
 * rewrite changes the page's own code, so the deploy step makes it only when
 * asked (`boundary-shim --import-seam`, the vite plugin's `importSeam`), and
 * by default leaves every script as it was.
 *
 * The parser is SWC's, the CLI step the shipped one, and the vite build a
 * real one; no mocks.
 */

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";

import {
  IMPORT_SEAM_CALLEE,
  IMPORT_SEAM_LOAD_1,
  IMPORT_SEAM_LOAD_2,
} from "../../packages/boundary-shim/src/browser/config.js";
import {
  ImportSeamError,
  buildBundleManifest,
  rewriteDynamicImports,
  rewriteHtmlImports,
  stripImportSeam,
} from "../../packages/boundary-shim/src/index.js";
import { codetracerBoundaryShimPlugin } from "../../packages/vite-plugin/src/index.js";

const CLI = path.resolve(__dirname, "..", "..", "packages/cli/dist/index.js");
const tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

const seam1 = (arg: string) =>
  `${IMPORT_SEAM_CALLEE}(${IMPORT_SEAM_LOAD_1}${arg})`;

describe("the dynamic import() seam", () => {
  it("import_seam_rewrites_every_call_and_nothing_else", () => {
    const src = [
      `const a = import("./a.js");`,
      `const s = "import('./not.js')"; // import("./not.js")`,
      `/* import("./no.js") */ const r = /import\\(x\\)/;`,
      `const t = \`import("\${1}")\`;`,
      `f(import ( /*c*/ "./b.js" ), import("./c.json", { with: { type: "json" } }));`,
      `const m = import.meta.url;`,
    ].join("\n");
    const out = rewriteDynamicImports(src, "x.js");
    // The three calls, and nothing in a string, comment, regex or template.
    expect(out.split(IMPORT_SEAM_CALLEE).length - 1).toBe(3);
    expect(out).toContain(seam1(`"./a.js"`));
    // Whitespace and comments inside a call are kept.
    expect(out).toContain(
      `${IMPORT_SEAM_CALLEE} (${IMPORT_SEAM_LOAD_1} /*c*/ "./b.js" )`,
    );
    // A call with options keeps both arguments, one with none keeps one.
    expect(out).toContain(
      `${IMPORT_SEAM_CALLEE}(${IMPORT_SEAM_LOAD_2}"./c.json"`,
    );
    expect(out).toContain(`"import('./not.js')"`);
    expect(out).toContain(`import.meta.url`);
    // Exactly undone, and idempotent.
    expect(stripImportSeam(out)).toBe(src);
    expect(rewriteDynamicImports(out, "x.js")).toBe(out);
    // The rewritten code parses, and still has one import() per call.
    expect(
      rewriteDynamicImports(out, "x.js").match(/=>import\(/g)?.length,
    ).toBe(3);
  });

  it("import_seam_keeps_non_ascii_text_byte_exact", () => {
    const src = `const é = "ü"; import("./ö.js").then(() => "€");`;
    const out = rewriteDynamicImports(src, "u.js");
    expect(out).toBe(`const é = "ü"; ${seam1(`"./ö.js"`)}.then(() => "€");`);
    expect(stripImportSeam(out)).toBe(src);
  });

  it("import_seam_refuses_a_script_it_cannot_parse", () => {
    expect(() => rewriteDynamicImports("import( ;;; )", "bad.js")).toThrow(
      ImportSeamError,
    );
    expect(() => rewriteDynamicImports("import( ;;; )", "bad.js")).toThrow(
      /bad\.js/,
    );
  });

  it("import_seam_rewrites_inline_scripts_of_a_page_only", () => {
    const html = [
      `<script>import("./a.js")</script>`,
      `<script type="module">await import("./b.js")</script>`,
      `<script type="importmap">{"imports":{"import(":"x"}}</script>`,
      `<script type="application/json">{"a":"import(1)"}</script>`,
      `<script src="c.js">import("./ignored.js")</script>`,
      `<p>import("./text.js")</p>`,
    ].join("\n");
    const out = rewriteHtmlImports(html, "p.html");
    expect(out.split(IMPORT_SEAM_CALLEE).length - 1).toBe(2);
    expect(out).toContain(`{"imports":{"import(":"x"}}`);
    expect(out).toContain(`<p>import("./text.js")</p>`);
    expect(stripImportSeam(out)).toBe(html);
  });

  it("import_seam_leaves_the_build_hash_unchanged_through_the_cli_step", () => {
    const dir = path.join(tmp("ct-seam-cli-"), "site");
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, "index.html"),
      `<!doctype html><html><head></head><body><script type="module">import("./m.js")</script></body></html>`,
    );
    fs.writeFileSync(path.join(dir, "app.js"), `import("./m.js").then(f);`);
    fs.writeFileSync(path.join(dir, "m.js"), `export default 1;`);
    const before = buildBundleManifest(dir).buildHash;
    execFileSync(
      process.execPath,
      [CLI, "boundary-shim", dir, "--build-hash", before, "--import-seam"],
      { encoding: "utf-8" },
    );
    expect(fs.readFileSync(path.join(dir, "app.js"), "utf-8")).toContain(
      IMPORT_SEAM_CALLEE,
    );
    expect(fs.readFileSync(path.join(dir, "index.html"), "utf-8")).toContain(
      IMPORT_SEAM_CALLEE,
    );
    expect(buildBundleManifest(dir).buildHash).toBe(before);

    // A script the parser cannot read is refused before any file changes.
    const bad = path.join(tmp("ct-seam-bad-"), "site");
    fs.mkdirSync(bad);
    fs.writeFileSync(
      path.join(bad, "index.html"),
      "<html><head></head></html>",
    );
    fs.writeFileSync(path.join(bad, "broken.js"), "import( ;;; )");
    const r = spawnSync(
      process.execPath,
      [CLI, "boundary-shim", bad, "--import-seam"],
      { encoding: "utf-8" },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("broken.js");
    expect(fs.readFileSync(path.join(bad, "index.html"), "utf-8")).toBe(
      "<html><head></head></html>",
    );
  });

  it("import_seam_is_off_unless_the_deploy_step_is_asked_for_it", async () => {
    const page = `<!doctype html><html><head></head><body><script type="module">import("./m.js")</script></body></html>`;
    const app = `import("./m.js").then(f);`;
    const dir = path.join(tmp("ct-seam-off-"), "site");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "index.html"), page);
    fs.writeFileSync(path.join(dir, "app.js"), app);
    // A script the parser cannot read: never read without the seam.
    fs.writeFileSync(path.join(dir, "broken.js"), "import( ;;; )");
    const out = execFileSync(process.execPath, [CLI, "boundary-shim", dir], {
      encoding: "utf-8",
    });
    expect(out).not.toContain("import seam:");
    expect(fs.readFileSync(path.join(dir, "app.js"), "utf-8")).toBe(app);
    expect(fs.readFileSync(path.join(dir, "broken.js"), "utf-8")).toBe(
      "import( ;;; )",
    );
    const installed = fs.readFileSync(path.join(dir, "index.html"), "utf-8");
    // Vacuity guard: the step ran and installed the bootstrap.
    expect(installed).toContain("data-codetracer-boundary-shim");
    expect(installed).not.toContain(IMPORT_SEAM_CALLEE);
    expect(installed).toContain(`<script type="module">import("./m.js")`);
    // The shim is not told to declare a seam the page does not have.
    expect(installed).not.toContain('"importSeam"');

    // Asked for, the same step installs it and tells the shim.
    fs.rmSync(path.join(dir, "broken.js"));
    execFileSync(process.execPath, [
      CLI,
      "boundary-shim",
      dir,
      "--import-seam",
    ]);
    const seamed = fs.readFileSync(path.join(dir, "index.html"), "utf-8");
    expect(seamed).toContain(IMPORT_SEAM_CALLEE);
    expect(seamed).toContain('"importSeam":true');
    expect(fs.readFileSync(path.join(dir, "app.js"), "utf-8")).toContain(
      IMPORT_SEAM_CALLEE,
    );

    // The vite plugin, by default, leaves the chunks as the build wrote them.
    const root = tmp("ct-seam-vite-off-");
    fs.writeFileSync(
      path.join(root, "index.html"),
      `<!doctype html><html><head></head><body><script type="module" src="./main.js"></script></body></html>`,
    );
    fs.writeFileSync(
      path.join(root, "main.js"),
      `import("./lazy.js").then((m) => { window.MARKER_AFTER_IMPORT = m.v; });\n`,
    );
    fs.writeFileSync(path.join(root, "lazy.js"), `export const v = 3;\n`);
    const outDir = path.join(root, "dist");
    const vite = createRequire(__filename)("vite") as typeof import("vite");
    await vite.build({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [codetracerBoundaryShimPlugin({ buildHash: "ab".repeat(32) })],
      build: { outDir, emptyOutDir: true, minify: false },
    });
    const chunks = fs
      .readdirSync(path.join(outDir, "assets"))
      .filter((f) => f.endsWith(".js"))
      .map((f) => fs.readFileSync(path.join(outDir, "assets", f), "utf-8"));
    const main = chunks.find((c) => c.includes("MARKER_AFTER_IMPORT"));
    expect(main).toBeDefined();
    expect(main).toMatch(/import\(/);
    expect(chunks.some((c) => c.includes(IMPORT_SEAM_CALLEE))).toBe(false);
    const html = fs.readFileSync(path.join(outDir, "index.html"), "utf-8");
    expect(html).toContain("data-codetracer-boundary-shim");
  });

  it("import_seam_in_a_vite_build_keeps_the_chunk_source_map_exact", async () => {
    const root = tmp("ct-seam-vite-");
    fs.writeFileSync(
      path.join(root, "index.html"),
      `<!doctype html><html><head></head><body><script type="module" src="./main.js"></script></body></html>`,
    );
    // One line, so the call and what follows it share a line of the chunk.
    fs.writeFileSync(
      path.join(root, "main.js"),
      `import("./lazy.js").then((m) => { window.MARKER_AFTER_IMPORT = m.v; });\n`,
    );
    fs.writeFileSync(path.join(root, "lazy.js"), `export const v = 3;\n`);
    const outDir = path.join(root, "dist");
    const vite = createRequire(__filename)("vite") as typeof import("vite");
    await vite.build({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [
        codetracerBoundaryShimPlugin({
          buildHash: "ab".repeat(32),
          importSeam: true,
        }),
      ],
      build: { outDir, emptyOutDir: true, sourcemap: true, minify: false },
    });
    const assets = path.join(outDir, "assets");
    const main = fs
      .readdirSync(assets)
      .find(
        (f) =>
          f.endsWith(".js") &&
          fs
            .readFileSync(path.join(assets, f), "utf-8")
            .includes("MARKER_AFTER_IMPORT"),
      )!;
    const code = fs.readFileSync(path.join(assets, main), "utf-8");
    expect(code).toContain(IMPORT_SEAM_CALLEE);
    const map = JSON.parse(
      fs.readFileSync(path.join(assets, `${main}.map`), "utf-8"),
    ) as { mappings: string; sources: string[] };
    // The `.then` after the call, on the line the seam lengthened, maps
    // back to its place in main.js.
    const { TraceMap, originalPositionFor } = createRequire(
      require.resolve("../../packages/instrumenter/package.json"),
    )(
      "@jridgewell/trace-mapping",
    ) as typeof import("@jridgewell/trace-mapping");
    const lines = code.split("\n");
    const line = lines.findIndex((l) => l.includes(IMPORT_SEAM_CALLEE));
    // Vacuity guard: the call and the code after it share the line.
    const column = lines[line].indexOf(".then(") + 1;
    expect(column).toBeGreaterThan(lines[line].indexOf(IMPORT_SEAM_CALLEE));
    const pos = originalPositionFor(new TraceMap(map as never), {
      line: line + 1,
      column,
    });
    expect(pos.source?.endsWith("main.js")).toBe(true);
    expect(pos.line).toBe(1);
    expect(pos.column).toBe(`import("./lazy.js").`.length);
  });
});

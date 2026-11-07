/**
 * The esbuild, rollup and webpack plugins number every module in the
 * merged manifest's id space and emit that manifest and a source map.
 *
 * Each bundler is the real one (esbuild, rollup and webpack, root
 * devDependencies), run in-process on a two-module fixture written to a
 * temporary directory; the bundle it writes is executed in a Node `vm`
 * context with the real browser runtime (`@codetracer/runtime-browser`)
 * installed as `__ct`. One test double, and why: the runtime's WebSocket
 * to the recording daemon is replaced by an in-memory transport that keeps
 * the events it is sent. What is under test is which source line each
 * reported id resolves to through the emitted manifest; the daemon only
 * stores those ids, and its own manifest decoding is codetracer's
 * (`browser_stream_host.rs`), tested there.
 *
 * Negative control: the pre-fix plugin (calling `instrument()` without
 * `idBases`, every module numbered from zero) is built the same way with
 * rollup, with the only manifest such a build can have (the slices
 * concatenated), and the same assertion attributes the second module's
 * step to the first module's file; so the assertion discriminates.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import { createRequire } from "node:module";

import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";

import {
  createBrowserRuntime,
  type BrowserEvent,
  type BrowserTransport,
} from "@codetracer/runtime-browser";
import {
  instrument,
  RECORDER_VERSION,
  type ManifestSlice,
  type MergedManifest,
} from "@codetracer/instrumenter-core";
import { codetracerEsbuildPlugin } from "@codetracer/esbuild-plugin";
import { codetracerRollupPlugin } from "@codetracer/rollup-plugin";
import { CodetracerWebpackPlugin } from "@codetracer/webpack-plugin";

const requireFromHere = createRequire(__filename);
const esbuild = requireFromHere("esbuild") as typeof import("esbuild");
const { rollup } = requireFromHere("rollup") as typeof import("rollup");
const webpack = requireFromHere("webpack") as typeof import("webpack");

const MAIN = [
  'import { second } from "./second.js";',
  "export function first(n) {",
  "  const doubled = n * 2;",
  "  return second(doubled);",
  "}",
  "globalThis.__result = first(3);",
  "",
].join("\n");

/** `second` runs with 6; line 2 is the step the test follows. */
const SECOND = [
  "export function second(value) {",
  "  const marker = value + 100;",
  "  return marker;",
  "}",
  "",
].join("\n");
const MARKER_LINE = 2;

let dir: string;
let mainPath: string;
let secondPath: string;

beforeAll(() => {
  dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ct-jbr-m5-plugins-")),
  );
  mainPath = path.join(dir, "src", "main.js");
  secondPath = path.join(dir, "src", "second.js");
  fs.mkdirSync(path.dirname(mainPath), { recursive: true });
  fs.writeFileSync(mainPath, MAIN);
  fs.writeFileSync(secondPath, SECOND);
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The in-memory stand-in for the daemon socket (see the header). */
class KeepingTransport implements BrowserTransport {
  readonly lines: string[] = [];
  readyState = 1;
  send(payload: string): void {
    for (const line of payload.split("\n")) {
      if (line.trim() !== "") this.lines.push(line);
    }
  }
  close(): void {}
  events(): BrowserEvent[] {
    return this.lines.map((l) => JSON.parse(l) as BrowserEvent);
  }
}

/** Run a bundle with the real browser runtime as `__ct`; return its events. */
function runBundle(code: string): BrowserEvent[] {
  const transport = new KeepingTransport();
  const runtime = createBrowserRuntime({
    transportFactory: () => transport,
    flushThreshold: 1,
    flushIntervalMs: 0,
    program: "jbr-m5-plugins",
    args: [],
  });
  const context: Record<string, unknown> = { __ct: runtime, console };
  context.self = context;
  context.window = context;
  vm.createContext(context);
  vm.runInContext(code, context);
  runtime.stop();
  expect(context.__result, "the bundle ran to completion").toBe(106);
  return transport.events();
}

type Step = Extract<BrowserEvent, { kind: "Step" }>;
type Call = Extract<BrowserEvent, { kind: "Call" }>;

/**
 * The events between the call of `second` (the only call whose argument
 * is 6) and its return, found from the runtime's event order alone, not
 * from the manifest under test.
 */
function secondsWindow(events: BrowserEvent[]): { call: Call; steps: Step[] } {
  const start = events.findIndex(
    (e) => e.kind === "Call" && (e as Call).args[0]?.value === 6,
  );
  expect(start, "the call of second(6) was recorded").toBeGreaterThanOrEqual(0);
  const steps: Step[] = [];
  let depth = 0;
  for (const e of events.slice(start + 1)) {
    if (e.kind === "Call") depth++;
    else if (e.kind === "Return") {
      if (depth === 0) break;
      depth--;
    } else if (e.kind === "Step" && depth === 0) steps.push(e as Step);
  }
  return { call: events[start] as Call, steps };
}

/** Where each of the window's steps resolves through `manifest`. */
function attribution(
  manifest: MergedManifest,
  steps: Step[],
): { path: string; line: number }[] {
  return steps.map((s) => {
    const site = manifest.sites[s.siteId];
    expect(site, `site ${s.siteId} is in the manifest`).toBeDefined();
    return { path: manifest.paths[site.pathIndex], line: site.line };
  });
}

/** Assert the step in the second module is attributed to it, and its call too. */
function expectSecondAttributedToItsModule(
  manifest: MergedManifest,
  events: BrowserEvent[],
): void {
  const { call, steps } = secondsWindow(events);
  // Vacuity guard: the window holds steps to attribute.
  expect(steps.length).toBeGreaterThan(0);
  const fn = manifest.functions[call.fnId];
  expect(fn?.name).toBe("second");
  expect(manifest.paths[fn.pathIndex]).toBe(secondPath);
  const where = attribution(manifest, steps);
  expect(where.map((w) => w.path)).toEqual(steps.map(() => secondPath));
  expect(where.map((w) => w.line)).toContain(MARKER_LINE);
}

/** Map the generated position of `value + 100` back through the bundle's map. */
function expectSourceMapReachesSecond(code: string, map: string): void {
  const offset = code.indexOf("value + 100");
  expect(
    offset,
    "the bundle holds the second module's statement",
  ).toBeGreaterThan(0);
  const before = code.slice(0, offset).split("\n");
  const line = before.length;
  const column = before[before.length - 1].length;
  const original = originalPositionFor(new TraceMap(map), { line, column });
  expect(original.source ?? "").toMatch(/second\.js$/);
  expect(original.line).toBe(MARKER_LINE);
}

function readManifest(file: string): MergedManifest & {
  recorderVersion?: string;
} {
  expect(fs.existsSync(file), `${file} was emitted`).toBe(true);
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

async function buildWithWebpack(outDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    webpack(
      {
        mode: "none",
        context: dir,
        entry: mainPath,
        target: "web",
        devtool: "source-map",
        output: { path: outDir, filename: "bundle.js" },
        plugins: [new CodetracerWebpackPlugin()],
      },
      (err, stats) => {
        if (err) return reject(err);
        if (stats?.hasErrors()) {
          return reject(
            new Error(stats.toString({ all: false, errors: true })),
          );
        }
        resolve();
      },
    );
  });
}

describe("bundler plugins", () => {
  it("bundler_plugins_emit_manifest_and_source_map", async () => {
    // esbuild
    const esOut = path.join(dir, "out-esbuild");
    await esbuild.build({
      entryPoints: [mainPath],
      bundle: true,
      format: "iife",
      outfile: path.join(esOut, "bundle.js"),
      sourcemap: true,
      logLevel: "silent",
      plugins: [
        codetracerEsbuildPlugin() as unknown as import("esbuild").Plugin,
      ],
    });

    // rollup
    const rollupOut = path.join(dir, "out-rollup");
    const rollupBuild = await rollup({
      input: mainPath,
      plugins: [codetracerRollupPlugin() as unknown as import("rollup").Plugin],
    });
    await rollupBuild.write({
      file: path.join(rollupOut, "bundle.js"),
      format: "iife",
      sourcemap: true,
    });
    await rollupBuild.close();

    // webpack
    const webpackOut = path.join(dir, "out-webpack");
    await buildWithWebpack(webpackOut);

    for (const out of [esOut, rollupOut, webpackOut]) {
      const code = fs.readFileSync(path.join(out, "bundle.js"), "utf-8");
      const map = fs.readFileSync(path.join(out, "bundle.js.map"), "utf-8");
      const manifest = readManifest(path.join(out, "codetracer.manifest.json"));
      expect(manifest.recorderVersion, out).toBe(RECORDER_VERSION);
      expect(manifest.paths, out).toEqual(
        expect.arrayContaining([mainPath, secondPath]),
      );
      expectSecondAttributedToItsModule(manifest, runBundle(code));
      expectSourceMapReachesSecond(code, map);
    }
  });

  it("a rebuild that reuses the bundler's module cache still emits the whole manifest", async () => {
    // Watch mode, and rollup's `cache` option, rebuild with the plugin
    // instance of the previous build and skip the transform of every
    // module whose source did not change. The manifest must still cover
    // those modules: their code carries the ids it was instrumented with.
    const rollupPlugin = codetracerRollupPlugin();
    const firstRollup = await rollup({
      input: mainPath,
      plugins: [rollupPlugin as unknown as import("rollup").Plugin],
    });
    const first = await firstRollup.generate({ format: "iife" });
    await firstRollup.close();
    const secondRollup = await rollup({
      input: mainPath,
      cache: firstRollup.cache,
      plugins: [rollupPlugin as unknown as import("rollup").Plugin],
    });
    const second = await secondRollup.generate({ format: "iife" });
    await secondRollup.close();
    const manifestAsset = (output: typeof second.output) => {
      const asset = output.find(
        (o) => o.fileName === "codetracer.manifest.json",
      );
      expect(asset, "the rebuild emitted the manifest").toBeDefined();
      return JSON.parse(String((asset as { source: unknown }).source));
    };
    expect(manifestAsset(second.output)).toEqual(manifestAsset(first.output));
    expectSecondAttributedToItsModule(
      manifestAsset(second.output),
      runBundle(second.output[0].code),
    );

    // webpack: the same compiler run twice keeps its modules in the
    // memory cache, as `watch` does.
    const out = path.join(dir, "out-webpack-cached");
    const compiler = webpack({
      mode: "none",
      cache: { type: "memory" },
      context: dir,
      entry: mainPath,
      target: "web",
      output: { path: out, filename: "bundle.js" },
      plugins: [new CodetracerWebpackPlugin()],
    });
    const run = () =>
      new Promise<void>((resolve, reject) => {
        compiler.run((err, stats) => {
          if (err) return reject(err);
          if (stats?.hasErrors()) {
            return reject(
              new Error(stats.toString({ all: false, errors: true })),
            );
          }
          resolve();
        });
      });
    const manifestFile = path.join(out, "codetracer.manifest.json");
    await run();
    const firstManifest = readManifest(manifestFile);
    fs.rmSync(manifestFile);
    await run();
    await new Promise<void>((resolve, reject) =>
      compiler.close((err) => (err ? reject(err) : resolve())),
    );
    const secondManifest = readManifest(manifestFile);
    expect(secondManifest).toEqual(firstManifest);
    expectSecondAttributedToItsModule(
      secondManifest,
      runBundle(fs.readFileSync(path.join(out, "bundle.js"), "utf-8")),
    );
  });

  it("the pre-fix plugin (no idBases) attributes the second module's step to the first", async () => {
    // Negative control for the test above: the plugin as it was, every
    // module numbered from zero, and the only manifest that build can
    // have, the slices concatenated in transform order.
    const slices: ManifestSlice[] = [];
    const prefix = {
      name: "codetracer:instrument-without-id-bases",
      transform(code: string, id: string) {
        const result = instrument(code, { filename: id });
        slices.push(result.manifestSlice);
        return { code: result.code, map: result.map };
      },
    };
    const build = await rollup({ input: mainPath, plugins: [prefix] });
    const { output } = await build.generate({ format: "iife" });
    await build.close();
    const concatenated: MergedManifest = {
      paths: [],
      functions: [],
      sites: [],
    };
    for (const slice of slices) {
      const remap = slice.paths.map((p) => {
        const known = concatenated.paths.indexOf(p);
        if (known >= 0) return known;
        concatenated.paths.push(p);
        return concatenated.paths.length - 1;
      });
      for (const f of slice.functions) {
        concatenated.functions.push({ ...f, pathIndex: remap[f.pathIndex] });
      }
      for (const s of slice.sites) {
        concatenated.sites.push({ ...s, pathIndex: remap[s.pathIndex] });
      }
    }
    // Vacuity guard: both modules were instrumented.
    expect(concatenated.paths).toEqual([mainPath, secondPath]);

    const { steps } = secondsWindow(runBundle(output[0].code));
    expect(steps.length).toBeGreaterThan(0);
    const where = attribution(concatenated, steps);
    // The same assertion as above fails: the steps land in main.js.
    expect(where.map((w) => w.path)).not.toEqual(steps.map(() => secondPath));
    expect(where.every((w) => w.path === mainPath)).toBe(true);
  });
});

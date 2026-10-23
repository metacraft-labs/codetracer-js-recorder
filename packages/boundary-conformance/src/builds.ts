/**
 * The suite's own builds of its fixtures (CodeTracer's
 * JS-Boundary-Recording specification §9.9):
 *
 * - the **generic build** ({@link buildGenericFixtures}): plain pages with
 *   no framework, for the generic shim at level 0. A deploy installs the
 *   shim into it exactly as into any site (`codetracer-js-recorder
 *   bundle-manifest`, then `boundary-shim --build-hash`);
 * - the **reference build** ({@link buildReferenceFixtures}): the same
 *   pages on the test-only reference micro-framework, at level 1, with
 *   optional seeded defects that make it one of the broken frameworks the
 *   suite must reject.
 *
 * A build directory holds `/<fixture>/index.html` (and, for level 1,
 * `/<fixture>/perturbed.html`) for every fixture, which is what
 * `ct-boundary-conformance record --build <dir>` runs.
 */

import * as esbuild from "esbuild";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  buildBundleManifest,
  injectBoundaryShim,
  writeBundleManifest,
} from "@codetracer/boundary-shim";

import {
  bodyMarkup,
  DEFERRED_HYDRATION,
  page,
  PAGE_FIXTURES,
  PERTURBATION,
} from "./pages.js";
import type { ReferenceDefects } from "./reference/microfw.js";

export type { ReferenceDefects };

/** The package's TypeScript sources (the same from `src/` and `dist/`). */
const SRC = path.resolve(__dirname, "..", "src");

/**
 * The generic page's pre-hydration queue: clicks before the page hydrates
 * are kept in `__fxQueue` for the app to replay (`generic/apps/prehydration.ts`).
 * It does not look at `isTrusted`: at level 0 the replay injects input as
 * synthetic events (§10.3), and a page that told them apart would behave
 * differently on replay, which is the level-0 limitation the fixture is not
 * about.
 */
const GENERIC_QUEUE_SCRIPT =
  "<script>window.__fxQueue=[];window.__fxHydrated=false;" +
  "document.addEventListener('click',function(e){" +
  "if(!window.__fxHydrated)window.__fxQueue.push(e)},true);</script>";

async function bundle(
  entry: string,
  outfile: string,
  define: Record<string, string> = {},
): Promise<void> {
  await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2020",
    define,
    logLevel: "warning",
    legalComments: "none",
    charset: "utf8",
  });
}

function prepare(outDir: string): void {
  fs.mkdirSync(outDir, { recursive: true });
  if (fs.readdirSync(outDir).length > 0) {
    throw new Error(`${outDir} is not empty`);
  }
}

/** Write the generic build of every fixture into the empty `outDir`. */
export async function buildGenericFixtures(outDir: string): Promise<void> {
  prepare(outDir);
  for (const name of PAGE_FIXTURES) {
    const dir = path.join(outDir, name);
    fs.mkdirSync(dir);
    await bundle(
      path.join(SRC, "generic", "apps", `${name}.ts`),
      path.join(dir, "app.js"),
    );
    const head = DEFERRED_HYDRATION.has(name) ? GENERIC_QUEUE_SCRIPT : "";
    fs.writeFileSync(
      path.join(dir, "index.html"),
      page({
        title: name,
        head,
        body:
          bodyMarkup(name, { iids: false }) + `<script src="app.js"></script>`,
      }),
    );
  }
}

/** What {@link buildReferenceFixtures} built. */
export interface ReferenceBuild {
  /** The build hash (the bundle manifest's), embedded in every page. */
  buildHash: string;
}

/**
 * Write the reference framework's build of every fixture into the empty
 * `outDir`, with `defects` seeded. Each page loads `/microfw.js` first in
 * `<head>` and its app last in `<body>`; the perturbed twin inserts one
 * unrelated element before the fixture's content. The build hash reaches
 * the framework through the configuration element `<script
 * data-codetracer-boundary-shim>` that the build hash does not cover
 * (§8.1), inserted by the shim's own injector with no shim bundle in it.
 */
export async function buildReferenceFixtures(
  outDir: string,
  defects: ReferenceDefects = {},
): Promise<ReferenceBuild> {
  prepare(outDir);
  await bundle(
    path.join(SRC, "reference", "microfw.ts"),
    path.join(outDir, "microfw.js"),
    { __CT_REF_DEFECTS__: JSON.stringify(defects) },
  );
  const pages: string[] = [];
  for (const name of PAGE_FIXTURES) {
    const dir = path.join(outDir, name);
    fs.mkdirSync(dir);
    await bundle(
      path.join(SRC, "reference", "apps", `${name}.ts`),
      path.join(dir, "app.js"),
    );
    const htmlAttributes = DEFERRED_HYDRATION.has(name)
      ? `data-ref-hydration="deferred"`
      : undefined;
    const body =
      bodyMarkup(name, { iids: true }) + `<script src="app.js"></script>`;
    for (const [file, content] of [
      ["index.html", body],
      ["perturbed.html", PERTURBATION + body],
    ] as const) {
      const p = path.join(dir, file);
      fs.writeFileSync(
        p,
        page({
          title: name,
          head: `<script src="/microfw.js"></script>`,
          body: content,
          htmlAttributes,
        }),
      );
      pages.push(p);
    }
  }
  const { buildHash } = buildBundleManifest(outDir);
  for (const p of pages) {
    const html = fs.readFileSync(p, "utf-8");
    fs.writeFileSync(
      p,
      injectBoundaryShim(html, { buildHash }, { bundleSource: "" }),
    );
  }
  const written = writeBundleManifest(outDir);
  if (written.buildHash !== buildHash) {
    throw new Error(
      "embedding the build hash changed it: the configuration element is not excluded from the hash",
    );
  }
  return { buildHash };
}

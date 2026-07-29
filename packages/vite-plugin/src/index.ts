/**
 * `@codetracer/vite-plugin` — wires the CodeTracer SWC instrumenter into
 * the Vite transform pipeline.
 *
 * The plugin is a thin Vite-shaped wrapper around
 * `@codetracer/instrumenter-core`.  It implements the standard Vite
 * `Plugin` shape (`name`, `transform`, `handleHotUpdate`) without taking
 * a hard `vite` dependency — the plugin object is a structural match for
 * Vite's `Plugin` type so the package builds cleanly without `vite`
 * installed in the dev shell.
 *
 * Beyond instrumenting modules the plugin owns the **manifest**: the
 * table that maps the flat `siteId` / `fnId` integers the runtime emits
 * back to `(path, line)`.  The page cannot read the filesystem, so the
 * manifest has to be handed to it — either baked into the HTML for a
 * built bundle or served over a dev-server endpoint.  Without it a
 * browser recording has no source locations at all, and everything
 * downstream that reasons about source (origin chains, the editor pane,
 * correlation-marker locations) degrades to opaque ids.
 *
 * Spec cross-reference:
 *   * `Planned-Features/Value-Origin-Tracking.milestones.org` M26
 *     deliverable 6 — Vite plugin instruments during dev-server
 *     transform; HMR-triggered re-builds re-instrument only changed
 *     modules.
 */

import {
  instrument,
  shouldInstrument,
  ManifestAccumulator,
} from "@codetracer/instrumenter-core";
import type {
  FilterOptions,
  ManifestSlice,
  MergedManifest,
} from "@codetracer/instrumenter-core";

/**
 * Dev-server route serving the merged manifest as JSON.
 *
 * Exported so the page-side bootstrap and the tests agree on the path
 * without duplicating the string.
 */
export const MANIFEST_ROUTE = "/__codetracer/manifest.json";

/** Global the injected bootstrap reads the baked-in manifest from. */
export const MANIFEST_GLOBAL = "__codetracer_manifest";

/** Global the injected bootstrap reads the WebSocket endpoint from. */
export const ENDPOINT_GLOBAL = "__codetracer_endpoint";

/** Options accepted by `codetracerVitePlugin`. */
export interface CodetracerViteOptions {
  /**
   * WebSocket endpoint the browser runtime ships events to.  Injected
   * into the page as `window.__codetracer_endpoint` so the static bundle
   * does not bake the URL in.
   */
  endpoint?: string;
  /** Globs of files to instrument (default: all `.js`/`.ts`/`.jsx`/`.tsx`). */
  include?: string[];
  /** Globs of files to skip (default: `node_modules/**`). */
  exclude?: string[];
  /**
   * When true, emit a source map alongside the transformed code.
   * Defaults to true — Vite expects plugins that rewrite source to
   * preserve sourcemap fidelity for the devtools panel.
   */
  sourceMaps?: boolean;
  /**
   * Hook fired every time a manifest slice is produced.  Tests use
   * this to assert that HMR re-invocations re-instrument the changed
   * module only (and not the whole graph).
   */
  onSlice?: (id: string, slice: ManifestSlice) => void;
}

/**
 * Minimal Vite-Plugin-shaped structural type.  We declare it here so the
 * package builds without taking `vite` as a peer dependency in the
 * lockfile — Vite consumes the plugin via duck typing.
 */
export interface CodetracerVitePlugin {
  name: string;
  enforce?: "pre" | "post";
  transform(code: string, id: string): { code: string; map?: string } | null;
  handleHotUpdate?(ctx: {
    file: string;
    modules: unknown[];
  }): unknown[] | undefined;
  transformIndexHtml?(html: string): string;
  configureServer?(server: DevServerLike): void;
  /** Test seam: the manifest merged from every transformed module. */
  mergedManifest(): MergedManifest;
}

/**
 * The slice of Vite's dev-server surface the plugin touches.  Declared
 * structurally for the same reason as `CodetracerVitePlugin`.
 */
export interface DevServerLike {
  middlewares: {
    use(
      route: string,
      handler: (
        req: unknown,
        res: {
          setHeader(name: string, value: string): void;
          end(body: string): void;
        },
        next: () => void,
      ) => void,
    ): void;
  };
}

/**
 * Is this module id something Vite synthesised rather than user source?
 *
 * Rollup marks virtual modules with a leading NUL, and Vite injects
 * several of them into every build — most notably the modulepreload
 * polyfill, which it places at the very top of the entry chunk.
 *
 * Instrumenting those is never what anyone wants, and in the polyfill's
 * case it is actively fatal: the injected `__ct.step()` calls end up as
 * the first statements in the bundle, executing before any application
 * module has had a chance to install the runtime, so the page dies with
 * `__ct is not defined` before it does anything at all.
 *
 * Vite's own client and HMR runtime are excluded for the same reason —
 * they are infrastructure, not the program under observation.
 */
function isNonUserModule(id: string): boolean {
  if (
    id.startsWith("\0") ||
    id.includes("/vite/dist/client/") ||
    id.includes("/@vite/") ||
    id.includes("/node_modules/.vite/")
  ) {
    return true;
  }
  return isRecorderModule(id);
}

/**
 * Is this module part of a CodeTracer recorder runtime?
 *
 * Instrumenting the recorder with itself is never wanted and is always
 * fatal. The recorder's own top-level code would emit `__ct.step()`
 * calls while it is still in the middle of *defining* `__ct`, so the
 * page dies with `__ct is not defined` before the application runs.
 *
 * This normally falls out of the default `node_modules` exclusion, but
 * not when the runtime is consumed straight from a source checkout —
 * exactly what a workspace build or a path alias does — so the check has
 * to be on the module's identity rather than on where it happens to
 * live.
 */
function isRecorderModule(id: string): boolean {
  const normalised = id.replace(/\\/g, "/");
  return (
    normalised.includes("/@codetracer/") ||
    normalised.includes("/codetracer-js-recorder/packages/") ||
    normalised.includes("/codetracer-wasm-instrumenter/recorder-runtime/") ||
    normalised.includes("/packages/runtime-browser/") ||
    normalised.includes("/packages/instrumenter/") ||
    normalised.includes("/packages/instrumenter-core/")
  );
}

/**
 * Build the `<script>` tag that seeds the page-side globals.
 *
 * Emitted with `type="application/json"` payloads embedded in a plain
 * script so the manifest survives HTML escaping unambiguously — the
 * JSON is serialised with `<` escaped so a source file containing
 * `</script>` in a string literal cannot terminate the tag early.
 */
function bootstrapTag(
  endpoint: string | undefined,
  manifest: MergedManifest,
): string {
  const safeJson = (value: unknown) =>
    JSON.stringify(value).replace(/</g, "\\u003c");
  const lines = [`window.${MANIFEST_GLOBAL} = ${safeJson(manifest)};`];
  if (endpoint) {
    lines.push(`window.${ENDPOINT_GLOBAL} = ${safeJson(endpoint)};`);
  }
  return `<script>${lines.join("")}</script>`;
}

/**
 * Build a Vite plugin that runs the CodeTracer SWC instrumenter on every
 * matching module.
 */
export function codetracerVitePlugin(
  options: CodetracerViteOptions = {},
): CodetracerVitePlugin {
  const filter: FilterOptions = {
    include: options.include,
    exclude: options.exclude,
  };

  const endpoint = options.endpoint;
  const sourceMaps = options.sourceMaps !== false;
  const manifest = new ManifestAccumulator();

  return {
    name: "codetracer:instrument",
    // `pre` runs before Vite's own TS / JSX transforms so the AST shape
    // matches what the instrumenter expects (idiomatic JS / TS source,
    // not Vite's intermediate transforms).
    enforce: "pre",

    transform(code: string, id: string) {
      // Vite ids can carry query strings (`?vue`, `?worker`); strip
      // before matching against the include glob.
      const path = id.split("?")[0];
      if (isNonUserModule(path)) return null;
      if (!shouldInstrument(path, filter)) return null;
      try {
        const result = instrument(code, { filename: path });
        // Keyed by the resolved id so an HMR re-transform replaces the
        // module's previous contribution rather than duplicating it.
        manifest.add(path, result.manifestSlice);
        options.onSlice?.(id, result.manifestSlice);
        if (sourceMaps) {
          return { code: result.code, map: result.map };
        }
        return { code: result.code };
      } catch {
        // Best-effort: a malformed file should not break the dev server.
        return null;
      }
    },

    handleHotUpdate(ctx) {
      // Re-instrument only the changed module — return its modules
      // unchanged so Vite's default HMR path takes over.  This is what
      // the `test_vite_plugin_instruments_during_dev_server_transform`
      // verification pins on.
      const path = ctx.file.split("?")[0];
      if (!shouldInstrument(path, filter)) return undefined;
      return ctx.modules;
    },

    configureServer(server: DevServerLike) {
      // Dev-server path: modules are transformed lazily, so the manifest
      // is only complete once the page has requested every module.  The
      // runtime therefore fetches it rather than reading a baked-in
      // global, and re-fetches before it stops the session so late-loaded
      // modules are covered.
      server.middlewares.use(MANIFEST_ROUTE, (_req, res, _next) => {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        res.end(JSON.stringify(manifest.merge()));
      });
    },

    transformIndexHtml(html: string) {
      // Build path: `transformIndexHtml` runs at `generateBundle`, after
      // every module has been transformed, so the accumulator is
      // complete and the manifest can be baked straight into the page.
      // On the dev server this fires before most modules load and the
      // baked manifest is a (possibly empty) starting point that the
      // runtime supersedes via MANIFEST_ROUTE.
      const tag = bootstrapTag(endpoint, manifest.merge());
      return html.includes("</head>")
        ? html.replace("</head>", `${tag}</head>`)
        : tag + html;
    },

    mergedManifest() {
      return manifest.merge();
    },
  };
}

/** Default export for the `import codetracer from "@codetracer/vite-plugin"` shape. */
export default codetracerVitePlugin;

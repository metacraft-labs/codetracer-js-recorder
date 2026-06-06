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
 * Spec cross-reference:
 *   * `Planned-Features/Value-Origin-Tracking.milestones.org` M26
 *     deliverable 6 — Vite plugin instruments during dev-server
 *     transform; HMR-triggered re-builds re-instrument only changed
 *     modules.
 */

import { instrument, shouldInstrument } from "@codetracer/instrumenter-core";
import type {
  FilterOptions,
  ManifestSlice,
} from "@codetracer/instrumenter-core";

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
      if (!shouldInstrument(path, filter)) return null;
      try {
        const result = instrument(code, { filename: path });
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

    transformIndexHtml(html: string) {
      // Inject the WebSocket endpoint into the page so the browser
      // runtime picks it up at load.  When no endpoint is configured,
      // the default `ws://localhost:9230/ct-stream` is used.
      if (!endpoint) return html;
      const tag = `<script>window.__codetracer_endpoint = ${JSON.stringify(
        endpoint,
      )};</script>`;
      return html.includes("</head>")
        ? html.replace("</head>", `${tag}</head>`)
        : tag + html;
    },
  };
}

/** Default export for the `import codetracer from "@codetracer/vite-plugin"` shape. */
export default codetracerVitePlugin;

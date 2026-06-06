/**
 * `@codetracer/instrumenter-core` — runtime-agnostic re-export of the
 * SWC-based AST visitor.
 *
 * Per M26 (`codetracer-specs/Planned-Features/Value-Origin-Tracking.milestones.org`)
 * the browser recorder, Node recorder, and bundler plugins (Vite / Webpack /
 * esbuild / Rollup) MUST share a single instrumentation pass.  The pass itself
 * is runtime-agnostic: it parses source, walks the AST, and produces
 * `{ code, map, manifestSlice }`.  No filesystem, no native addon, no
 * Node-specific surface is touched.
 *
 * This package is the canonical entry point that consumers SHOULD depend on.
 * Existing Node-recorder code keeps importing `@codetracer/instrumenter`
 * directly — that package still works and is what this core re-exports.  The
 * indirection lets us evolve the in-browser surface (Vite plugin, AOT CLI
 * targeting static hosting) without forcing the Node recorder to follow.
 *
 * Cross-references:
 *   * `codetracer-specs/GUI/Debugging-Features/Value-Origin-Tracking.md` §14.4
 *     — the wire format / no-shim policy that constrains what the visitor
 *     emits on the browser path.
 *   * `codetracer-specs/Planned-Features/Value-Origin-Tracking.milestones.org`
 *     M26 — the milestone whose deliverables include this package.
 */

export {
  instrument,
  shouldInstrument,
  DEFAULT_INCLUDE,
  DEFAULT_EXCLUDE,
} from "@codetracer/instrumenter";

export type {
  FilterOptions,
  InstrumentOptions,
  InstrumentResult,
  ManifestSlice,
  FunctionEntry,
  SiteEntry,
} from "@codetracer/instrumenter";

/**
 * `@codetracer/instrumenter-core` — runtime-agnostic re-export of the
 * SWC-based AST visitor.
 *
 * The browser recorder, Node recorder, and bundler plugins (Vite / Webpack /
 * esbuild / Rollup) MUST share a single instrumentation pass: they number
 * steps and sites the same way only if one implementation numbers them.  The pass itself
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
 * What constrains the browser path: events go out as newline-delimited JSON
 * over WebSocket, and the recorder installs no protocol shims (it never
 * intercepts `fetch`, `XMLHttpRequest`, `WebSocket` or `postMessage`), so the
 * visitor emits only `__ct.*` calls (see `@codetracer/runtime-browser`).
 */

export {
  instrument,
  shouldInstrument,
  DEFAULT_INCLUDE,
  DEFAULT_EXCLUDE,
  RECORDER_VERSION,
  MANIFEST_FILE_NAME,
  recorderVersionDeclaration,
  declaredRecorderVersion,
  manifestDocument,
  manifestFileContents,
} from "@codetracer/instrumenter";

export type {
  FilterOptions,
  InstrumentOptions,
  InstrumentResult,
  ManifestSlice,
  ManifestIdBases,
  FunctionEntry,
  SiteEntry,
} from "@codetracer/instrumenter";

export { ManifestAccumulator } from "./manifest";
export type { MergedManifest } from "./manifest";

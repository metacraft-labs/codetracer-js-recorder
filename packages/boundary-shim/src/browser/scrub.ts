/**
 * The scrubbing rules of a boundary log that do not depend on what the
 * visitor typed (CodeTracer's JS-Boundary-Recording specification §11.3.5).
 *
 * The implementation lives in `@codetracer/runtime-browser` (`scrub.ts`),
 * because the browser error reporter of that package applies the same rules
 * to its reports and cannot depend on this package (this package depends on
 * it). This module keeps the shim's own import path, and the one other
 * packages use (`@codetracer/boundary-shim/dist/browser/scrub.js`), pointing
 * at that single implementation.
 */

export * from "@codetracer/runtime-browser/dist/scrub.js";

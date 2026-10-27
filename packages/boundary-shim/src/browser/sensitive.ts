/**
 * Sensitive inputs (CodeTracer's JS-Boundary-Recording specification
 * §11.3): which fields are sensitive, the placeholders, the hole token's
 * substitution, event masking and the page's `ct` API.
 *
 * The implementation lives in `@codetracer/runtime-browser` (`sensitive.ts`),
 * because the browser error reporter of that package holes the same
 * sensitive values in its reports and cannot depend on this package (this
 * package depends on it). This module keeps the shim's own import path, and
 * the one other packages use
 * (`@codetracer/boundary-shim/dist/browser/sensitive.js`), pointing at that
 * single implementation. Its state is shared through the window either way
 * (`sensitiveState`), so every bundle in a page sees the same declarations.
 */

export * from "@codetracer/runtime-browser/dist/sensitive.js";

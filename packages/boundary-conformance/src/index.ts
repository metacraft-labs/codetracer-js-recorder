/**
 * `@codetracer/boundary-conformance`: the conformance suite of CodeTracer's
 * cooperation protocol (the JS-Boundary-Recording specification §9.9), the
 * definition of "implements the protocol".
 *
 * - the fixture scenarios a framework builds pages for ({@link FIXTURES});
 * - the record leg's harness ({@link runRecordLeg}, and the
 *   `ct-boundary-conformance record` command), which runs a build of them in
 *   headless Chromium and checks what it recorded;
 * - the suite's own builds: the generic build for the generic shim (level 0)
 *   and the test-only reference micro-framework's (level 1), which prove that
 *   the harness discriminates.
 *
 * The suite is versioned with the protocol ({@link PROTOCOL_VERSION}).
 */

export * from "./protocol.js";
export * from "./fixtures.js";
export * from "./cadence.js";
export * from "./envelope.js";
export * from "./checks.js";
export * from "./harness.js";
export * from "./builds.js";
export { startHarnessServer, type HarnessServer } from "./server.js";
export { loadPlaywright, type Browser } from "./playwright.js";

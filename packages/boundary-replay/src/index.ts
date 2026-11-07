/**
 * `@codetracer/boundary-replay`: the replay runner of CodeTracer's browser
 * boundary recording (the JS-Boundary-Recording specification §6, §7, §9.7,
 * §12).
 *
 * - {@link replaySession} (and the `ct-boundary-replay` command): replay a
 *   recorded log in headless Chromium against the build it ran, report the
 *   first divergence as a typed error, and with an output write the
 *   materialised JavaScript trace;
 * - the in-page half, `dist/replay-runtime.iife.js`: `__ctReplay` and the
 *   scheduler (`src/browser/runtime.ts`), which the generic shim's replay
 *   mode and cooperating frameworks call.
 */

export * from "./runner.js";
export * from "./log.js";
export * from "./edit.js";
export * from "./playwright.js";
export type { ReplayStatus } from "./browser/runtime.js";

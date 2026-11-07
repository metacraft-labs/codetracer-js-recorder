/**
 * The generic shim's sensitive-input API as the generic fixture pages see it
 * (CodeTracer's JS-Boundary-Recording specification §11.3.1, §11.3.2): the
 * shim publishes it as `globalThis.ct` in record and replay mode.
 */
import type { CtApi } from "@codetracer/boundary-shim/dist/browser/sensitive.js";

export const ct = (globalThis as unknown as { ct: CtApi }).ct;

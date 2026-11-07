/**
 * The reference framework's API as the fixture apps see it. The framework
 * bundle (`microfw.ts`) is loaded first by every page and publishes it as
 * `globalThis.__ctRef`; each app is bundled on its own and only reads it.
 */
import type { ReferenceApi } from "./microfw.js";

export const ref = (globalThis as unknown as { __ctRef: ReferenceApi }).__ctRef;

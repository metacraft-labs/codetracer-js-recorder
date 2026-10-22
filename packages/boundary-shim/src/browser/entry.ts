/**
 * The entry point of `dist/boundary-shim.iife.js`, the script the bootstrap
 * `<script>` carries: read the configuration the bootstrap set and install
 * the shim. Nothing escapes to the page: if installing fails, the page runs
 * as if the shim were absent.
 */

import { CONFIG_GLOBAL, type ShimConfig } from "./config.js";
import type { ShimWindow } from "./context.js";
import { installBoundaryShim } from "./install.js";

try {
  const w = globalThis as unknown as ShimWindow;
  const config = (w as unknown as Record<string, ShimConfig | undefined>)[
    CONFIG_GLOBAL
  ];
  installBoundaryShim(w, config ?? {});
} catch {
  // Never throw into the page (JS-Boundary-Recording.md §10.1).
}

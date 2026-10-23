/**
 * The entry point of `dist/replay-runtime.iife.js`, the runner's first init
 * script in a replay page: install `__ctReplay` from the configuration the
 * runner set just before it (see `runtime.ts`).
 */

import { installFromConfig } from "./runtime.js";

installFromConfig();

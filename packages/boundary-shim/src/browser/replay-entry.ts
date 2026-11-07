/**
 * The entry point of `dist/boundary-shim-replay.iife.js`: the generic shim
 * in replay mode, installed by the replay runner after `__ctReplay` and
 * before any page code (see `replay/install.ts`). Unlike the record bundle
 * it does not swallow its own failures: a replay that cannot install its
 * seams must fail loudly rather than run the page against the platform.
 */

import { installReplayShimFromGlobals } from "./replay/install.js";

installReplayShimFromGlobals();

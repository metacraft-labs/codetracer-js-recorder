/**
 * Install the generic boundary shim in **replay mode** (CodeTracer's
 * JS-Boundary-Recording specification §9.7, §10): the same seams as record
 * mode, each answering from the replay runner's `__ctReplay` instead of
 * the platform, and input injected as synthetic events (§10.3). The shim
 * is then a client of `__ctReplay` like any cooperating framework, so
 * divergence detection has one implementation, the runner's cursor.
 *
 * The runner installs it with `addInitScript`, after `__ctReplay` and
 * before any page code (`dist/boundary-shim-replay.iife.js`). Visitors
 * never load it: the record bundle is a separate file.
 */

import { CONTROL_GLOBAL } from "../config.js";
import { domV1Hash } from "../dom-v1.js";
import type { ShimOriginals } from "../originals.js";
import { type CtReplay, replayOf } from "../replay-api.js";
import { newReplayContext } from "./context.js";
import {
  type ReplayInjector,
  replayDomSeams,
  replayInput,
  replayNavigation,
} from "./dom.js";
import { replayMessageSeams } from "./message.js";
import { replayNetSeams } from "./net.js";
import { replayPlatformSeams } from "./platform.js";
import { replayTimeSeams } from "./time.js";
import { installTrustedEvents } from "./trusted.js";
import { replayXhr } from "./xhr.js";

/** What the shim publishes on `globalThis.__ctBoundaryShim` in replay mode. */
export interface ShimReplayControl extends ReplayInjector {
  readonly protocolLevel: 0;
  readonly mode: "replay";
  /** `Header.session_id` of the session being replayed. */
  readonly sessionId: string;
  readonly originals: ShimOriginals;
  /** Always `false`: nothing is recorded in replay mode. */
  readonly recording: false;
  /** The `dom-v1` hash of the document now. */
  domV1Hash(): string;
  /**
   * The site's consent callback (§11.2), called at once as record mode
   * calls it, so the page code it runs runs at the same point; its answer
   * is not used: nothing is uploaded in replay mode.
   */
  consent(callback: () => unknown): void;
}

/** Install the replay-mode shim on `w`, a client of `replay`. */
export function installReplayShim(
  w: Window & typeof globalThis,
  replay: CtReplay,
): ShimReplayControl {
  const existing = (
    w as unknown as Record<string, ShimReplayControl | undefined>
  )[CONTROL_GLOBAL];
  if (existing !== undefined) return existing;
  const ctx = newReplayContext(w, replay);
  ctx.trusted = installTrustedEvents(ctx);
  replayTimeSeams(ctx);
  replayNetSeams(ctx);
  replayXhr(ctx);
  replayDomSeams(ctx);
  replayPlatformSeams(ctx);
  replayMessageSeams(ctx);
  replayNavigation(ctx);
  const injector = replayInput(ctx);
  const control: ShimReplayControl = {
    protocolLevel: 0,
    mode: "replay",
    sessionId: replay.header.session_id,
    originals: replay.originals,
    recording: false,
    domV1Hash: () => domV1Hash(w.document),
    consent: (callback) => {
      try {
        callback();
      } catch {
        // Record mode swallows it too (a throw is a "no").
      }
    },
    inject: (input, effects) => injector.inject(input, effects),
  };
  Object.defineProperty(w, CONTROL_GLOBAL, {
    value: control,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return control;
}

/** Install from the globals: `__ctReplay` must already be there. */
export function installReplayShimFromGlobals(): ShimReplayControl {
  const w = globalThis as unknown as Window & typeof globalThis;
  const replay = replayOf(w);
  if (replay === undefined) {
    throw new Error(
      "the boundary shim's replay mode needs __ctReplay, installed first by the replay runner",
    );
  }
  return installReplayShim(w, replay);
}

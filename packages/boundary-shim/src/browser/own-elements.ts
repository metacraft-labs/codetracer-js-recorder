/**
 * The elements CodeTracer adds to a page, which a document position never
 * counts and no recorded event names (CodeTracer's JS-Boundary-Recording
 * specification §6, "The document's own tasks"): the record bootstrap and
 * the replay runner's gates.
 */

import { BOOTSTRAP_MARKER } from "./config.js";

/**
 * The attribute of the elements the replay runner adds to a replayed page
 * (its parser gates, `packages/boundary-replay/src/gates.ts`). Like the
 * record bootstrap ({@link BOOTSTRAP_MARKER}), they are CodeTracer's, not
 * the page's, and are never counted.
 */
export const REPLAY_GATE_MARKER = "data-ct-replay-gate";

/** Whether `el` is one of CodeTracer's own scripts. */
export function isOwnElement(el: Element): boolean {
  return (
    el.hasAttribute(BOOTSTRAP_MARKER) || el.hasAttribute(REPLAY_GATE_MARKER)
  );
}

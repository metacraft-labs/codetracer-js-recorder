/**
 * What every group of the shim's replay seams is given (CodeTracer's
 * JS-Boundary-Recording specification §9.7, §10): the window, the runner's
 * `__ctReplay` (every read goes through its cursor), the originals it
 * captured before anything was patched, and the shim's id counters.
 *
 * The counters mirror the record side's (`Recorder.nextTaskId`,
 * `nextReqId`): the shim mints a task or request id at exactly the points
 * where it minted one while recording, so the ids the page's replay
 * produces are the ids the log holds, and the cursor checks them.
 */

import type { ShimOriginals } from "../originals.js";
import type { CtReplay } from "../replay-api.js";
import type { TrustedEvents } from "./trusted.js";

export interface ReplayContext {
  w: Window & typeof globalThis;
  replay: CtReplay;
  orig: ShimOriginals;
  /** A fresh `task_id`, as the recorder would have minted it. */
  nextTaskId(): bigint;
  /** A fresh `req_id`. */
  nextReqId(): bigint;
  /**
   * Check that a task the browser dispatched (an input, a navigation) and
   * the recorder minted an id for has the id the shim mints now; a page
   * that registered a different number of tasks before it diverges here.
   */
  claimTaskId(logged: bigint): void;
  /**
   * Dispatches the events replay fires in the platform's place, so the
   * page's listeners see them as trusted (`trusted.ts`). Set by the
   * installer, before any seam.
   */
  trusted: TrustedEvents;
}

export function newReplayContext(
  w: Window & typeof globalThis,
  replay: CtReplay,
): ReplayContext {
  let nextTask = 1n;
  let nextReq = 1n;
  return {
    w,
    replay,
    orig: replay.originals,
    nextTaskId: () => nextTask++,
    nextReqId: () => nextReq++,
    claimTaskId(logged) {
      if (logged !== nextTask) {
        replay.fail(
          "TaskOrderMismatch",
          `the log's task ${logged} was minted when the browser dispatched it, but the replay's next task id is ${nextTask}`,
          `task_id=${logged}`,
          `task_id=${nextTask}`,
        );
      }
      nextTask++;
    },
    trusted: {
      dispatch() {
        throw new Error("the replay shim's trusted dispatch is not installed");
      },
    },
  };
}

/** The IEEE-754 double whose bits are `bits` (`Clock.bits`, §5.2). */
export function bitsToNumber(bits: bigint): number {
  const v = new DataView(new ArrayBuffer(8));
  v.setBigUint64(0, bits, true);
  return v.getFloat64(0, true);
}

const utf8 = new TextDecoder();

/** The bytes of a `blobref` (the runner inlines every body, §9.7). */
export function blobBytes(
  replay: CtReplay,
  blob: { kind: "inline"; bytes: Uint8Array } | { kind: "ref" },
): Uint8Array {
  if (blob.kind !== "inline") {
    return replay.fail(
      "NonReplayable",
      "a body is a jsbound.blb reference the runner did not resolve",
    );
  }
  return blob.bytes;
}

/** `bytes` as UTF-8 text. */
export function utf8Text(bytes: Uint8Array): string {
  return utf8.decode(bytes);
}

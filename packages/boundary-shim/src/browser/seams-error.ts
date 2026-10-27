/**
 * The page's uncaught errors (CodeTracer's JS-Boundary-Recording
 * specification §5.2 `Error`, §7.2 `ErrorMismatch`, §11.3.5): each `error`
 * event the window receives for a script error is an `Error{kind: 1}` record,
 * written when the event reaches the shim's listener, before the page's own
 * (registered at install, before any page code). The recorder's sanitizer
 * reduces its message to a template and scrubs the frames' URLs before the
 * frame is encoded (`record-scrub.ts`), so the raw message never leaves the
 * page.
 *
 * `unhandledrejection` (kind 2) is not written: the platform dispatches it
 * in a task of its own (HTML, "notify about rejected promises"), which the
 * log has no `Task` kind for, so a replay could not raise it where the log
 * would have it.
 *
 * The frames are parsed by `@codetracer/runtime-browser`'s `framesOf`, the
 * parser the browser error reporter uses too.
 */

import { framesOf } from "@codetracer/runtime-browser/dist/error-frames.js";

import type { SeamContext } from "./context.js";

/** `Error.kind` (§5.2). */
const ErrorKind = { error: 1 } as const;

/**
 * Listen at the window, in the capture phase, for the `error` events of
 * uncaught script errors (an `ErrorEvent` whose target is the window; a
 * resource element's `error` is not one, §6) and write each as `Error`.
 */
export function listenForPageErrors(ctx: SeamContext): void {
  const { w, rec, orig } = ctx;
  orig.addEventListener.call(
    w,
    "error",
    (ev: Event) => {
      if (!rec.recording) return;
      if (!(ev instanceof w.ErrorEvent) || ev.target !== w) return;
      rec.guard(() => {
        let stack: unknown;
        try {
          stack = (ev.error as { stack?: unknown } | null)?.stack;
        } catch {
          stack = undefined;
        }
        rec.emit("Error", {
          kind: ErrorKind.error,
          message: String(ev.message ?? ""),
          frames: JSON.stringify(framesOf(stack)),
        });
      });
    },
    { capture: true },
  );
}

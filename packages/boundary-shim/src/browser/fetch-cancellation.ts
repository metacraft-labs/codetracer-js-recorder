/** Causal pre-header cancellation, without serializing application reasons.
 * Fetch rejects with its signal's reason. A private reason distinguishes that
 * operation's cancellation from an unrelated failure followed by a page abort,
 * including one with the identical error. Native dependent signals bypass a
 * source's stopImmediatePropagation listener (DOM, abort dependent signals).
 * https://fetch.spec.whatwg.org/#fetch-method
 * https://dom.spec.whatwg.org/#abortsignal-dependent-signals
 */
import type { ShimOriginals } from "./originals.js";
import { Outcome } from "./stream-body.js";

export interface FetchCancellation {
  init: RequestInit | undefined;
  head(): void;
  release(): void;
  rejection(error: unknown): { error: unknown; outcome: number };
}

/** The original low-capability path remains when captured operations lack. */
export function prepareFetchCancellation(
  orig: ShimOriginals,
  input: RequestInfo | URL,
  init?: RequestInit,
): FetchCancellation | undefined {
  const aborted = orig.abortSignalAborted?.descriptor.get;
  const reason = orig.abortSignalReason?.descriptor.get;
  const controllerSignal = orig.abortControllerSignal?.descriptor.get;
  const exceptionName = orig.domExceptionName?.descriptor.get;
  const any = orig.abortSignalAny;
  if (
    !aborted ||
    !reason ||
    !controllerSignal ||
    !exceptionName ||
    !any ||
    !orig.requestSignal?.descriptor.get ||
    !orig.responseBody?.descriptor.get ||
    !orig.DOMException ||
    !orig.AbortController ||
    !orig.abortControllerAbort ||
    !orig.removeEventListener
  )
    return undefined;
  // Primitive dictionaries must retain the native fetch validation context.
  if (
    init !== undefined &&
    init !== null &&
    typeof init !== "object" &&
    typeof init !== "function"
  )
    return undefined;
  const token = new orig.DOMException(
    "private fetch cancellation",
    "AbortError",
  );
  let pageSignal: AbortSignal | undefined;
  let dependent: AbortSignal | undefined;
  let nativeSignal: AbortSignal | undefined;
  let stop: (() => void) | undefined;
  let head = false;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (dependent && stop)
      orig.removeEventListener.call(dependent, "abort", stop);
  };
  const observedInit = new Proxy(Object.create(null) as RequestInit, {
    get(_target, key) {
      const value = init == null ? undefined : Reflect.get(init, key, init);
      if (key !== "signal" || value === null) return value;
      let candidate = value;
      if (candidate === undefined) {
        try {
          candidate = orig.requestSignal?.descriptor.get?.call(input);
        } catch {
          return value;
        } // not a native Request; preserve platform handling
      }
      if (candidate === undefined) return value;
      // A brand probe never replaces invalid signal/proxy validation errors.
      try {
        aborted.call(candidate);
      } catch {
        return value;
      }
      pageSignal = candidate as AbortSignal;
      const controller = new orig.AbortController();
      nativeSignal = controllerSignal.call(controller);
      dependent = any.call(orig.AbortSignal, [pageSignal]);
      const source = pageSignal;
      stop = () => {
        orig.abortControllerAbort.call(
          controller,
          head ? reason.call(source) : token,
        );
      };
      orig.addEventListener.call(dependent, "abort", stop, { once: true });
      if (aborted.call(dependent)) stop();
      return nativeSignal;
    },
  });
  return {
    init: observedInit,
    head() {
      head = true;
    },
    release,
    rejection(error) {
      if (error === token && pageSignal !== undefined) {
        const pageError = reason.call(pageSignal);
        let timeout = false;
        try {
          timeout = exceptionName.call(pageError) === "TimeoutError";
        } catch {
          /* not a native DOMException; arbitrary names are never read */
        }
        return {
          error: pageError,
          outcome: timeout ? Outcome.timeout : Outcome.abort,
        };
      }
      return { error, outcome: Outcome.networkError };
    },
  };
}

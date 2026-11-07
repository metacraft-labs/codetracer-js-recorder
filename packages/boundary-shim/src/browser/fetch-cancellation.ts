/** Causal pre-header cancellation, without serializing application reasons.
 * Fetch rejects with its signal's reason. A private reason distinguishes that
 * operation's cancellation from an unrelated failure followed by a page abort,
 * including one with the identical error. Native dependent signals bypass a
 * source's stopImmediatePropagation listener (DOM, abort dependent signals).
 * Where AbortSignal.any is absent, a private Request's signal is that
 * dependent: the Request constructor makes its signal follow init.signal
 * (Fetch, new Request(), the step that creates a dependent abort signal).
 * https://fetch.spec.whatwg.org/#fetch-method
 * https://fetch.spec.whatwg.org/#dom-request
 * https://dom.spec.whatwg.org/#abortsignal-dependent-signals
 */
import type { ShimOriginals } from "./originals.js";
import { Outcome } from "./stream-body.js";

export interface FetchCancellation {
  init: RequestInit | undefined;
  /** The response head arrived; `resp` is the native fetch's own Response. */
  head(resp: Response): void;
  release(): void;
  rejection(error: unknown): { error: unknown; outcome: number };
}

/**
 * Per captured realm: releases the mirror of a body nobody tracked (a raw
 * Refused body, a page-shadowed body) once that native body stream is
 * unreachable. Every reader, tee branch (clone) and the Response itself
 * retain that stream, so collection proves nothing can observe its later
 * error. Tracked bodies are released deterministically first.
 * https://tc39.es/ecma262/#sec-finalization-registry-objects
 */
const bodyRegistries = new WeakMap<
  ShimOriginals,
  FinalizationRegistry<() => void>
>();

function bodyRegistry(
  orig: ShimOriginals,
): FinalizationRegistry<() => void> | undefined {
  const captured = orig.finalizationRegistry;
  if (!captured) return undefined;
  let registry = bodyRegistries.get(orig);
  if (!registry) {
    registry = new captured.ctor<() => void>((release) => release());
    bodyRegistries.set(orig, registry);
  }
  return registry;
}

/** A URL the private follower Request parses without network or page state. */
const FOLLOWER_URL = "data:,";

/**
 * A native signal that aborts, with the same reason, when `source` aborts and
 * that page listeners on `source` cannot stop. `undefined` only when neither
 * AbortSignal.any nor a captured Request constructor and signal getter exist.
 */
function dependentSignalFactory(
  orig: ShimOriginals,
): ((source: AbortSignal) => AbortSignal) | undefined {
  const any = orig.abortSignalAny;
  if (any) return (source) => any.call(orig.AbortSignal, [source]);
  const OrigRequest = orig.Request;
  const requestSignal = orig.requestSignal?.descriptor.get;
  if (!OrigRequest || !requestSignal) return undefined;
  // A dictionary of our own with no prototype: WebIDL reads every RequestInit
  // member through the chain, so an Object.prototype getter of the page's
  // would otherwise observe (or alter) this private conversion. Only the
  // brand-checked signal is present.
  // https://webidl.spec.whatwg.org/#js-dictionary
  return (source) => {
    const init = { __proto__: null, signal: source } as RequestInit;
    return requestSignal.call(
      new OrigRequest(FOLLOWER_URL, init),
    ) as AbortSignal;
  };
}

/**
 * The native operations proving causal cancellation, or `undefined` where the
 * engine predates AbortSignal.reason: there every cancellation rejects with
 * the platform's own AbortError, whose name already classifies it in Record
 * and Replay alike (stream-body.ts failureOutcome).
 */
export function prepareFetchCancellation(
  orig: ShimOriginals,
  input: RequestInfo | URL,
  init?: RequestInit,
): FetchCancellation | undefined {
  const aborted = orig.abortSignalAborted?.descriptor.get;
  const reason = orig.abortSignalReason?.descriptor.get;
  const controllerSignal = orig.abortControllerSignal?.descriptor.get;
  const exceptionName = orig.domExceptionName?.descriptor.get;
  const follow = dependentSignalFactory(orig);
  if (
    !aborted ||
    !reason ||
    !controllerSignal ||
    !exceptionName ||
    !follow ||
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
  // The unregister token: never the body itself, which it must not retain.
  const registration = {};
  let registered: FinalizationRegistry<() => void> | undefined;
  const release = () => {
    if (released) return;
    released = true;
    if (registered)
      orig.finalizationRegistry?.unregister.call(registered, registration);
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
      dependent = follow(pageSignal);
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
    head(resp) {
      head = true;
      if (released || !dependent) return;
      // The captured internal accessor: no page-observable body Get.
      const body = orig.responseBody?.descriptor.get?.call(resp);
      if (body === null || typeof body !== "object") return;
      registered = bodyRegistry(orig);
      if (registered)
        orig.finalizationRegistry?.register.call(
          registered,
          body,
          release,
          registration,
        );
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

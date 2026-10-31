/**
 * Preserve stream failures through constructed Response body consumers.
 * Chromium's native consumers replace a byte-stream error with TypeError:
 * "Failed to fetch". Preserve the public native consumer abort diagnostic
 * when the original body aborts. Share its cell with clones, whose streams
 * tee that same body; leave independent consumer errors untouched.
 */
import type { ShimOriginals } from "./originals.js";
import type { ShimWindow } from "./context.js";

export interface BodyFailure {
  failed: boolean;
  error?: unknown;
}

export function prepareBodyFailures(w: ShimWindow, orig: ShimOriginals) {
  const prototype = orig.Response?.prototype;
  const body =
    prototype && Object.getOwnPropertyDescriptor(prototype, "body")?.get;
  const used =
    prototype && Object.getOwnPropertyDescriptor(prototype, "bodyUsed")?.get;
  const locked =
    orig.ReadableStream &&
    Object.getOwnPropertyDescriptor(orig.ReadableStream.prototype, "locked")
      ?.get;
  const DOMException = w.DOMException;
  const failures = new WeakMap<object, BodyFailure>();
  return {
    bind(response: Response, failure: BodyFailure) {
      failures.set(response, failure);
    },
    clone(from: Response, to: Response) {
      const failure = failures.get(from);
      if (failure) failures.set(to, failure);
    },
    read(
      response: Response,
      consume: () => Promise<unknown>,
    ): Promise<unknown> {
      const failure = failures.get(response);
      // Locked/disturbed reads must retain the consumer's own native error,
      // even when the network body has also failed. Inspect before consuming.
      const stream = failure && body?.call(response);
      const eligible =
        stream &&
        used &&
        locked &&
        !used.call(response) &&
        !locked.call(stream);
      const settled = consume();
      if (!eligible) return settled;
      return orig.promiseThen.call(settled, undefined, (error: unknown) => {
        // Native fetch's consumer reports its public abort diagnostic; the
        // reader's stored error can instead name Blink's BodyStreamBuffer.
        if (
          failure!.failed &&
          (failure!.error as { name?: string })?.name === "AbortError" &&
          (error as { name?: string })?.name === "TypeError" &&
          (error as { message?: string })?.message === "Failed to fetch"
        ) {
          throw new DOMException("The user aborted a request.", "AbortError");
        }
        throw error;
      });
    },
  };
}

/**
 * JSON consumption for owned streamed responses (JS-Boundary-Recording §10.1).
 * Chromium parses a constructed stream synchronously inside controller.close;
 * its WebIDL exception context then incorrectly names that internal close call.
 * Decode through the native body consumer and parse in its Promise reaction, so
 * the engine's parser exception reaches the page without recorder context.
 */
import type { ShimWindow } from "./context.js";
import type { ShimOriginals } from "./originals.js";

/** Prepare once before prototype patching; callers select only owned streams. */
export function prepareJsonBodyRead(w: ShimWindow, orig: ShimOriginals) {
  const response = orig.Response?.prototype;
  const text = response?.text;
  const json = response?.json;
  const body =
    response && Object.getOwnPropertyDescriptor(response, "body")?.get;
  const used =
    response && Object.getOwnPropertyDescriptor(response, "bodyUsed")?.get;
  const locked =
    orig.ReadableStream &&
    Object.getOwnPropertyDescriptor(orig.ReadableStream.prototype, "locked")
      ?.get;
  const parse = w.JSON.parse;
  if (!text || !json || !body || !used || !locked) return undefined;

  return (r: Response, args: unknown[]): Promise<unknown> => {
    const stream = body.call(r) as ReadableStream | null;
    // Preserve native method/receiver diagnostics, and do not turn a failed
    // second read into a text() error. Captured getters bypass page overrides.
    if (used.call(r) || stream === null || locked.call(stream)) {
      return json.apply(r, args as []);
    }
    return orig.promiseThen.call(text.apply(r, args as []), (value: unknown) =>
      parse(value as string),
    );
  };
}

/**
 * The record side's scrubbing of each record before it is encoded
 * (CodeTracer's JS-Boundary-Recording specification §11.3.5, §5.2.1): one
 * function over the record kinds, so that every URL the log holds is
 * scrubbed and holed wherever a seam wrote it, and so that the frames an
 * upload transport still holds when the ingest's lists arrive can be
 * scrubbed again with them ({@link rescrubFrame}).
 *
 * What it does, by field:
 *
 * - every URL (`NetRequest.url`, `NetResponse.url`, `Navigation.url`,
 *   `Env.url`, a storage event's `url`, `DocTask.src`, the URLs a
 *   `PlatformValue` hands the page: performance-timeline entry names, a
 *   media element's `currentSrc`, `document.referrer`; the frame URLs of an
 *   `Error`): the sensitive values holed, then the site's query keys and
 *   credential-shaped values scrubbed;
 * - `NetResponse.headers`: the credential, proxy and site-listed headers
 *   removed;
 * - `Error.message`: the sensitive values holed, then reduced to its
 *   template;
 * - the page's own words, `Input.label` and `Mark` (its name and every
 *   string of its data): the sensitive values holed.
 *
 * A request body is never in the log (only its holed digest, which the seam
 * computes), and an outbound message's bytes are holed by the seam.
 */

import {
  type BoundaryRecord,
  decodeRecord,
  encodeFrame,
} from "@codetracer/boundary-format";

import { holeText } from "./sensitive.js";
import {
  type ScrubLists,
  scrubHeaders,
  scrubUrl,
  templateErrorMessage,
} from "./scrub.js";

/** A string that is an absolute URL (a scheme, then `:`), which is scrubbed. */
const ABSOLUTE_URL = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** `PlatformValue.src` whose values are compared on replay, not returned. */
const COMPARED_PLATFORM_VALUE_SRC = 3;

/**
 * Scrub `r` with the site's `lists`, holing the values `holes()` returns
 * (asked only when the record holds a URL). Returns `r` itself when nothing
 * changes.
 */
export function sanitizeRecord(
  r: BoundaryRecord,
  lists: ScrubLists,
  holes: () => readonly string[],
): BoundaryRecord {
  let values: readonly string[] | undefined;
  const holed = (t: string): string => {
    values ??= holes();
    return holeText(t, values);
  };
  const url = (u: string): string => {
    if (u === "") return u;
    return scrubUrl(holed(u), lists);
  };
  switch (r.record) {
    case "Env":
      return { ...r, url: url(r.url) };
    case "NetRequest":
    case "Navigation":
      return { ...r, url: url(r.url) };
    case "NetResponse":
      return { ...r, url: url(r.url), headers: scrubHeaders(r.headers, lists) };
    case "DocTask":
      return { ...r, src: url(r.src) };
    case "Input":
      if (r.type !== "storage") {
        // A label is the page's own declaration (§9.4), but a page could
        // write what the visitor typed into it.
        return r.label === "" ? r : { ...r, label: holed(r.label) };
      }
      return {
        ...r,
        label: r.label === "" ? r.label : holed(r.label),
        props: mapJsonUrls(r.props, url, (k) => k === "url"),
      };
    case "Mark":
      // The page's own words (§13), which may quote what the visitor typed:
      // the name, and every string of the data, holed.
      return { ...r, name: holed(r.name), data: mapJsonStrings(r.data, holed) };
    case "PlatformValue":
      // A MutationObserver's records are compared with the replay's own,
      // which no scrubbing reproduces; they hold the document's own text.
      if (r.src === COMPARED_PLATFORM_VALUE_SRC) return r;
      return { ...r, value: mapJsonUrls(r.value, url, () => true) };
    case "Error":
      return {
        ...r,
        // A message can quote what the page was given (a parse error's
        // input): the sensitive values are holed before it is templated.
        message: templateErrorMessage(holed(r.message)),
        frames: mapJsonUrls(r.frames, url, (k) => k === "url"),
      };
    default:
      return r;
  }
}

/**
 * `json` with every string that is an absolute URL, under a key `at`
 * accepts (or as an array element, when `at("")` does), mapped by `f`.
 * Text that is not JSON is returned as it is (it names no URL a decoder
 * could find).
 */
function mapJsonUrls(
  json: string,
  f: (u: string) => string,
  at: (key: string) => boolean,
): string {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return json;
  }
  let changed = false;
  const walk = (x: unknown, key: string): unknown => {
    if (typeof x === "string") {
      if (!at(key) || !ABSOLUTE_URL.test(x)) return x;
      const y = f(x);
      if (y !== x) changed = true;
      return y;
    }
    if (Array.isArray(x)) return x.map((e) => walk(e, key));
    if (x !== null && typeof x === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, e] of Object.entries(x)) out[k] = walk(e, k);
      return out;
    }
    return x;
  };
  const mapped = walk(v, "");
  return changed ? JSON.stringify(mapped) : json;
}

/**
 * `json` with every string in it (keys excepted) mapped by `f`, written
 * again only when one changed; text that is not JSON is mapped as a whole.
 */
function mapJsonStrings(json: string, f: (s: string) => string): string {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return f(json);
  }
  let changed = false;
  const walk = (x: unknown): unknown => {
    if (typeof x === "string") {
      const y = f(x);
      if (y !== x) changed = true;
      return y;
    }
    if (Array.isArray(x)) return x.map(walk);
    if (x !== null && typeof x === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, e] of Object.entries(x)) out[k] = walk(e);
      return out;
    }
    return x;
  };
  const mapped = walk(v);
  return changed ? JSON.stringify(mapped) : json;
}

/**
 * A frame encoded before the site's `lists` were known, scrubbed with them
 * (the holes were applied when it was written). Used on the frames an
 * upload transport still holds when the ingest's configuration arrives:
 * nothing is sent before it, so no URL leaves the page unscrubbed.
 */
export function rescrubFrame(frame: Uint8Array, lists: ScrubLists): Uint8Array {
  // A frame is `len:u32 tag body` (§5.2); the record decoder takes the
  // payload after the length.
  const record = decodeRecord(frame.subarray(4));
  const scrubbed = sanitizeRecord(record, lists, () => []);
  return scrubbed === record ? frame : encodeFrame(scrubbed);
}

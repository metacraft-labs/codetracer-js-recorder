/**
 * Where the record bootstrap goes in a page, and where an earlier one is
 * (CodeTracer's JS-Boundary-Recording specification §10, and §6 "The
 * document's own tasks", whose replay stand-in goes at the same position).
 *
 * Both are found with the HTML tokenizer of `./html-scan.ts`, never with a
 * text search: a `<head>` in a comment, a script's text, an attribute value,
 * a `<template>` or a stray tag in the body is not the page's head, and a
 * bootstrap put there never runs, or runs after the page's own scripts.
 * Imports nothing that needs Node or the DOM, so the replay runner shares
 * it.
 */

import { BOOTSTRAP_MARKER } from "./browser/config.js";
import { type Tag, isSpace, scanTags, tagAttributes } from "./html-scan.js";

/**
 * End tags the tree builder acts on before it has a head (the "initial",
 * "before html" and "before head" insertion modes): each implies the head,
 * as a start tag does. Every other end tag is ignored there.
 */
const HEAD_IMPLYING_END_TAGS: ReadonlySet<string> = new Set([
  "head",
  "body",
  "html",
  "br",
]);

/**
 * What a tag is to the encoding declaration rule of
 * {@link bootstrapPosition}:
 *
 * - `"declaration"`: a `<meta>` that declares the page's character
 *   encoding, as the encoding prescan finds one
 *   (https://html.spec.whatwg.org/multipage/parsing.html#prescan-a-byte-stream-to-determine-its-encoding):
 *   a `charset` attribute, or `http-equiv="content-type"` with a `content`
 *   attribute;
 * - `"inert"`: a `<meta>` with neither `charset` nor `http-equiv` (a
 *   `name`, `property` or `itemprop` one), which neither runs script nor
 *   changes how the page or the bootstrap is processed;
 * - `undefined`: anything else. That includes a `<meta>` whose `http-equiv`
 *   is not `content-type` (a Content-Security-Policy, which would then
 *   apply to the bootstrap, or a refresh), whatever else it carries.
 */
function metaKind(tag: Tag): "declaration" | "inert" | undefined {
  if (tag.end || tag.name !== "meta" || !tag.terminated) return undefined;
  const attributes = tagAttributes(tag.attributes);
  const httpEquiv = attributes.get("http-equiv");
  if (httpEquiv !== undefined) {
    return httpEquiv.trim().toLowerCase() === "content-type" &&
      attributes.has("content")
      ? "declaration"
      : undefined;
  }
  return attributes.has("charset") ? "declaration" : "inert";
}

/**
 * Where the bootstrap goes in `html` (a page without one): the point at
 * which the tree builder has made, or is about to make, the head, so the
 * bootstrap is the first script the parser meets and, but for the page's
 * encoding declaration (below), the first element of the head.
 *
 * - Right after the page's `<head …>` start tag, when it is the first start
 *   tag other than `<html>` and no text but whitespace comes before it.
 * - Otherwise right before the first thing that makes the head: a start tag
 *   other than `<html>`, an end tag the modes before the head act on
 *   (`</head>`, `</body>`, `</html>`, `</br>`), or text that is not
 *   whitespace (at its first character that is not). The bootstrap then
 *   implies the head itself, and whitespace before it, which the modes
 *   before the head drop, stays dropped: the page's tree is the same as
 *   without the bootstrap, but for the bootstrap.
 * - Otherwise (a document of only a doctype, comments, `<html>` and
 *   whitespace) at the end of the document, or, when the document ends
 *   inside a tag, a comment or a doctype, right before it: the tokenizer
 *   emits that token at the end of the document, so anything after its
 *   start would be part of it.
 *
 * The encoding declaration: in the first two cases, when the head begins
 * with `<meta>` elements (with only whitespace and comments between them)
 * of which one declares the page's character encoding, and only inert ones
 * come before it ({@link metaKind}), the bootstrap goes right after that
 * declaration instead. The encoding prescan looks for the declaration in the
 * first 1024 bytes only, and the bootstrap, which embeds the whole shim, is
 * far longer: before the declaration it would push it out of that window. A
 * `<meta>` runs no script, so the bootstrap is still the first script; the
 * tree is the page's own either way, since the head is open at both
 * positions.
 *
 * Tags inside comments, raw text, RCDATA, attribute values and doctypes are
 * not tags; a leading byte order mark is not text. The replay runner puts a
 * stand-in for the bootstrap at the same position, so the replayed document
 * is built as the recorded one was.
 */
export function bootstrapPosition(html: string): number {
  let at: number | undefined;
  // Once the head's position is known (`head`), the scan goes on over the
  // `<meta>` elements that begin the head, looking for the encoding
  // declaration; anything else ends it, and the position is `head`.
  let head: number | undefined;
  const metaRun = (tag: Tag, from: number): boolean | void => {
    const kind = metaKind(tag);
    if (kind === "declaration") {
      at = tag.stop;
      return false;
    }
    if (kind === "inert") {
      head = from;
      return;
    }
    at = from;
    return false;
  };
  const end = scanTags(
    html,
    (tag) => {
      if (head !== undefined) return metaRun(tag, head);
      if (!tag.terminated) {
        // The tokenizer drops a tag the document ends inside.
        at = tag.start;
        return false;
      }
      if (tag.end) {
        if (!HEAD_IMPLYING_END_TAGS.has(tag.name)) return;
        at = tag.start;
        return false;
      }
      if (tag.name === "html") return;
      if (tag.name === "head") {
        head = tag.stop;
        return;
      }
      // This tag makes the head, and may begin it with `<meta>` elements.
      return metaRun(tag, tag.start);
    },
    {
      text(from, to) {
        for (let k = from; k < to; k++) {
          if (!isSpace(html[k])) {
            at = head ?? k;
            return false;
          }
        }
      },
    },
  );
  if (at !== undefined) return at;
  if (head !== undefined) return head;
  return end.unterminated?.start ?? html.length;
}

/**
 * The bootstrap elements in `html`, as `[start, end)` ranges in document
 * order: each `<script data-codetracer-boundary-shim>` start tag exactly as
 * `bootstrapScript` writes it that the tokenizer sees as a tag (not in a
 * comment, raw text, `<template>` or foreign content), through its
 * `</script>`. Text that only looks like one is the page's, and is left.
 */
export function bootstrapRanges(html: string): [number, number][] {
  const out: [number, number][] = [];
  const startTag = ` ${BOOTSTRAP_MARKER}`;
  scanTags(html, (tag) => {
    if (
      tag.end ||
      tag.nested ||
      tag.name !== "script" ||
      tag.attributes !== startTag ||
      tag.rawTextEnd === undefined
    ) {
      return;
    }
    if (html.startsWith("</script>", tag.rawTextEnd)) {
      out.push([tag.start, tag.rawTextEnd + "</script>".length]);
    }
  });
  return out;
}

/** `html` without the ranges of {@link bootstrapRanges}. */
export function withoutBootstraps(html: string): string {
  const ranges = bootstrapRanges(html);
  if (ranges.length === 0) return html;
  const parts: string[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    parts.push(html.slice(at, start));
    at = end;
  }
  parts.push(html.slice(at));
  return parts.join("");
}

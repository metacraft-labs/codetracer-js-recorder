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
import { asciiLowerCase, encodingLabel } from "./encoding-labels.js";
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
 * How far into a page the encoding prescan looks for the declaration of its
 * character encoding: "the element containing the character encoding
 * declaration must be serialized completely within the first 1024 bytes of
 * the document"
 * (https://html.spec.whatwg.org/multipage/semantics.html#charset), and the
 * prescan may stop there
 * (https://html.spec.whatwg.org/multipage/parsing.html#prescan-a-byte-stream-to-determine-its-encoding).
 */
export const PRESCAN_WINDOW_BYTES = 1024;

/**
 * The value of the bootstrap's marker attribute when a copy of the page's
 * encoding declaration stands right before it ({@link bootstrapPlacement}):
 * the start tag is then `<script data-codetracer-boundary-shim=charset>`,
 * which tells {@link bootstrapRanges} that the `<meta charset>` before it
 * is CodeTracer's, not the page's.
 */
export const DECLARATION_COPY_MARKER_VALUE = "charset";

/** The attribute text of a declaration copy: ` charset=<label>`. */
const COPY_ATTRIBUTES = /^ charset=[A-Za-z0-9._:-]+$/;

/**
 * The encoding a `<meta>` start tag declares, as the encoding prescan reads
 * it (https://html.spec.whatwg.org/multipage/parsing.html#prescan-a-byte-stream-to-determine-its-encoding):
 * the attributes in order, of a name given twice the first; `http-equiv`
 * ASCII case-insensitively `content-type` sets "got pragma"; `content`
 * gives a label by "the algorithm for extracting a character encoding from
 * a meta element" when no charset is set yet, and then needs the pragma;
 * `charset` gives a label (or failure) and needs none. The label is returned
 * as written (trimmed) when it names an encoding of the Encoding Standard;
 * `undefined` when the prescan would go on past this tag.
 *
 * The prescan reads bytes, and would also take a `<meta>` written inside a
 * script's text or a comment-like raw text; a tag here is one the HTML
 * tokenizer sees, as the tree builder (which acts on a declaration it meets
 * in the tree, "change the encoding") and Chromium's own prescan (which runs
 * the tokenizer) do. A page that hides a declaration in raw text is not
 * served by this.
 */
export function declaredEncoding(tag: Tag): string | undefined {
  if (tag.end || tag.name !== "meta" || !tag.terminated) return undefined;
  let gotPragma = false;
  let needPragma: boolean | undefined;
  // `undefined` is the prescan's null; `false` its failure.
  let charset: string | false | undefined;
  for (const [name, value] of tagAttributes(tag.attributes)) {
    if (name === "http-equiv") {
      if (asciiLowerCase(value) === "content-type") gotPragma = true;
    } else if (name === "content") {
      const label = charsetFromContent(value);
      if (label !== undefined && charset === undefined) {
        charset = label;
        needPragma = true;
      }
    } else if (name === "charset") {
      charset = encodingLabel(value) ?? false;
      needPragma = false;
    }
  }
  if (needPragma === undefined) return undefined;
  if (needPragma && !gotPragma) return undefined;
  return charset === false ? undefined : charset;
}

/**
 * "The algorithm for extracting a character encoding from a meta element"
 * (https://html.spec.whatwg.org/multipage/urls-and-fetching.html#algorithm-for-extracting-a-character-encoding-from-a-meta-element)
 * over `content`: the label after the first `charset` followed (after
 * whitespace) by `=`, quoted or up to whitespace or `;`, when it names an
 * encoding.
 */
export function charsetFromContent(content: string): string | undefined {
  const lower = asciiLowerCase(content);
  let position = 0;
  for (;;) {
    const at = lower.indexOf("charset", position);
    if (at < 0) return undefined;
    let k = at + "charset".length;
    while (k < content.length && isSpace(content[k])) k++;
    if (content[k] !== "=") {
      position = at + "charset".length;
      continue;
    }
    k++;
    while (k < content.length && isSpace(content[k])) k++;
    if (k >= content.length) return undefined;
    const q = content[k];
    if (q === '"' || q === "'") {
      const close = content.indexOf(q, k + 1);
      if (close < 0) return undefined;
      return encodingLabel(content.slice(k + 1, close));
    }
    let stop = k;
    while (
      stop < content.length &&
      !isSpace(content[stop]) &&
      content[stop] !== ";"
    ) {
      stop++;
    }
    return encodingLabel(content.slice(k, stop));
  }
}

/**
 * What a tag is to the rule of {@link bootstrapPlacement} that puts the
 * bootstrap after an encoding declaration:
 *
 * - `"declaration"`: a `<meta>` that declares the page's encoding
 *   ({@link declaredEncoding}) and has no `http-equiv` other than
 *   `content-type`;
 * - `"inert"`: what neither runs script nor changes how the page or the
 *   bootstrap is processed, and whose element the tree builder puts into
 *   the head: a `<meta>` with no `http-equiv` that declares no encoding (a
 *   `name`, `property` or `itemprop` one, or a `charset` naming no
 *   encoding), and `<title>` (its text is RCDATA, its end tag closes it);
 * - `undefined`: anything else. That includes a `<meta>` whose `http-equiv`
 *   is not `content-type` (a Content-Security-Policy, which would then
 *   apply to the bootstrap, or a refresh), whatever else it carries; a
 *   script; a style sheet or `<link>`, whose `load` the shim records and
 *   which holds back the scripts after it; and `<base>`.
 */
function leadKind(tag: Tag): "declaration" | "inert" | undefined {
  if (!tag.terminated || tag.nested) return undefined;
  if (tag.name === "title") return "inert";
  if (tag.end || tag.name !== "meta") return undefined;
  const httpEquiv = tagAttributes(tag.attributes).get("http-equiv");
  if (httpEquiv !== undefined && asciiLowerCase(httpEquiv) !== "content-type") {
    return undefined;
  }
  if (declaredEncoding(tag) !== undefined) return "declaration";
  return httpEquiv === undefined ? "inert" : undefined;
}

/**
 * The UTF-8 length of `html` up to `end` (the page is UTF-8: the deploy
 * step refuses any other); a lone surrogate counts as the three bytes of
 * U+FFFD.
 */
function utf8Length(html: string, end: number): number {
  let bytes = 0;
  for (let k = 0; k < end; k++) {
    const c = html.charCodeAt(k);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (
      c >= 0xd800 &&
      c <= 0xdbff &&
      k + 1 < end &&
      (html.charCodeAt(k + 1) & 0xfc00) === 0xdc00
    ) {
      bytes += 4;
      k++;
    } else bytes += 3;
  }
  return bytes;
}

/** Where the bootstrap goes in a page, and what goes with it. */
export interface BootstrapPlacement {
  /** The position: see {@link bootstrapPlacement}. */
  at: number;
  /**
   * A copy of the page's encoding declaration, `<meta charset=<label>>`, to
   * put right before the bootstrap; absent when none is needed.
   */
  declarationCopy?: string;
}

/**
 * Where the bootstrap goes in `html` (a page without one): the point at
 * which the tree builder has made, or is about to make, the head, so the
 * bootstrap is the first script the parser meets and, but for what comes
 * before the page's encoding declaration (below), the first element of the
 * head.
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
 * The encoding declaration. The encoding prescan looks for the page's
 * declaration in its first 1024 bytes only ({@link PRESCAN_WINDOW_BYTES}),
 * and the bootstrap, which embeds the whole shim, is tens of kilobytes:
 * before the declaration it would push it out of that window. So:
 *
 * - In the first two cases, when the head begins with inert elements
 *   (`<meta>` elements that declare nothing, `<title>`; with only
 *   whitespace and comments between them, {@link leadKind}) followed by a
 *   declaration, the bootstrap goes right after that declaration instead.
 *   None of them runs script, so the bootstrap is still the first script;
 *   the tree is the page's own, since the head is open at both positions.
 * - Otherwise, when the page's declaration (the first `<meta>` the prescan
 *   would take, {@link declaredEncoding}) lies after the position and ends
 *   within the first 1024 bytes of the page, a copy of it,
 *   `<meta charset=<label>>`, goes right before the bootstrap
 *   ({@link BootstrapPlacement.declarationCopy}). The bootstrap stays where
 *   it must, before whatever before the declaration runs script or applies
 *   to it (a script, a style sheet, a Content-Security-Policy), and the
 *   prescan, which takes the first declaration naming an encoding, finds
 *   the copy, which names the page's: the page's encoding is the one it
 *   declared, and its own declaration stays where it was. The copy is never
 *   longer than the declaration (the shortest form of one, with the label
 *   as written), so it ends no later than the declaration did. Nothing is
 *   moved: the page's elements keep their order, and the build hash, taken
 *   without the bootstrap and its copy (§8.1), is the page's. The replay
 *   runner puts the same copy before its stand-in, so the replayed tree is
 *   the recorded one.
 * - A declaration that ends after the first 1024 bytes of the page as it
 *   was given is left alone: the prescan did not find it before either,
 *   and the page's encoding came from elsewhere (the HTTP `Content-Type`,
 *   or the tree builder's "change the encoding" when it meets the
 *   declaration), as it still does. A page with a byte order mark is
 *   decoded by the mark, not the prescan; it is placed by the same rules.
 *
 * Tags inside comments, raw text, RCDATA, attribute values and doctypes are
 * not tags; a leading byte order mark is not text. The replay runner puts a
 * stand-in for the bootstrap at the same position, so the replayed document
 * is built as the recorded one was.
 */
export function bootstrapPlacement(html: string): BootstrapPlacement {
  let at: number | undefined;
  let afterDeclaration = false;
  // Once the head's position is known (`head`), the scan goes on over the
  // inert elements that begin the head, looking for the encoding
  // declaration; anything else ends it, and the position is `head`.
  let head: number | undefined;
  const leadRun = (tag: Tag, from: number): boolean | void => {
    const kind = leadKind(tag);
    if (kind === "declaration") {
      at = tag.stop;
      afterDeclaration = true;
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
      if (head !== undefined) return leadRun(tag, head);
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
      // This tag makes the head, and may begin it with inert elements.
      return leadRun(tag, tag.start);
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
  const position = at ?? head ?? end.unterminated?.start ?? html.length;
  if (afterDeclaration) return { at: position };
  const declaration = pageDeclaration(html);
  if (
    declaration === undefined ||
    declaration.start < position ||
    utf8Length(html, declaration.stop) > PRESCAN_WINDOW_BYTES
  ) {
    return { at: position };
  }
  return {
    at: position,
    declarationCopy: `<meta charset=${declaration.label}>`,
  };
}

/**
 * The page's encoding declaration: the first `<meta>` start tag the
 * tokenizer sees that declares an encoding ({@link declaredEncoding}),
 * wherever it is, with its label when the copy can carry it unquoted (every
 * label of the Encoding Standard can).
 */
function pageDeclaration(
  html: string,
): { start: number; stop: number; label: string } | undefined {
  let found: { start: number; stop: number; label: string } | undefined;
  scanTags(html, (tag) => {
    const label = declaredEncoding(tag);
    if (label === undefined) return;
    if (COPY_ATTRIBUTES.test(` charset=${label}`)) {
      found = { start: tag.start, stop: tag.stop, label };
    }
    return false;
  });
  return found;
}

/**
 * Where the bootstrap goes in `html`: {@link bootstrapPlacement}'s
 * position.
 */
export function bootstrapPosition(html: string): number {
  return bootstrapPlacement(html).at;
}

/**
 * `html` (a page without a bootstrap) with `bootstrap`, a
 * `<script data-codetracer-boundary-shim>` element, placed by
 * {@link bootstrapPlacement}: with a declaration copy before it, its
 * marker attribute says so ({@link DECLARATION_COPY_MARKER_VALUE}), so that
 * {@link withoutBootstraps} removes the copy with it.
 */
export function placeBootstrap(html: string, bootstrap: string): string {
  const { at, declarationCopy } = bootstrapPlacement(html);
  let inserted = bootstrap;
  if (declarationCopy !== undefined) {
    const plain = `<script ${BOOTSTRAP_MARKER}>`;
    if (!bootstrap.startsWith(plain)) {
      throw new Error(`a bootstrap starts with ${plain}`);
    }
    inserted =
      declarationCopy +
      `<script ${BOOTSTRAP_MARKER}=${DECLARATION_COPY_MARKER_VALUE}>` +
      bootstrap.slice(plain.length);
  }
  return html.slice(0, at) + inserted + html.slice(at);
}

/**
 * The bootstrap elements in `html`, as `[start, end)` ranges in document
 * order: each `<script data-codetracer-boundary-shim>` start tag exactly as
 * `bootstrapScript` writes it that the tokenizer sees as a tag (not in a
 * comment, raw text, `<template>` or foreign content), through its
 * `</script>`; and for one whose marker says a declaration copy stands
 * before it (`data-codetracer-boundary-shim=charset`), from that copy, a
 * `<meta charset=<label>>` ending where the script starts. Text that only
 * looks like one is the page's, and is left.
 */
export function bootstrapRanges(html: string): [number, number][] {
  const out: [number, number][] = [];
  const plain = ` ${BOOTSTRAP_MARKER}`;
  const withCopy = ` ${BOOTSTRAP_MARKER}=${DECLARATION_COPY_MARKER_VALUE}`;
  let previous: Tag | undefined;
  scanTags(html, (tag) => {
    const before = previous;
    previous = tag;
    if (
      tag.end ||
      tag.nested ||
      tag.name !== "script" ||
      (tag.attributes !== plain && tag.attributes !== withCopy) ||
      tag.rawTextEnd === undefined ||
      !html.startsWith("</script>", tag.rawTextEnd)
    ) {
      return;
    }
    let start = tag.start;
    if (
      tag.attributes === withCopy &&
      before !== undefined &&
      !before.end &&
      !before.nested &&
      before.name === "meta" &&
      before.terminated &&
      before.stop === tag.start &&
      COPY_ATTRIBUTES.test(before.attributes)
    ) {
      start = before.start;
    }
    out.push([start, tag.rawTextEnd + "</script>".length]);
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

/**
 * The part of the HTML tokenizer
 * (https://html.spec.whatwg.org/multipage/parsing.html#tokenization) that
 * boundary recording needs to find positions in a page's source: tags with
 * their quoted attribute values, comments, doctypes and bogus comments,
 * character data between them, and the end of raw text and RCDATA
 * (`script`, `style`, `textarea`, `title`, `xmp`, `iframe`, `noembed`,
 * `noframes`, and `noscript`, since scripting is enabled). It does not build
 * a tree.
 *
 * One implementation serves both sides of a recording, so that they agree on
 * where things are in a document: the record side places the shim's
 * bootstrap with it (`bootstrapPosition`, `./placement.ts`), and the replay
 * runner places its gates and the bootstrap's stand-in with it
 * (`packages/boundary-replay/src/gates.ts`). It imports nothing, so the
 * replay runner's in-page bundle can carry it.
 *
 * Text is scanned as UTF-16 code units of either a decoded document or a
 * byte-preserving latin1 view of its bytes: every character the tokenizer
 * acts on here is ASCII, and a leading byte order mark is skipped in either
 * form (the decoder removes it before the tokenizer sees the document).
 */

/** Elements whose content is text up to their end tag. */
export const RAW_TEXT: ReadonlySet<string> = new Set([
  "script",
  "style",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "noscript",
  "textarea",
  "title",
]);

/** The tokenizer's whitespace (HTML "ASCII whitespace"). */
export const isSpace = (c: string): boolean =>
  c === " " || c === "\t" || c === "\n" || c === "\f" || c === "\r";

const isAlpha = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");

/** Whether `html` between `from` and `to` holds anything but whitespace. */
export function hasText(html: string, from: number, to: number): boolean {
  for (let k = from; k < to; k++) if (!isSpace(html[k])) return true;
  return false;
}

/**
 * The length of the byte order mark `html` starts with: U+FEFF in a decoded
 * document, the UTF-8 bytes `EF BB BF` in a latin1 view of one; 0 if none.
 */
export function bomLength(html: string): number {
  if (html.startsWith("﻿")) return 1;
  if (html.startsWith("ï»¿")) return 3;
  return 0;
}

/**
 * The attributes of a tag from its {@link Tag.attributes} text, as the
 * tokenizer reads them
 * (https://html.spec.whatwg.org/multipage/parsing.html#before-attribute-name-state):
 * names in lower case, values with their quotes removed (character
 * references are not decoded), and of a name given twice only the first,
 * since the tokenizer drops the later one ("duplicate-attribute").
 */
export function tagAttributes(attributes: string): Map<string, string> {
  const out = new Map<string, string>();
  const n = attributes.length;
  let k = 0;
  while (k < n) {
    const ch = attributes[k];
    if (isSpace(ch) || ch === "/") {
      k++;
      continue;
    }
    // The name: a leading `=` is part of it; it ends at whitespace, `/`,
    // `=` or the end.
    const nameStart = k;
    k++;
    while (
      k < n &&
      !isSpace(attributes[k]) &&
      attributes[k] !== "/" &&
      attributes[k] !== "="
    ) {
      k++;
    }
    const name = attributes.slice(nameStart, k).toLowerCase();
    let j = k;
    while (j < n && isSpace(attributes[j])) j++;
    let value = "";
    if (attributes[j] === "=") {
      j++;
      while (j < n && isSpace(attributes[j])) j++;
      const q = attributes[j];
      if (q === '"' || q === "'") {
        const close = attributes.indexOf(q, j + 1);
        const stop = close < 0 ? n : close;
        value = attributes.slice(j + 1, stop);
        j = close < 0 ? n : close + 1;
      } else {
        const valueStart = j;
        while (j < n && !isSpace(attributes[j])) j++;
        value = attributes.slice(valueStart, j);
      }
      k = j;
    }
    if (!out.has(name)) out.set(name, value);
  }
  return out;
}

/** A start or end tag the tokenizer found. */
export interface Tag {
  end: boolean;
  /** Lower case. */
  name: string;
  /** Where the tag starts (`<`) and ends (after `>`). */
  start: number;
  stop: number;
  /**
   * Whether the tag has its `>`. The tokenizer drops a tag the document
   * ends inside ("EOF in tag"), so such a tag makes no element.
   */
  terminated: boolean;
  /** The text between the name and `>`. */
  attributes: string;
  selfClosing: boolean;
  /**
   * The end of the last tag, comment or doctype before this tag, when only
   * whitespace lies between them; `-1` otherwise.
   */
  afterToken: number;
  /** The start tag right before this tag, if the token before it was one. */
  afterStartTag: string;
  /** Inside `<template>` contents or `<svg>`/`<math>`. */
  nested: boolean;
  /**
   * Whether the tree builder has made the head before this tag: a start
   * tag other than `<html>`, or text that is not whitespace, came before
   * it.
   */
  headMade: boolean;
  /**
   * For a start tag of raw text or RCDATA (outside foreign content): where
   * its end tag starts, or the document's length when it has none.
   */
  rawTextEnd?: number;
}

/** How a scan ended. */
export interface ScanEnd {
  /**
   * The comment, doctype or bogus comment the document ends inside, and
   * where it starts. The tokenizer emits it at the end of the document, so
   * anything appended to the document would be inside it.
   */
  unterminated?: { kind: "comment" | "doctype"; start: number };
}

/** What starts at a {@link Boundary}. */
export type BoundaryNext =
  | "start"
  | "end"
  | "comment"
  | "doctype"
  | "text"
  | "eof";

/**
 * A boundary between two of the tokenizer's tokens, or between a token and
 * character data, or a token and the end of the document: a point where the
 * parser may stop between two insertions, so the place a task can run
 * while the document is parsed. There is none inside raw text or RCDATA
 * (the boundary after a raw text element's start tag and the one before its
 * end tag are inside its text), inside a tag, or inside a run of character
 * data (a `<` that starts no tag is part of the run). With the context the
 * replay runner's gates need (`packages/boundary-replay/src/gates.ts`),
 * read from the tokens before it; the two tree builder modes it reports are
 * approximations that err toward reporting the mode.
 */
export interface Boundary {
  at: number;
  next: BoundaryNext;
  /** The tag's lower-case name when {@link next} is a tag; "" otherwise. */
  name: string;
  /** The start tag that ends at {@link at} (lower case); "" otherwise. */
  afterStartTag: string;
  /** Inside `<template>` contents or `<svg>`/`<math>`. */
  nested: boolean;
  /** As {@link Tag.headMade}: the tree builder has made the head. */
  headMade: boolean;
  /**
   * Whether the tree builder may be "in column group" here: after a
   * `<colgroup>` or `<col>` start tag, until `</colgroup>`,
   * `</table>`, another start tag or text that is not whitespace.
   */
  inColumnGroup: boolean;
  /**
   * Whether the tree builder may be "after body" (or "after after body")
   * here: after a `</body>` or `</html>` end tag, until a start tag or
   * text that is not whitespace.
   */
  afterBody: boolean;
}

/** Optional visitors of {@link scanTags}. */
export interface ScanVisitors {
  /**
   * Character data between tokens, `[from, to)`, outside raw text, RCDATA
   * and every tag (a `<` that starts no tag is text). Returning `false`
   * stops the scan.
   */
  text?(from: number, to: number): boolean | void;
  /**
   * Each {@link Boundary}, in document order, before the token, text or end
   * that starts there is visited. Returning `false` stops the scan.
   */
  boundary?(b: Boundary): boolean | void;
}

/**
 * Walk the tags of `html` in document order, calling `visit` for each;
 * `visit` returning `false` stops the walk.
 */
export function scanTags(
  html: string,
  visit: (tag: Tag) => boolean | void,
  visitors: ScanVisitors = {},
): ScanEnd {
  const bom = bomLength(html);
  let lastTokenEnd = -1;
  let lastStartTag = "";
  // Where the raw text the scan skipped last ends: its end tag starts there.
  let rawEndAt = -1;
  let headMade = false;
  let template = 0;
  let foreign = 0;
  let i = bom;
  const n = html.length;
  const lower = html.toLowerCase();
  const text = (from: number, to: number): boolean =>
    from >= to ||
    visitors.text === undefined ||
    visitors.text(from, to) !== false;
  // Boundaries: `tokenEnd` is where the last token ended when a boundary is
  // owed there (-1 after raw text, whose end tag starts right where its
  // text ends, and after a tag the document ends inside); `lastStartTag`
  // names the start tag that ended there, if one did.
  let tokenEnd = -1;
  let inColumnGroup = false;
  let afterBody = false;
  const boundary = (at: number, next: BoundaryNext, name = ""): boolean =>
    visitors.boundary === undefined ||
    visitors.boundary({
      at,
      next,
      name,
      afterStartTag: at === tokenEnd ? lastStartTag : "",
      nested: template > 0 || foreign > 0,
      headMade,
      inColumnGroup,
      afterBody,
    }) !== false;
  /**
   * Character data `[from, to)` is next: a boundary where it starts, if a
   * token ended there; text that is not whitespace leaves the modes the
   * boundaries report.
   */
  const textBoundary = (from: number, to: number): boolean => {
    if (from >= to) return true;
    if (from === tokenEnd && !boundary(from, "text")) return false;
    if (hasText(html, from, to)) {
      inColumnGroup = false;
      afterBody = false;
    }
    return true;
  };

  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      if (!textBoundary(i, n)) return {};
      if (!headMade && hasText(html, i, n)) headMade = true;
      if (!text(i, n)) return {};
      boundary(n, "eof");
      return {};
    }
    // Text between the last token and this one: only whitespace keeps the
    // last token's end as a place a gate may go.
    if (lastTokenEnd >= 0) {
      for (let k = lastTokenEnd; k < lt; k++) {
        if (!isSpace(html[k])) {
          lastTokenEnd = -1;
          break;
        }
      }
    }
    if (!textBoundary(i, lt)) return {};
    if (!headMade && hasText(html, i, lt)) headMade = true;
    if (!text(i, lt)) return {};
    const c = html[lt + 1] ?? "";
    if (html.startsWith("<!--", lt)) {
      if (!boundary(lt, "comment")) return {};
      // A comment; `<!-->` and `<!--->` end at once (abrupt closing).
      let end: number;
      if (html.startsWith("<!-->", lt)) end = lt + 5;
      else if (html.startsWith("<!--->", lt)) end = lt + 6;
      else {
        const close = html.indexOf("-->", lt + 4);
        if (close < 0) return { unterminated: { kind: "comment", start: lt } };
        end = close + 3;
      }
      i = end;
      lastTokenEnd = end;
      tokenEnd = end;
      lastStartTag = "";
      continue;
    }
    const end = c === "/";
    if (end && html[lt + 2] === ">") {
      // `</>` emits nothing ("missing-end-tag-name"): neither a tag nor
      // text.
      i = lt + 3;
      lastTokenEnd = i;
      tokenEnd = i;
      lastStartTag = "";
      continue;
    }
    if (
      c === "!" ||
      c === "?" ||
      (end && lt + 2 < n && !isAlpha(html[lt + 2]))
    ) {
      // A doctype, CDATA outside foreign content, or a bogus comment (which
      // `</` followed by anything but a letter or `>` also starts,
      // "invalid-first-character-of-tag-name"): to `>`.
      if (!boundary(lt, "doctype")) return {};
      const gt = html.indexOf(">", lt + 2);
      if (gt < 0) return { unterminated: { kind: "doctype", start: lt } };
      i = gt + 1;
      lastTokenEnd = i;
      tokenEnd = i;
      lastStartTag = "";
      continue;
    }
    const nameStart = end ? lt + 2 : lt + 1;
    if (!isAlpha(html[nameStart] ?? "")) {
      // `<` that starts no tag is text, and so is `</` at the end of the
      // document.
      if (!textBoundary(lt, lt + 1)) return {};
      if (!text(lt, lt + 1)) return {};
      i = lt + 1;
      lastTokenEnd = -1;
      tokenEnd = -1;
      headMade = true;
      continue;
    }
    let k = nameStart;
    while (k < n && !isSpace(html[k]) && html[k] !== "/" && html[k] !== ">")
      k++;
    const name = lower.slice(nameStart, k);
    const attrStart = k;
    // The attributes, to the tag's `>`, as the tokenizer reads them: a
    // quote starts a quoted value (which may hold `>`) only right after an
    // attribute's `=` and any whitespace; elsewhere (in a name, or in an
    // unquoted value such as `title=it's`) it is an ordinary character.
    let selfClosing = false;
    let afterEquals = false;
    while (k < n && html[k] !== ">") {
      const ch = html[k];
      if (afterEquals && (ch === '"' || ch === "'")) {
        const q = html.indexOf(ch, k + 1);
        k = q < 0 ? n : q + 1;
        afterEquals = false;
        continue;
      }
      if (afterEquals && !isSpace(ch)) {
        // An unquoted value: to whitespace or `>`.
        while (k < n && !isSpace(html[k]) && html[k] !== ">") k++;
        afterEquals = false;
        continue;
      }
      if (ch === "=") afterEquals = true;
      else if (ch === "/" && html[k + 1] === ">") selfClosing = true;
      k++;
    }
    const stop = Math.min(n, k + 1);
    const rawText = !end && RAW_TEXT.has(name) && foreign === 0;
    let rawTextEnd: number | undefined;
    if (rawText) {
      // Text to the matching end tag (`</name` then whitespace, `/` or `>`).
      let close = stop;
      for (;;) {
        close = lower.indexOf(`</${name}`, close);
        if (close < 0) {
          close = n;
          break;
        }
        const after = html[close + 2 + name.length] ?? ">";
        if (isSpace(after) || after === "/" || after === ">") break;
        close += 2;
      }
      rawTextEnd = close;
    }
    // The boundary before the tag: none before the end tag of raw text
    // (`tokenEnd` is -1 there, and no text was visited), which is inside
    // that text.
    if (rawEndAt !== lt && !boundary(lt, end ? "end" : "start", name)) {
      return {};
    }
    const tag: Tag = {
      end,
      name,
      start: lt,
      stop,
      terminated: k < n,
      attributes: html.slice(attrStart, k),
      selfClosing,
      afterToken: lastTokenEnd,
      afterStartTag: lastTokenEnd >= 0 ? lastStartTag : "",
      nested: template > 0 || foreign > 0,
      headMade,
      ...(rawTextEnd !== undefined ? { rawTextEnd } : {}),
    };
    if (visit(tag) === false) return {};
    const outside = template === 0 && foreign === 0;
    if (end) {
      if (name === "template" && template > 0) template--;
      else if ((name === "svg" || name === "math") && foreign > 0) foreign--;
    } else if (name === "template") template++;
    else if ((name === "svg" || name === "math") && !selfClosing) foreign++;
    if (outside) {
      // The modes the boundaries report (approximately; see `Boundary`).
      if (end) {
        if (name === "colgroup" || name === "table") inColumnGroup = false;
        if (name === "body" || name === "html") afterBody = true;
      } else {
        inColumnGroup =
          name === "colgroup" ||
          name === "col" ||
          (inColumnGroup && name === "template");
        afterBody = false;
      }
    }
    i = stop;
    lastTokenEnd = stop;
    // A tag the document ends inside makes nothing, and no boundary
    // follows it.
    tokenEnd = tag.terminated ? stop : -1;
    lastStartTag = end ? "" : name;
    if (!end && name !== "html") headMade = true;
    if (rawTextEnd !== undefined) {
      i = rawTextEnd;
      lastTokenEnd = -1;
      tokenEnd = -1;
      rawEndAt = rawTextEnd;
    }
  }
  // The document ended right after a token (not inside raw text, which
  // leaves `tokenEnd` at -1).
  if (tokenEnd === n) boundary(n, "eof");
  return {};
}

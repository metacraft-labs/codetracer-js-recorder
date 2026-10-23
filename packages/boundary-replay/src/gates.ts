/**
 * The replayed document's gates (CodeTracer's JS-Boundary-Recording
 * specification §6, "The document's own tasks"): the points at which the
 * replay holds the document's own loading, so that a task recorded while
 * the document loaded runs on replay where it ran on record.
 *
 * - **Parser gates.** Before every start tag the parser will turn into an
 *   element, the runner inserts one inline classic script,
 *   `<script data-ct-replay-gate>__ctReplay.gate()</script>`. When the
 *   parser reaches it, the replay runtime compares the document's position
 *   with the `Loading` record at the cursor; when they are equal it writes
 *   a parser-blocking external script (`document.write`), whose request the
 *   runner holds until the scheduler has released the tasks recorded at
 *   that position. Otherwise it does nothing. Either way it removes itself.
 * - **`DOMContentLoaded` and `load` gates.** A `defer` script and an `async`
 *   script at the end of the document, held by the runner until the log's
 *   `DocTask` says the document dispatched the event: `DOMContentLoaded` is
 *   dispatched only after every `defer` script has run, and `load` only
 *   after every `async` script of the parser's has run (HTML, "The end").
 *
 * The gate scripts are CodeTracer's: they carry `data-ct-replay-gate`, are
 * never counted in a document position, and `dom-v1` leaves every
 * `<script>` out (§7.3). Every parser gate takes every gate script out of
 * the document as it runs (one out of the document still runs, and still
 * holds the parser or its event), so the page's own code never meets one;
 * the replay shim leaves them out of the page's `MutationObserver` records.
 *
 * Where a gate goes, so that the gated document is the recorded one once
 * the gates are gone:
 *
 * - Only before a start tag, and only where the token before it is a tag,
 *   a comment or a doctype, with nothing but whitespace between them; the
 *   gate goes right after that token, so it is never in the middle of
 *   text (a gate takes itself out of the document before the parser reads
 *   on, so text after it joins the text before it anyway; this keeps the
 *   positions to the ones the tree builder treats alike).
 * - The tests (`tests/boundary/gates.test.ts`) hold a set of documents the
 *   tree builder treats specially to "the same tree with and without
 *   gates", in real Chromium.
 * - Not before the tree builder has a `<head>`: in the "initial",
 *   "before html" and "before head" insertion modes a script implies
 *   `<html>` and `<head>` early (losing the tags' attributes), and the
 *   whitespace after it, which those modes drop, becomes a text node of the
 *   head. So no gate goes before the first start tag other than `<html>`
 *   or the first text (each makes the head), except the one stand-in below.
 * - At protocol level 0 the recorded page had the record bootstrap at the
 *   start of its head (`@codetracer/boundary-shim` `bootstrapPosition`),
 *   and a page without a `<head>` tag had its head implied there, early:
 *   the replayed page gets a gate at that same position
 *   (`GateOptions.bootstrapAt`), so its tree is the recorded one.
 * - Not before `<col>`: a script ends
 *   the column group it would be in, and the `<col>` then implies another;
 *   nor right after `<pre>` or `<listing>`, whose first newline the parser
 *   drops only when it comes first; not inside raw text or RCDATA
 *   (`script`, `style`, `textarea`, `title`, `xmp`, `iframe`, `noembed`,
 *   `noframes`, and `noscript` since scripting is enabled), `<template>`
 *   contents (inert, and cloned by pages), or `<svg>`/`<math>` (foreign
 *   content, where a `<script>` is an SVG script); and never in a
 *   frameset document or after `<plaintext>`.
 *
 * The tokenizer below is the part of the HTML tokenizer
 * (https://html.spec.whatwg.org/multipage/parsing.html#tokenization) that
 * finds those positions: tags with their quoted attribute values,
 * comments, doctypes and bogus comments, and the end of raw text. It does
 * not build a tree; the elements the tree builder makes from a start tag
 * are the browser's business, and a position the gates cannot reach is a
 * typed divergence on replay, never a wrong trace.
 */

import type { BoundaryRecord } from "@codetracer/boundary-format";
import { REPLAY_GATE_MARKER } from "@codetracer/boundary-shim/dist/browser/document-progress.js";

/** The marker attribute of a gate, which a document position never counts. */
export const GATE_MARKER = REPLAY_GATE_MARKER;

/** The path prefix of the runner's held gate requests. */
export const GATE_PATH = "/__ct-replay/";

/** An inline parser gate. */
export const PARSER_GATE = `<script ${GATE_MARKER}>__ctReplay.gate()</script>`;

/** The `DOMContentLoaded` gate (a `defer` script). */
export const DCL_GATE = `<script ${GATE_MARKER} defer src="${GATE_PATH}dcl"></script>`;

/** The `load` gate (an `async` script). */
export const LOAD_GATE = `<script ${GATE_MARKER} async src="${GATE_PATH}load"></script>`;

/** Elements whose content is text up to their end tag. */
const RAW_TEXT = new Set([
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

/** Which gates to put into a document. */
export interface GateOptions {
  /** Parser gates (the log has a `Loading` record of phase 1). */
  parser: boolean;
  /** The `DOMContentLoaded` gate (the log has its `DocTask`). */
  domContentLoaded: boolean;
  /** The `load` gate (the log has its `DocTask`). */
  load: boolean;
  /**
   * Level 0: where the record bootstrap stood in the recorded document
   * (`bootstrapPosition` of the document as served); a gate goes there
   * whatever else is asked, standing in for it (see the module comment).
   */
  bootstrapAt?: number;
}

/** What {@link insertGates} did. */
export interface GatedDocument {
  html: string;
  /** Parser gates inserted. */
  parserGates: number;
  /** Why no gate at all was inserted, when none was. */
  skipped?: string;
}

const isSpace = (c: string) =>
  c === " " || c === "\t" || c === "\n" || c === "\f" || c === "\r";
const isAlpha = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");

/** Whether `html` between `from` and `to` holds anything but whitespace. */
function hasText(html: string, from: number, to: number): boolean {
  for (let k = from; k < to; k++) if (!isSpace(html[k])) return true;
  return false;
}

/** A start or end tag the tokenizer found. */
interface Tag {
  end: boolean;
  /** Lower case. */
  name: string;
  /** Where the tag starts (`<`) and ends (after `>`). */
  start: number;
  stop: number;
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
}

/**
 * Walk the tags of `html` (see the module comment), calling `visit` for
 * each; `visit` returning `false` stops the walk.
 */
function scanTags(html: string, visit: (tag: Tag) => boolean | void): void {
  let lastTokenEnd = -1;
  let lastStartTag = "";
  let headMade = false;
  let template = 0;
  let foreign = 0;
  let i = 0;
  const n = html.length;
  const lower = html.toLowerCase();

  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) return;
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
    if (!headMade && lastTokenEnd < 0 && hasText(html, i, lt)) headMade = true;
    const c = html[lt + 1] ?? "";
    if (html.startsWith("<!--", lt)) {
      // A comment; `<!-->` and `<!--->` end at once (abrupt closing).
      let end: number;
      if (html.startsWith("<!-->", lt)) end = lt + 5;
      else if (html.startsWith("<!--->", lt)) end = lt + 6;
      else {
        const close = html.indexOf("-->", lt + 4);
        end = close < 0 ? n : close + 3;
      }
      i = end;
      lastTokenEnd = end;
      lastStartTag = "";
      continue;
    }
    if (c === "!" || c === "?") {
      // A doctype, CDATA outside foreign content, or a bogus comment: to `>`.
      const gt = html.indexOf(">", lt + 2);
      i = gt < 0 ? n : gt + 1;
      lastTokenEnd = i;
      lastStartTag = "";
      continue;
    }
    const end = c === "/";
    const nameStart = end ? lt + 2 : lt + 1;
    if (!isAlpha(html[nameStart] ?? "")) {
      // `<` that starts no tag is text.
      i = lt + 1;
      lastTokenEnd = -1;
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
    const tag: Tag = {
      end,
      name,
      start: lt,
      stop,
      attributes: html.slice(attrStart, k),
      selfClosing,
      afterToken: lastTokenEnd,
      afterStartTag: lastTokenEnd >= 0 ? lastStartTag : "",
      nested: template > 0 || foreign > 0,
      headMade,
    };
    if (visit(tag) === false) return;
    if (end) {
      if (name === "template" && template > 0) template--;
      else if ((name === "svg" || name === "math") && foreign > 0) foreign--;
    } else if (name === "template") template++;
    else if ((name === "svg" || name === "math") && !selfClosing) foreign++;
    i = stop;
    lastTokenEnd = stop;
    lastStartTag = end ? "" : name;
    if (!end && name !== "html") headMade = true;
    if (!end && RAW_TEXT.has(name) && foreign === 0) {
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
      i = close;
      lastTokenEnd = -1;
    }
  }
}

/** The value of attribute `name` in a tag's attribute text, if present. */
function attribute(attributes: string, name: string): string | undefined {
  const re = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (let m = re.exec(attributes); m !== null; m = re.exec(attributes)) {
    if (m[1].toLowerCase() === name) {
      return decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
    }
  }
  return undefined;
}

/** The character references an attribute value usually carries. */
function decodeEntities(s: string): string {
  return s.replace(
    /&(amp|quot|apos|lt|gt|#\d+|#x[0-9a-f]+);/gi,
    (m, e: string) => {
      const lowerE = e.toLowerCase();
      if (lowerE === "amp") return "&";
      if (lowerE === "quot") return '"';
      if (lowerE === "apos") return "'";
      if (lowerE === "lt") return "<";
      if (lowerE === "gt") return ">";
      const code =
        lowerE[1] === "x"
          ? parseInt(lowerE.slice(2), 16)
          : parseInt(lowerE.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    },
  );
}

/**
 * The URLs of the external scripts the parser of `html` (fetched from
 * `documentUrl`) will insert: each `<script src>` outside `<template>`
 * contents and foreign content, resolved against the document's base URL
 * when the parser reaches it (its first `<base href>`, if one came before),
 * without the fragment.
 */
export function parserScriptUrls(html: string, documentUrl: string): string[] {
  let base = documentUrl;
  let baseSeen = false;
  const out: string[] = [];
  scanTags(html, (tag) => {
    if (tag.end || tag.nested) return;
    if (tag.name === "base" && !baseSeen) {
      const href = attribute(tag.attributes, "href");
      if (href !== undefined) {
        baseSeen = true;
        try {
          base = new URL(href, documentUrl).href;
        } catch {
          // An unusable base is ignored, as the browser ignores it.
        }
      }
    }
    if (tag.name === "script") {
      // A script is fetched when the parser reaches it, against the base
      // URL of that moment: a `<base>` after it does not apply.
      const src = attribute(tag.attributes, "src");
      if (src === undefined) return;
      try {
        out.push(new URL(src, base).href.split("#")[0]);
      } catch {
        // A script with an unusable URL fires `error` without a request.
      }
    }
  });
  return out;
}

/** Insert the gates `options` asks for into the document `html`. */
export function insertGates(html: string, options: GateOptions): GatedDocument {
  const standIn = options.bootstrapAt;
  if (
    !options.parser &&
    !options.domContentLoaded &&
    !options.load &&
    standIn === undefined
  ) {
    return { html, parserGates: 0 };
  }
  const inserts: number[] = [];
  let skipped: string | undefined;
  let plaintext = false;
  scanTags(html, (tag) => {
    if (tag.end) return;
    if (tag.name === "frameset") {
      skipped = "a frameset document has no body for the gates";
      return false;
    }
    if (
      options.parser &&
      tag.afterToken >= 0 &&
      !tag.nested &&
      // The stand-in, where there is one, made the head already.
      (tag.headMade || (standIn !== undefined && tag.afterToken >= standIn)) &&
      tag.name !== "html" &&
      tag.name !== "head" &&
      tag.name !== "col" &&
      tag.afterStartTag !== "pre" &&
      tag.afterStartTag !== "listing"
    ) {
      inserts.push(tag.afterToken);
    }
    if (tag.name === "plaintext") {
      // Everything after it is text: no more gates, and the event gates
      // would be text too.
      skipped = "<plaintext> makes the rest of the document text";
      plaintext = true;
      return false;
    }
  });
  if (skipped !== undefined && !plaintext) {
    return { html, parserGates: 0, skipped };
  }
  if (standIn !== undefined) {
    // The bootstrap's position (a parser gate may be there already).
    if (!inserts.includes(standIn)) inserts.push(standIn);
    inserts.sort((a, b) => a - b);
  }
  let out = splice(html, inserts, PARSER_GATE);
  if (!plaintext) {
    // The event gates go last, where the parser appends them to the body,
    // followed by a parser gate, which takes them out of the document before
    // any later page code could see them (they still run, and still hold
    // their events).
    if (options.domContentLoaded) out += DCL_GATE;
    if (options.load) out += LOAD_GATE;
    if (options.domContentLoaded || options.load) out += PARSER_GATE;
  }
  return {
    html: out,
    parserGates: options.parser ? inserts.length : 0,
    ...(skipped !== undefined ? { skipped } : {}),
  };
}

/** `html` with `text` inserted at each of the ascending `positions`. */
function splice(html: string, positions: number[], text: string): string {
  if (text === "" || positions.length === 0) return html;
  const parts: string[] = [];
  let at = 0;
  for (const p of positions) {
    parts.push(html.slice(at, p), text);
    at = p;
  }
  parts.push(html.slice(at));
  return parts.join("");
}

/**
 * The name of the function the runner exposes to the replayed page to let
 * a held resource go (`ReplayConfig.binding`); the runtime removes it from
 * the window before any page code runs.
 */
export const OPEN_BINDING = "__ctReplayLetGo";

/** What a log asks the runner to hold of the document's loading. */
export interface DocumentPlan {
  /** Whether anything is held (and so the page needs {@link OPEN_BINDING}). */
  holds: boolean;
  /** The gates the first document gets. */
  gates: GateOptions;
  /**
   * Whether a request for the script at `url` (no fragment) is one to hold:
   * as many requests of each script are held as the log has executions of
   * it (`DocTask` 1); any other runs as it arrives (one that ran before the
   * recorder started, or a module's dependency, which is not an element).
   */
  takeScript(url: string): boolean;
}

/** {@link DocumentPlan} of a decoded log. */
export function documentPlan(records: readonly BoundaryRecord[]): DocumentPlan {
  const scripts = new Map<string, number>();
  let parser = false;
  let domContentLoaded = false;
  let load = false;
  for (const r of records) {
    if (r.record === "Loading" && r.phase === 1) parser = true;
    if (r.record !== "DocTask") continue;
    if (r.kind === 1 || r.kind === 4) {
      scripts.set(r.src, (scripts.get(r.src) ?? 0) + 1);
    } else if (r.kind === 2) domContentLoaded = true;
    else if (r.kind === 3) load = true;
  }
  return {
    holds: parser || domContentLoaded || load || scripts.size > 0,
    gates: { parser, domContentLoaded, load },
    takeScript(url) {
      const left = scripts.get(url) ?? 0;
      if (left === 0) return false;
      scripts.set(url, left - 1);
      return true;
    },
  };
}

/**
 * The runner's held requests, by key (`gate/<n>`, `dcl`, `load`,
 * `script:<url>`): {@link hold} resolves when the page lets that key go; a
 * key let go before its request arrived is answered at once when it does.
 */
export class HeldResources {
  private readonly keys = new Map<
    string,
    { waiting: (() => void)[]; credit: number }
  >();

  private entry(key: string) {
    let e = this.keys.get(key);
    if (e === undefined) {
      e = { waiting: [], credit: 0 };
      this.keys.set(key, e);
    }
    return e;
  }

  /** Resolve when `key` is let go. */
  hold(key: string): Promise<void> {
    const e = this.entry(key);
    if (e.credit > 0) {
      e.credit--;
      return Promise.resolve();
    }
    return new Promise((resolve) => e.waiting.push(resolve));
  }

  /**
   * Let the requests of `key` held now go (a script's preload and its
   * element's request are one execution), or the next one to come.
   */
  open(key: string): void {
    const e = this.entry(key);
    if (e.waiting.length === 0) {
      e.credit++;
      return;
    }
    for (const next of e.waiting.splice(0)) next();
  }
}

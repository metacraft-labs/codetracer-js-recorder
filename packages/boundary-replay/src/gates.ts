/**
 * The replayed document's gates (CodeTracer's JS-Boundary-Recording
 * specification §6, "The document's own tasks"): the points at which the
 * replay holds the document's own loading, so that a task recorded while
 * the document loaded runs on replay where it ran on record.
 *
 * - **Parser gates.** At every boundary between two of the tokenizer's
 *   tokens (a tag, a comment, a doctype), between a token and the character
 *   data after or before it, and at the end of the document, where it is
 *   safe (below), the runner inserts one inline classic script,
 *   `<script data-ct-replay-gate>__ctReplay.gate()</script>`. When the
 *   parser reaches it, the replay runtime compares the document's position
 *   (its elements, scripts and text) with the `Loading` record at the
 *   cursor; when they are equal it writes a parser-blocking external script
 *   (`document.write`), whose request the runner holds until the scheduler
 *   has released the tasks recorded at that position. Otherwise it does
 *   nothing. Either way it removes itself. These are the points between
 *   which the parser inserts nodes (Chromium's parser yields between
 *   tokens), so the replay can hold it wherever the recording could have
 *   seen it, but inside a run of text, which a network that delivered the
 *   document in pieces may have cut: a typed divergence.
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
 * - Only at a boundary (`Boundary`, `html-scan.ts`): never inside a run of
 *   character data, raw text or RCDATA, or a tag. A gate before a whole run
 *   of text, or after one, leaves the run whole: in "in table" the tree
 *   builder decides whether to foster-parent a run by all of its characters,
 *   which a gate inside it would split.
 * - Where the tree builder may be "in column group", only right before a
 *   start tag (which leaves that mode, as the gate's `<script>` would) or
 *   at the end: a `<script>` there ends the column group, so whitespace
 *   after it would go to the table. Where it may be "after body", not when
 *   a comment follows before the next `</body>` or `</html>`, start tag,
 *   text or the end: a `<script>` there switches to "in body", so that
 *   comment would go to the body instead of the `<html>` element.
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
 *   start of its head (`@codetracer/boundary-shim` `bootstrapPosition`:
 *   after the page's `<head>` tag, or where the tree builder implies the
 *   head, the bootstrap implying it there): the replayed page gets a gate at
 *   that same position (`GateOptions.bootstrapAt`), so its tree is the
 *   recorded one and replay can hold the parser where the recording could
 *   first have stopped. When the bootstrap had a copy of the page's
 *   encoding declaration before it (`bootstrapPlacement`), the same copy
 *   goes before the gate (`GateOptions.declarationCopy`): the copy is an
 *   element of the recorded tree, which the gate, taking itself out, is not.
 * - Not before `<col>` (or `<template>` in a column group): a script ends
 *   the column group it would be in, and the `<col>` then implies another;
 *   nor right after `<pre>` or `<listing>`, whose first newline the parser
 *   drops only when it comes first; not inside raw text or RCDATA
 *   (`script`, `style`, `textarea`, `title`, `xmp`, `iframe`, `noembed`,
 *   `noframes`, and `noscript` since scripting is enabled), `<template>`
 *   contents (inert, and cloned by pages), or `<svg>`/`<math>` (foreign
 *   content, where a `<script>` is an SVG script); and never in a
 *   frameset document or after `<plaintext>`.
 *
 * The positions are found with the part of the HTML tokenizer
 * (https://html.spec.whatwg.org/multipage/parsing.html#tokenization) in
 * `@codetracer/boundary-shim` (`html-scan.ts`): tags with their quoted
 * attribute values, comments, doctypes and bogus comments, and the end of
 * raw text. The record side places the bootstrap with the same scanner, so
 * the two agree on where things are. It does not build a tree; the elements the tree builder makes from a start tag
 * are the browser's business, and a position the gates cannot reach is a
 * typed divergence on replay, never a wrong trace.
 */

import type { BoundaryRecord } from "@codetracer/boundary-format";
import { REPLAY_GATE_MARKER } from "@codetracer/boundary-shim/dist/browser/document-progress.js";
import { resolveLoggedUrl } from "@codetracer/boundary-shim/dist/browser/scrub.js";
import {
  type Boundary,
  scanTags,
} from "@codetracer/boundary-shim/dist/html-scan.js";

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
  /**
   * Level 0: the copy of the page's encoding declaration the record
   * bootstrap had before it (`bootstrapPlacement`), put right before the
   * stand-in; only with {@link bootstrapAt}.
   */
  declarationCopy?: string;
}

/** What {@link insertGates} did. */
export interface GatedDocument {
  html: string;
  /** Parser gates inserted. */
  parserGates: number;
  /** Why no gate at all was inserted, when none was. */
  skipped?: string;
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
  const boundaries: Boundary[] = [];
  let skipped: string | undefined;
  let plaintext = false;
  scanTags(
    html,
    (tag) => {
      if (tag.end) return;
      if (tag.name === "frameset") {
        skipped = "a frameset document has no body for the gates";
        return false;
      }
      if (tag.name === "plaintext") {
        // Everything after it is text: no more gates, and the event gates
        // would be text too.
        skipped = "<plaintext> makes the rest of the document text";
        plaintext = true;
        return false;
      }
    },
    {
      boundary(b) {
        // In document order, each offset once.
        boundaries.push(b);
      },
    },
  );
  if (skipped !== undefined && !plaintext) {
    return { html, parserGates: 0, skipped };
  }
  if (options.parser) {
    boundaries.forEach((b, i) => {
      if (gateGoesAt(b, standIn, () => commentInBodyMode(boundaries, i))) {
        inserts.push(b.at);
      }
    });
  }
  if (standIn !== undefined) {
    // The bootstrap's position (a parser gate may be there already).
    if (!inserts.includes(standIn)) inserts.push(standIn);
    inserts.sort((a, b) => a - b);
  }
  let out = splice(html, inserts, (p) =>
    p === standIn && options.declarationCopy !== undefined
      ? options.declarationCopy + PARSER_GATE
      : PARSER_GATE,
  );
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

/**
 * Whether a comment comes after boundary `boundaries[i]`, where the tree
 * builder may be "after body", before anything takes it back to that mode or
 * makes the mode not matter: a gate's `<script>` there switches it to "in
 * body", and a comment the parser meets in "in body" goes to the body, where
 * "after body" puts it on the `<html>` element ("after after body": on the
 * document). The next `</body>` or `</html>` switches back; a start tag or
 * text that is not whitespace would have switched to "in body" anyway; at the
 * end nothing follows.
 * https://html.spec.whatwg.org/multipage/parsing.html#parsing-main-afterbody
 */
function commentInBodyMode(
  boundaries: readonly Boundary[],
  i: number,
): boolean {
  for (let j = i; j < boundaries.length; j++) {
    const b = boundaries[j];
    if (j > i && !b.afterBody) return false;
    if (b.next === "comment") return true;
    if (b.next === "start" || b.next === "eof") return false;
    if (b.next === "end" && (b.name === "body" || b.name === "html")) {
      return false;
    }
  }
  return false;
}

/**
 * Whether a parser gate goes at boundary `b` (see the module comment);
 * `standIn` is where the bootstrap's stand-in goes, which makes the head;
 * `commentAhead` says whether a comment follows in "after body" mode
 * ({@link commentInBodyMode}), asked only there.
 */
function gateGoesAt(
  b: Boundary,
  standIn: number | undefined,
  commentAhead: () => boolean,
): boolean {
  if (b.nested) return false;
  if (!b.headMade && (standIn === undefined || b.at < standIn)) return false;
  // The newline right after `<pre>` or `<listing>` is dropped only when
  // it is the next token.
  if (b.afterStartTag === "pre" || b.afterStartTag === "listing") {
    return false;
  }
  if (
    b.next === "start" &&
    (b.name === "html" || b.name === "head" || b.name === "col")
  ) {
    return false;
  }
  if (b.inColumnGroup) {
    // Whitespace or a comment after a gate here would leave the column
    // group; a start tag other than `<col>` and `<template>` leaves it
    // anyway.
    if (b.next === "eof") return true;
    return b.next === "start" && b.name !== "template";
  }
  if (b.afterBody) return !commentAhead();
  return true;
}

/** `html` with `text(p)` inserted at each of the ascending `positions` `p`. */
function splice(
  html: string,
  positions: number[],
  text: (position: number) => string,
): string {
  if (positions.length === 0) return html;
  const parts: string[] = [];
  let at = 0;
  for (const p of positions) {
    parts.push(html.slice(at, p), text(p));
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
  /**
   * Whether a request for the resource at `url` (no fragment) is one to
   * hold until its element's event comes due: as many requests of each are
   * held as the log has `load` or `error` events reporting on it (`DocTask`
   * 5 with that `src`; a media element's events have none, §6).
   */
  takeResource(url: string): boolean;
  /**
   * The URL the log names the request for `url` (no fragment) by: the log
   * holds a script's or a resource's URL scrubbed (§11.3.5), so a request
   * is looked up by the logged URL it matches (`resolveLoggedUrl`).
   */
  loggedUrl(url: string): string;
}

/** {@link DocumentPlan} of a decoded log. */
export function documentPlan(records: readonly BoundaryRecord[]): DocumentPlan {
  const scripts = new Map<string, number>();
  const resources = new Map<string, number>();
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
    else if (r.kind === 5 && r.src !== "") {
      resources.set(r.src, (resources.get(r.src) ?? 0) + 1);
    }
  }
  const take = (counts: Map<string, number>, url: string): boolean => {
    const left = counts.get(url) ?? 0;
    if (left === 0) return false;
    counts.set(url, left - 1);
    return true;
  };
  const logged = new Set([...scripts.keys(), ...resources.keys()]);
  return {
    loggedUrl: (url) => resolveLoggedUrl(logged, url),
    holds:
      parser ||
      domContentLoaded ||
      load ||
      scripts.size > 0 ||
      resources.size > 0,
    gates: { parser, domContentLoaded, load },
    takeScript: (url) => take(scripts, url),
    takeResource: (url) => take(resources, url),
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

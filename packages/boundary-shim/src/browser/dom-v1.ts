/**
 * The `dom-v1` checkpoint scheme (JS-Boundary-Recording.md §7.3): SHA-256
 * over a canonical serialisation of the document.
 *
 * The serialisation is one line per token, in document order, starting at
 * `document.documentElement`:
 *
 * ```text
 * E["<localName>", [["<attr name>", "<value>"], …]]   an element; attributes sorted by name
 * V["<value>", <checked>]                              after the E line of every input, textarea and select
 * T"<data>"                                            a text node (CDATA included)
 * /                                                    the end of an element's children
 * ```
 *
 * each JSON-encoded and terminated by `\n`, hashed as UTF-8. `<script>`
 * elements are left out whole (element, attributes and contents): the
 * recorder's own bootstrap is a `<script>` on record and is installed by
 * `addInitScript` on replay, so including script elements would make every
 * checkpoint of a recorded page differ from its replay. Comments,
 * processing instructions, shadow roots, `<template>` contents and frame
 * documents are not part of the scheme.
 *
 * A sensitive field (§11.3.1) contributes the hole token (§5.2.1) in place
 * of its value: an `input`'s, `textarea`'s or `select`'s `V` line holds
 * the token, so does its `value` attribute, a sensitive `textarea` and a
 * sensitive editing host (`contenteditable`) hold one `T` line with the
 * token in place of their children. So a checkpoint is the same whatever was
 * typed there, the visitor's secret on record and the placeholder on
 * replay, and its hash carries nothing of it.
 *
 * The same function is used on record and replay (and by the tests), so the
 * scheme has one implementation.
 */

import { HOLE_TOKEN } from "@codetracer/boundary-format";

import {
  internally,
  isEditingHostOrInside,
  isSensitive,
  type SensitiveState,
  sensitiveState,
} from "./sensitive.js";
import { sha256Hex } from "./sha256.js";

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const CDATA_SECTION_NODE = 4;

/** The canonical `dom-v1` serialisation of `doc` (see the module comment). */
export function domV1Serialise(doc: Document): string {
  const out: string[] = [];
  const root = doc.documentElement;
  const w = doc.defaultView as (Window & typeof globalThis) | null;
  if (root === null) return "";
  if (w === null) {
    walk(root, out, undefined);
  } else {
    // The recorder's and the runtime's own reads: not the page's (§7.2).
    const s = sensitiveState(w);
    internally(s, () => walk(root, out, s));
  }
  return out.join("");
}

/** The `dom-v1` state hash of `doc`: lowercase hex SHA-256 of its serialisation. */
export function domV1Hash(doc: Document): string {
  return sha256Hex(domV1Serialise(doc));
}

function walk(el: Element, out: string[], s: SensitiveState | undefined): void {
  const name = el.localName;
  if (name === "script") return;
  const sensitive = s !== undefined && isSensitive(s, el);
  const control = name === "input" || name === "textarea" || name === "select";
  const attrs: [string, string][] = [];
  for (let i = 0; i < el.attributes.length; i++) {
    const a = el.attributes[i];
    // A framework may mirror a field's value into its `value` attribute
    // (its default value): at a sensitive field that is the value too.
    attrs.push([
      a.name,
      sensitive && control && a.name === "value" ? HOLE_TOKEN : a.value,
    ]);
  }
  // Sort by UTF-16 code units, as the default comparison does; locale
  // collation would make the hash depend on the browser's locale.
  attrs.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  out.push("E", JSON.stringify([name, attrs]), "\n");
  if (control) {
    const field = el as HTMLInputElement;
    const checked = name === "input" ? field.checked === true : false;
    const value = sensitive ? HOLE_TOKEN : String(field.value);
    out.push("V", JSON.stringify([value, checked]), "\n");
    if (sensitive && name === "textarea") {
      // Its text (its default value, which a framework may set to the
      // value) is the token, its children unread.
      out.push("T", JSON.stringify(HOLE_TOKEN), "\n", "/\n");
      return;
    }
  } else if (sensitive && isEditingHostOrInside(s, el)) {
    // A sensitive editing host: its text is the token, its children unread.
    out.push("T", JSON.stringify(HOLE_TOKEN), "\n", "/\n");
    return;
  }
  for (let child = el.firstChild; child !== null; child = child.nextSibling) {
    if (child.nodeType === ELEMENT_NODE) {
      walk(child as Element, out, s);
    } else if (
      child.nodeType === TEXT_NODE ||
      child.nodeType === CDATA_SECTION_NODE
    ) {
      out.push("T", JSON.stringify((child as CharacterData).data), "\n");
    }
  }
  out.push("/\n");
}

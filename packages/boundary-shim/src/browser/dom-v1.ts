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
 * The same function is used on record and replay (and by the tests), so the
 * scheme has one implementation.
 */

import { sha256Hex } from "./sha256.js";

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const CDATA_SECTION_NODE = 4;

/** The canonical `dom-v1` serialisation of `doc` (see the module comment). */
export function domV1Serialise(doc: Document): string {
  const out: string[] = [];
  const root = doc.documentElement;
  if (root !== null) walk(root, out);
  return out.join("");
}

/** The `dom-v1` state hash of `doc`: lowercase hex SHA-256 of its serialisation. */
export function domV1Hash(doc: Document): string {
  return sha256Hex(domV1Serialise(doc));
}

function walk(el: Element, out: string[]): void {
  const name = el.localName;
  if (name === "script") return;
  const attrs: [string, string][] = [];
  for (let i = 0; i < el.attributes.length; i++) {
    const a = el.attributes[i];
    attrs.push([a.name, a.value]);
  }
  // Sort by UTF-16 code units, as the default comparison does; locale
  // collation would make the hash depend on the browser's locale.
  attrs.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  out.push("E", JSON.stringify([name, attrs]), "\n");
  if (name === "input" || name === "textarea" || name === "select") {
    const control = el as HTMLInputElement;
    const checked = name === "input" ? control.checked === true : false;
    out.push("V", JSON.stringify([String(control.value), checked]), "\n");
  }
  for (let child = el.firstChild; child !== null; child = child.nextSibling) {
    if (child.nodeType === ELEMENT_NODE) {
      walk(child as Element, out);
    } else if (
      child.nodeType === TEXT_NODE ||
      child.nodeType === CDATA_SECTION_NODE
    ) {
      out.push("T", JSON.stringify((child as CharacterData).data), "\n");
    }
  }
  out.push("/\n");
}

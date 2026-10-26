/**
 * The harness's in-page probe, bundled into `dist/probe.iife.js` and
 * evaluated in the page only after the session has stopped, so nothing it
 * does can be recorded. It answers two questions:
 *
 * - the document's `dom-v1` serialisation, written here from the
 *   specification's sentences (JS-Boundary-Recording §7.3, "`dom-v1`,
 *   exactly") and deliberately sharing no code with the generic shim's
 *   serialiser, which both the shim and the reference framework record
 *   with. The harness hashes it in Node (`node:crypto`), so the
 *   `checkpoints` check compares a recorder's hash with an oracle that
 *   could disagree with it: a serialiser or SHA-256 that drifts from the
 *   scheme fails the check instead of agreeing with itself;
 * - what each target string of the log names now (level 0: the inverse of
 *   the shim's structural paths, whose answer is checked against the
 *   fixture's `data-fx` names; level 1: the framework's own
 *   `record.resolveTarget`).
 */

import { resolveTarget as resolvePath } from "@codetracer/boundary-shim/dist/browser/targets.js";

import { PROTOCOL_GLOBAL, type ProtocolDeclaration } from "../protocol.js";

interface Resolution {
  resolved: boolean;
  fx: string | null;
}

function describe(node: Element | Document | Window | null): Resolution {
  if (node === null || node === undefined) return { resolved: false, fx: null };
  if (node instanceof Element) {
    return { resolved: true, fx: node.getAttribute("data-fx") };
  }
  return { resolved: true, fx: null };
}

/**
 * The `dom-v1` serialisation of the document, as the specification states
 * it: one line per token in document order from `document.documentElement`,
 * each ended by `\n`; an element is `E` and the JSON of
 * `[localName, [[name, value], ...]]` with its attributes sorted by name in
 * UTF-16 code-unit order; an `input`, `textarea` or `select` is followed by
 * `V` and the JSON of `[value, checked]` (`checked` false for all but
 * `input`); then the element's children; then `/`. A text or CDATA node is
 * `T` and the JSON of its data. `<script>` elements are left out whole;
 * comments, processing instructions, shadow roots, `<template>` contents
 * and frame documents are not part of the scheme. A sensitive field's value
 * and `value` attribute are the hole token, and a sensitive `textarea`'s or
 * editing host's text one `T` line of the token in place of its children
 * (§7.3, §11.3.1, §5.2.1).
 */
function domV1Text(): string {
  let text = "";
  const visit = (el: Element): void => {
    if (el.localName === "script") return;
    const hidden = isSensitiveField(el);
    const control =
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement;
    // A sensitive control's `value` attribute (its default value, which a
    // framework may keep equal to the value) is the token too.
    const attributes = Array.from(el.attributes, (a): [string, string] => [
      a.name,
      hidden && control && a.name === "value" ? HOLE : a.value,
    ]);
    // String `<` compares UTF-16 code units; never localeCompare, whose
    // order depends on the browser's locale.
    attributes.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    text += `E${JSON.stringify([el.localName, attributes])}\n`;
    if (el instanceof HTMLInputElement) {
      text += `V${JSON.stringify([hidden ? HOLE : el.value, el.checked])}\n`;
    } else if (
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement
    ) {
      text += `V${JSON.stringify([hidden ? HOLE : el.value, false])}\n`;
      if (hidden && el instanceof HTMLTextAreaElement) {
        text += `T${JSON.stringify(HOLE)}\n/\n`;
        return;
      }
    } else if (hidden && el instanceof HTMLElement && el.isContentEditable) {
      text += `T${JSON.stringify(HOLE)}\n/\n`;
      return;
    }
    for (const child of Array.from(el.childNodes)) {
      if (child instanceof Element) visit(child);
      else if (child instanceof Text) {
        // CDATASection is a Text too.
        text += `T${JSON.stringify(child.data)}\n`;
      }
    }
    text += "/\n";
  };
  if (document.documentElement !== null) visit(document.documentElement);
  return text;
}

/** The hole token (§5.2.1): U+FDD0, `ct:hole`, U+FDD1. */
const HOLE = "\uFDD0ct:hole\uFDD1";

/**
 * Whether `el` is a sensitive field, by §11.3.1 read afresh: a credential
 * field always; then the page's own declaration (`ct.public` /
 * `ct.sensitive`, which the recorders keep in the page's shared
 * sensitive-input state, read here as data); then `data-ct-sensitive`, then
 * `data-ct-public`; then any free-text field. Written from the
 * specification, sharing no code with the recorders' classifier.
 */
function isSensitiveField(el: Element): boolean {
  const name = el.localName;
  const type = (el.getAttribute("type") ?? "text").trim().toLowerCase();
  const tokens = (el.getAttribute("autocomplete") ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/);
  if (name === "input" || name === "textarea") {
    if (name === "input" && type === "password") return true;
    if (
      tokens.some(
        (t) =>
          t.startsWith("cc-") ||
          t === "current-password" ||
          t === "new-password" ||
          t === "one-time-code",
      )
    ) {
      return true;
    }
  }
  const state = (
    globalThis as unknown as Record<
      symbol,
      { marks?: WeakMap<Element, string> } | undefined
    >
  )[Symbol.for("codetracer.boundary.sensitive")];
  const mark = state?.marks?.get(el);
  if (mark !== undefined) return mark === "sensitive";
  if (el.hasAttribute("data-ct-sensitive")) return true;
  if (el.hasAttribute("data-ct-public")) return false;
  if (name === "textarea") return true;
  if (name === "input") return !NOT_TEXT.has(type);
  return (
    el instanceof HTMLElement &&
    el.isContentEditable &&
    !(el.parentElement?.isContentEditable ?? false)
  );
}

/** The `input` types whose value is not free text (HTML's other states). */
const NOT_TEXT = new Set([
  "hidden",
  "date",
  "month",
  "week",
  "time",
  "datetime-local",
  "number",
  "range",
  "color",
  "checkbox",
  "radio",
  "file",
  "submit",
  "image",
  "reset",
  "button",
]);

const probe = {
  domV1Text,
  resolve(targets: string[], level: number): Record<string, Resolution> {
    const out: Record<string, Resolution> = {};
    const decl = (
      globalThis as unknown as Record<string, ProtocolDeclaration | undefined>
    )[PROTOCOL_GLOBAL];
    for (const t of targets) {
      try {
        out[t] = describe(
          level === 1
            ? (decl?.record?.resolveTarget(t) ?? null)
            : resolvePath(t, document),
        );
      } catch {
        out[t] = { resolved: false, fx: null };
      }
    }
    return out;
  },
};

Object.defineProperty(globalThis, "__ctConformanceProbe", {
  value: probe,
  configurable: true,
});

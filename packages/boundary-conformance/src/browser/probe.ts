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
 * and frame documents are not part of the scheme.
 */
function domV1Text(): string {
  let text = "";
  const visit = (el: Element): void => {
    if (el.localName === "script") return;
    const attributes = Array.from(el.attributes, (a): [string, string] => [
      a.name,
      a.value,
    ]);
    // String `<` compares UTF-16 code units; never localeCompare, whose
    // order depends on the browser's locale.
    attributes.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    text += `E${JSON.stringify([el.localName, attributes])}\n`;
    if (el instanceof HTMLInputElement) {
      text += `V${JSON.stringify([el.value, el.checked])}\n`;
    } else if (
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement
    ) {
      text += `V${JSON.stringify([el.value, false])}\n`;
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

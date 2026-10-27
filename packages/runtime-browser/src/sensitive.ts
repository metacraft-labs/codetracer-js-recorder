/**
 * Sensitive inputs (CodeTracer's JS-Boundary-Recording specification
 * §11.3): which fields are sensitive, the shape-preserving placeholders that
 * stand in for their values on replay, the hole token that replaces them in
 * the log's checked fields (§5.2.1), the masking of the events at them
 * (§11.3.3), and the page's API to declare fields and declassifiers, `ct`.
 *
 * One implementation for record and replay, for the generic shim and the
 * reference framework, and for the browser error reporter
 * (`error-report.ts`), which holes the same values in its reports, so a
 * field is sensitive everywhere by the same rule. It lives in this package,
 * below the shim, so that the reporter can use it; the shim re-exports it.
 * Its state (the page's `ct.public` / `ct.sensitive` marks,
 * the platform getters it reads values through, the values seen so far) is
 * kept in one object on the window under a registered symbol
 * ({@link sensitiveState}), because the recorder, the replay shim, the
 * replay runtime and a framework are separate bundles in one page and must
 * share it.
 */

import { HOLE_TOKEN } from "@codetracer/boundary-format";

/** `Scrubbed.class` (§5.2): what kind of value a placeholder must look like. */
export const SensitiveClass = {
  password: 1,
  creditCard: 2,
  email: 3,
  declared: 4,
} as const;

/** The shortest value replaced by a hole at level 0 (§5.2.1). */
export const MIN_HOLED_LENGTH = 4;

/** How many distinct sensitive values a session remembers for holing. */
const MAX_REMEMBERED = 1024;

/**
 * What a raw sensitive read is reported with (§7.2 `cause`): the element's
 * target (§9.3) is found by the caller, which knows the target scheme.
 */
export interface RawSensitiveRead {
  element: Element;
  /** What was read: `value`, `textContent`, `innerText`, or an event property. */
  what: string;
}

/** The state every bundle in the page shares (see the module comment). */
export interface SensitiveState {
  /** `ct.public(el)` and `ct.sensitive(el)`: the page's own declarations. */
  marks: WeakMap<Element, "public" | "sensitive">;
  /**
   * The sensitive values seen in this session, longest first, each at least
   * {@link MIN_HOLED_LENGTH} UTF-16 code units: the value of a sensitive
   * field each time an input event changed it, so a value the page captured
   * and the field no longer holds is still holed when the page sends it.
   */
  remembered: string[];
  /** Fields that received input, which may since have left the document. */
  seen: Set<Element>;
  /**
   * Every shadow root the page attached with `attachShadow`, by its host
   * ({@link trackShadowRoots}): for a closed one, the only way to find the
   * focused field inside it, which an event's composed path hides.
   */
  shadowRoots: WeakMap<Element, ShadowRoot>;
  /** Reads made by the recorder or the runtime themselves, never the page's. */
  internalDepth: number;
  /** Told of each raw read of a sensitive value by the page (replay only). */
  onRawRead: ((read: RawSensitiveRead) => void) | undefined;
  /** The platform's own getters, captured before any page code. */
  readonly getters: {
    inputValue: (this: HTMLInputElement) => string;
    textareaValue: (this: HTMLTextAreaElement) => string;
    textContent: (this: Node) => string | null;
    getAttribute: (this: Element, name: string) => string | null;
    hasAttribute: (this: Element, name: string) => boolean;
    isContentEditable: ((this: HTMLElement) => boolean) | undefined;
    parentElement: (this: Node) => Element | null;
    querySelectorAll: (this: Document, s: string) => NodeListOf<Element>;
    composedPath: ((this: Event) => EventTarget[]) | undefined;
    shadowRoot: ((this: Element) => ShadowRoot | null) | undefined;
    rootActiveElement: ((this: ShadowRoot) => Element | null) | undefined;
  };
}

const STATE = Symbol.for("codetracer.boundary.sensitive");

/** {@link getter}, or `undefined` where the platform lacks the accessor. */
function optionalGetter<T>(
  proto: object | undefined,
  name: string,
): T | undefined {
  if (proto === undefined) return undefined;
  try {
    return getter<T>(proto, name);
  } catch {
    return undefined;
  }
}

function getter<T>(proto: object, name: string): T {
  let p: object | null = proto;
  while (p !== null) {
    const d = Object.getOwnPropertyDescriptor(p, name);
    if (d?.get !== undefined) return d.get as T;
    p = Object.getPrototypeOf(p) as object | null;
  }
  throw new Error(`no ${name} getter`);
}

/**
 * The shared state of `w`'s page, made by whichever bundle asks first; the
 * recorder and the replay runtime both ask before any page code runs, so the
 * getters are the platform's.
 */
export function sensitiveState(w: Window & typeof globalThis): SensitiveState {
  const holder = w as unknown as Record<symbol, SensitiveState | undefined>;
  const existing = holder[STATE];
  if (existing !== undefined) return existing;
  let isContentEditable: SensitiveState["getters"]["isContentEditable"];
  try {
    isContentEditable = getter(w.HTMLElement.prototype, "isContentEditable");
  } catch {
    isContentEditable = undefined;
  }
  const state: SensitiveState = {
    marks: new WeakMap(),
    remembered: [],
    seen: new Set(),
    shadowRoots: new WeakMap(),
    internalDepth: 0,
    onRawRead: undefined,
    getters: {
      inputValue: getter(w.HTMLInputElement.prototype, "value"),
      textareaValue: getter(w.HTMLTextAreaElement.prototype, "value"),
      textContent: getter(w.Node.prototype, "textContent"),
      getAttribute: w.Element.prototype.getAttribute,
      hasAttribute: w.Element.prototype.hasAttribute,
      isContentEditable,
      parentElement: getter(w.Node.prototype, "parentElement"),
      querySelectorAll: w.Document.prototype
        .querySelectorAll as SensitiveState["getters"]["querySelectorAll"],
      composedPath: (
        w.Event.prototype as { composedPath?: (this: Event) => EventTarget[] }
      ).composedPath,
      shadowRoot: optionalGetter(w.Element.prototype, "shadowRoot"),
      rootActiveElement: optionalGetter(
        (w as unknown as { ShadowRoot?: { prototype: object } }).ShadowRoot
          ?.prototype,
        "activeElement",
      ),
    },
  };
  Object.defineProperty(w, STATE, {
    value: state,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return state;
}

/** Run `f` as the recorder or the runtime, not as the page (no raw read is reported). */
export function internally<T>(state: SensitiveState, f: () => T): T {
  state.internalDepth++;
  try {
    return f();
  } finally {
    state.internalDepth--;
  }
}

/** The `input` types whose value is free text (§11.3.1). */
const FREE_TEXT_INPUT_TYPES = new Set([
  "text",
  "search",
  "email",
  "tel",
  "url",
  "password",
]);

function localName(el: Element): string {
  return el.localName;
}

/**
 * An `input`'s type as the platform reads its `type` attribute: lowercase,
 * and `text` when absent or not a known type (HTML, "the type attribute":
 * the missing and invalid value default is the Text state). Only the free
 * text types and the ones that are not text matter here, so an unknown one
 * counts as text.
 */
function inputType(s: SensitiveState, el: Element): string {
  const t = s.getters.getAttribute.call(el, "type");
  return t === null ? "text" : t.trim().toLowerCase();
}

function autocompleteTokens(s: SensitiveState, el: Element): string[] {
  const a = s.getters.getAttribute.call(el, "autocomplete");
  return a === null ? [] : a.trim().toLowerCase().split(/\s+/);
}

/**
 * The credential class of `el`, when it is one the recorder recognises
 * without being told (§11.3.1): an `<input type=password>`, or an
 * `autocomplete` of `current-password`, `new-password` or `one-time-code`
 * (class 1, password), or `cc-*` (class 2, a card). A credential field is
 * always sensitive and can never be made public.
 */
export function credentialClass(
  s: SensitiveState,
  el: Element,
): 1 | 2 | undefined {
  const name = localName(el);
  if (name !== "input" && name !== "textarea") return undefined;
  const tokens = autocompleteTokens(s, el);
  if (tokens.some((t) => t.startsWith("cc-"))) return SensitiveClass.creditCard;
  if (name === "input" && inputType(s, el) === "password") {
    return SensitiveClass.password;
  }
  if (
    tokens.some(
      (t) =>
        t === "current-password" ||
        t === "new-password" ||
        t === "one-time-code",
    )
  ) {
    return SensitiveClass.password;
  }
  return undefined;
}

function isEditingHost(s: SensitiveState, el: Element): boolean {
  const get = s.getters.isContentEditable;
  if (get === undefined) return false;
  try {
    if (!get.call(el as HTMLElement)) return false;
  } catch {
    return false;
  }
  const parent = s.getters.parentElement.call(el);
  if (parent === null) return true;
  try {
    return !get.call(parent as HTMLElement);
  } catch {
    return true;
  }
}

/** Whether `el` is editable text (`contenteditable`): a host or inside one. */
export function isEditingHostOrInside(s: SensitiveState, el: Element): boolean {
  const get = s.getters.isContentEditable;
  if (get === undefined) return false;
  try {
    return get.call(el as HTMLElement);
  } catch {
    return false;
  }
}

/**
 * Whether `el` is a free-text field (§11.3.1): a `textarea`, an editing host
 * of `contenteditable`, or an `input` whose type is absent or one of `text`,
 * `search`, `email`, `tel`, `url`, `password`.
 */
export function isFreeTextField(s: SensitiveState, el: Element): boolean {
  const name = localName(el);
  if (name === "textarea") return true;
  if (name === "input") {
    const t = inputType(s, el);
    return FREE_TEXT_INPUT_TYPES.has(t) || !KNOWN_INPUT_TYPES.has(t);
  }
  return isEditingHost(s, el);
}

/** Every `input` type HTML defines (an unknown one is the Text state). */
const KNOWN_INPUT_TYPES = new Set([
  "hidden",
  "text",
  "search",
  "tel",
  "url",
  "email",
  "password",
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

/**
 * The field an event target belongs to: the element itself when it is an
 * `input`, `textarea` or `select`, the editing host when it is inside a
 * `contenteditable` region, otherwise the element. `null` for no element.
 */
export function fieldOf(s: SensitiveState, target: unknown): Element | null {
  if (target === null || typeof target !== "object") return null;
  const node = target as Node;
  // A window, a media query list, a notification: no field.
  if (typeof node.nodeType !== "number") return null;
  let el: Element | null;
  try {
    el =
      node.nodeType === 1
        ? (node as Element)
        : s.getters.parentElement.call(node);
  } catch {
    return null;
  }
  if (el === null) return null;
  const name = localName(el);
  if (name === "input" || name === "textarea" || name === "select") return el;
  const get = s.getters.isContentEditable;
  if (get === undefined) return el;
  let host: Element | null = null;
  try {
    for (
      let e: Element | null = el;
      e !== null;
      e = s.getters.parentElement.call(e)
    ) {
      if (!get.call(e as HTMLElement)) break;
      host = e;
    }
  } catch {
    host = null;
  }
  return host ?? el;
}

/**
 * Whether `el` is sensitive (§11.3.1). In order: a credential field is; then
 * the page's own call (`ct.sensitive(el)` or `ct.public(el)`, the last one
 * made); then the attributes (`data-ct-sensitive` wins over
 * `data-ct-public`); then every free-text field is (fails closed), and
 * nothing else is.
 */
export function isSensitive(s: SensitiveState, el: Element): boolean {
  if (credentialClass(s, el) !== undefined) return true;
  const mark = s.marks.get(el);
  if (mark !== undefined) return mark === "sensitive";
  if (s.getters.hasAttribute.call(el, "data-ct-sensitive")) return true;
  if (s.getters.hasAttribute.call(el, "data-ct-public")) return false;
  return isFreeTextField(s, el);
}

/** `Scrubbed.class` of a sensitive `el` (§5.2). */
export function sensitiveClass(s: SensitiveState, el: Element): number {
  const c = credentialClass(s, el);
  if (c !== undefined) return c;
  if (
    (localName(el) === "input" && inputType(s, el) === "email") ||
    autocompleteTokens(s, el).includes("email")
  ) {
    return SensitiveClass.email;
  }
  return SensitiveClass.declared;
}

/**
 * Whether `el` is a field that holds a value the user types or picks: an
 * `input`, a `textarea`, a `select`, or a `contenteditable` region.
 */
export function isValueField(s: SensitiveState, el: Element): boolean {
  const name = localName(el);
  return (
    name === "input" ||
    name === "textarea" ||
    name === "select" ||
    isEditingHostOrInside(s, el)
  );
}

/**
 * Record the shadow roots the page attaches (DOM, `attachShadow()`), so
 * that the field focused inside a closed one can be found
 * ({@link eventField}): an event from inside a shadow tree reaches the
 * window's listeners retargeted to its host, and a closed tree's nodes are
 * not in its composed path. Called by the recorder before any page code.
 */
export function trackShadowRoots(
  w: Window & typeof globalThis,
  s: SensitiveState,
): void {
  const proto = w.Element.prototype as unknown as Record<string, unknown>;
  const attach = proto.attachShadow as
    | ((this: Element, init: ShadowRootInit) => ShadowRoot)
    | undefined;
  if (typeof attach !== "function") return;
  // Patched in place of the platform's method, keeping its name and
  // arity, so that the page sees the same function shape.
  const attachShadow = {
    attachShadow(this: Element, init: ShadowRootInit): ShadowRoot {
      const root = attach.call(this, init);
      s.shadowRoots.set(this, root);
      return root;
    },
  }.attachShadow;
  const d = Object.getOwnPropertyDescriptor(proto, "attachShadow");
  Object.defineProperty(proto, "attachShadow", {
    value: attachShadow,
    writable: d?.writable ?? true,
    enumerable: d?.enumerable ?? true,
    configurable: d?.configurable ?? true,
  });
}

/** The events whose properties carry what was typed (§11.3.3). */
function isTextEvent(type: string): boolean {
  return (
    type.startsWith("key") ||
    type.startsWith("composition") ||
    type === "beforeinput" ||
    type === "input" ||
    type === "textInput"
  );
}

/**
 * The text events dispatched only at an editable field (UI Events,
 * `beforeinput`, `input` and the composition events): not the keyboard
 * events, which target whatever has focus.
 */
function isEditingEvent(type: string): boolean {
  return isTextEvent(type) && !type.startsWith("key");
}

/**
 * The elements a keyboard event can target by being focused themselves
 * (HTML, "focusable area"): the document's own element and body, the
 * natively focusable elements, and any element with a `tabindex`.
 */
function focusableItself(s: SensitiveState, el: Element): boolean {
  const name = localName(el);
  if (
    name === "body" ||
    name === "html" ||
    name === "a" ||
    name === "area" ||
    name === "button" ||
    name === "input" ||
    name === "select" ||
    name === "textarea" ||
    name === "iframe" ||
    name === "summary" ||
    name === "audio" ||
    name === "video" ||
    name === "object" ||
    name === "embed" ||
    name === "dialog"
  ) {
    return true;
  }
  return (
    s.getters.hasAttribute.call(el, "tabindex") || isEditingHostOrInside(s, el)
  );
}

/** The shadow root `el` hosts that the shim can see into, open or tracked. */
function shadowRootOf(s: SensitiveState, el: Element): ShadowRoot | null {
  const tracked = s.shadowRoots.get(el);
  if (tracked !== undefined) return tracked;
  try {
    return s.getters.shadowRoot?.call(el) ?? null;
  } catch {
    return null;
  }
}

/**
 * The field an input event belongs to, and whether it is sensitive
 * (§11.3.1, §11.3.3), seen through shadow trees:
 *
 * - the event's innermost target is the first node of its composed path
 *   (DOM, `composedPath()`), so a field in an open shadow tree is found
 *   although the window's listeners see the event retargeted to its host;
 * - for an event that carries typed text (a keyboard, `beforeinput`,
 *   `input` or composition event) at the host of a shadow tree the path
 *   hides (a closed one), the focused element inside it, through the roots
 *   the page attached ({@link trackShadowRoots});
 * - failing closed: such an event at an element that is neither a field nor
 *   focusable itself comes from inside a shadow tree the shim cannot see
 *   into, so it is treated as at a sensitive field (an editing event is
 *   only ever dispatched at a field).
 */
export function eventField(
  s: SensitiveState,
  ev: Event,
): { field: Element | null; sensitive: boolean } {
  let inner: unknown = ev.target;
  try {
    const path = s.getters.composedPath?.call(ev);
    if (path !== undefined && path.length > 0) inner = path[0];
  } catch {
    // An event the platform will not give a path for: its target.
  }
  let field = fieldOf(s, inner);
  const text = isTextEvent(ev.type);
  if (text) {
    // A bounded descent: shadow trees nest, never cyclically.
    for (let depth = 0; field !== null && depth < 64; depth++) {
      if (isValueField(s, field)) break;
      const root = shadowRootOf(s, field);
      if (root === null) break;
      let active: Element | null = null;
      try {
        active = s.getters.rootActiveElement?.call(root) ?? null;
      } catch {
        active = null;
      }
      if (active === null) break;
      field = fieldOf(s, active);
    }
  }
  if (field === null) return { field, sensitive: false };
  if (isSensitive(s, field)) return { field, sensitive: true };
  if (
    text &&
    !isValueField(s, field) &&
    (isEditingEvent(ev.type) || !focusableItself(s, field))
  ) {
    return { field, sensitive: true };
  }
  return { field, sensitive: false };
}

/**
 * Whether `node` is inside a sensitive field (§11.3.1): a sensitive
 * `contenteditable` region's text, a sensitive `textarea`'s, or the field
 * itself. What a `MutationObserver` reports of such a node is holed
 * (`mutationRecordsJson`, entries.ts).
 */
export function inSensitiveField(s: SensitiveState, node: Node): boolean {
  return internally(s, () => {
    const f = fieldOf(s, node);
    return f !== null && isValueField(s, f) && isSensitive(s, f);
  });
}

/**
 * The value of a field as the page would read it, through the platform's
 * getters (never a patched one): an `input`'s or `textarea`'s `value`, an
 * editing host's text.
 */
export function fieldValue(s: SensitiveState, el: Element): string {
  const name = localName(el);
  if (name === "input")
    return s.getters.inputValue.call(el as HTMLInputElement);
  if (name === "textarea")
    return s.getters.textareaValue.call(el as HTMLTextAreaElement);
  return s.getters.textContent.call(el) ?? "";
}

/**
 * Remember `value` as a sensitive value of this session (holed wherever it
 * reaches a checked field, §5.2.1), when it is long enough to match safely.
 */
export function rememberSensitive(s: SensitiveState, value: string): void {
  if (value.length < MIN_HOLED_LENGTH || s.remembered.includes(value)) return;
  s.remembered.push(value);
  if (s.remembered.length > MAX_REMEMBERED) s.remembered.shift();
  s.remembered.sort((a, b) => b.length - a.length);
}

/**
 * Every sensitive value to hole now: the remembered ones and the current
 * value of every sensitive field in the document or seen before, longest
 * first (so a value is holed whole before a shorter one inside it).
 */
export function currentSensitiveValues(
  w: Window & typeof globalThis,
  s: SensitiveState,
): string[] {
  return internally(s, () => {
    const out = new Set(s.remembered);
    const fields = new Set<Element>(s.seen);
    try {
      const list = s.getters.querySelectorAll.call(
        w.document,
        "input, textarea, [contenteditable]",
      );
      for (let i = 0; i < list.length; i++) fields.add(list[i]);
    } catch {
      // No document yet: only the remembered values.
    }
    for (const el of fields) {
      try {
        const f = fieldOf(s, el);
        if (f === null || !isSensitive(s, f)) continue;
        const v = fieldValue(s, f);
        if (v.length >= MIN_HOLED_LENGTH) out.add(v);
      } catch {
        // An element whose getters throw holds nothing we can read.
      }
    }
    return [...out].sort((a, b) => b.length - a.length);
  });
}

/**
 * The forms of `v` a page may send it in (§5.2.1): raw, as
 * `encodeURIComponent` writes it, as a form (`URLSearchParams`) writes it,
 * and as a JSON string's contents.
 */
function encodedForms(v: string): string[] {
  const forms = new Set([v]);
  try {
    forms.add(encodeURIComponent(v));
  } catch {
    // A lone surrogate: encodeURIComponent refuses it, and so would the page.
  }
  forms.add(new URLSearchParams({ v }).toString().slice(2));
  forms.add(JSON.stringify(v).slice(1, -1));
  return [...forms].filter((f) => f.length >= MIN_HOLED_LENGTH);
}

/**
 * `text` with every occurrence of every value of `values` (and of its
 * encoded forms) replaced by the hole token (§5.2.1). `values` longest
 * first, as {@link currentSensitiveValues} gives them.
 */
export function holeText(text: string, values: readonly string[]): string {
  if (text === "" || values.length === 0) return text;
  const forms = values
    .flatMap(encodedForms)
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const f of forms) {
    if (out.includes(f)) out = out.split(f).join(HOLE_TOKEN);
  }
  return out;
}

const utf8Encoder = new TextEncoder();

/**
 * `bytes` holed (§5.2.1): as text when they are UTF-8, otherwise by
 * replacing the UTF-8 bytes of each form of each value in place.
 */
export function holeBytes(
  bytes: Uint8Array,
  values: readonly string[],
): Uint8Array {
  if (bytes.length === 0 || values.length === 0) return bytes;
  let text: string | undefined;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = undefined;
  }
  if (text !== undefined) {
    const holed = holeText(text, values);
    return holed === text ? bytes : utf8Encoder.encode(holed);
  }
  const hole = utf8Encoder.encode(HOLE_TOKEN);
  let out = bytes;
  const forms = values
    .flatMap(encodedForms)
    .sort((a, b) => b.length - a.length)
    .map((f) => utf8Encoder.encode(f));
  for (const f of forms) out = replaceBytes(out, f, hole);
  return out;
}

function replaceBytes(
  data: Uint8Array,
  find: Uint8Array,
  by: Uint8Array,
): Uint8Array {
  const parts: number[] = [];
  let found = false;
  for (let i = 0; i < data.length; ) {
    let match = i + find.length <= data.length;
    for (let j = 0; match && j < find.length; j++) {
      if (data[i + j] !== find[j]) match = false;
    }
    if (match) {
      for (const b of by) parts.push(b);
      i += find.length;
      found = true;
    } else {
      parts.push(data[i]);
      i++;
    }
  }
  return found ? Uint8Array.from(parts) : data;
}

/**
 * A shape-preserving placeholder for a sensitive value of class `cls` and
 * `length` UTF-16 code units (§11.3.4): `x`s for a password or a declared
 * field, a Luhn-valid digit string for a card, and for an e-mail address
 * `x@x.invalid` (a reserved domain, RFC 2606 §2) with its local part padded
 * to the length, or `x`s when it is shorter than that.
 */
export function placeholder(cls: number, length: number): string {
  const n = Math.max(0, Math.floor(length));
  if (cls === SensitiveClass.creditCard) return luhnDigits(n);
  if (cls === SensitiveClass.email && n >= 11) {
    return "x".repeat(n - 10) + "@x.invalid";
  }
  return "x".repeat(n);
}

/**
 * `n` digits that pass the Luhn check (ISO/IEC 7812-1, Annex B): a `4`, then
 * zeros, then the check digit.
 */
export function luhnDigits(n: number): string {
  if (n === 0) return "";
  if (n === 1) return "0";
  const body = "4" + "0".repeat(n - 2);
  let sum = 0;
  // Doubling starts at the digit left of the check digit.
  for (let i = body.length - 1, double = true; i >= 0; i--, double = !double) {
    let d = body.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return body + String((10 - (sum % 10)) % 10);
}

/** The event properties masked at a sensitive target (§11.3.3). */
const MASKED_TEXT_PROPS = ["data"] as const;

/**
 * Whether a `KeyboardEvent.key` is a printable character rather than a
 * named key (UI Events KeyboardEvent key Values, §2: a key attribute value
 * is either a single character string or a named key value): one code point.
 */
export function isPrintableKey(key: string): boolean {
  return [...key].length === 1;
}

/**
 * `props` (an `Input`'s properties, §10.2) masked for a sensitive target
 * (§11.3.3): a printable `key` becomes `*` per UTF-16 code unit and its
 * `code` `Masked` (a physical key identifies the character on a known
 * layout); `data` (an `InputEvent`'s or a `CompositionEvent`'s) becomes `*`
 * per code unit. Named keys, modifiers, `inputType` and the rest stay.
 */
export function maskEventProps(
  props: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...props };
  if (typeof out.key === "string" && isPrintableKey(out.key)) {
    out.key = "*".repeat(out.key.length);
    if ("code" in out) out.code = "Masked";
  }
  for (const k of MASKED_TEXT_PROPS) {
    if (typeof out[k] === "string") out[k] = "*".repeat(out[k].length);
  }
  return out;
}

// ── The page's API, `ct` (§11.3.1, §11.3.2) ────────────────────────────

/** The global the page's API is published on. */
export const CT_GLOBAL = "ct";

/** What a declassifier's registration takes. */
export interface DeclassifyOptions {
  /** Its stable identity, `Declassify.fn_id` (default: the function's name). */
  id?: string;
}

/** The page's API (§11.3.1, §11.3.2), the same in record and replay mode. */
export interface CtApi {
  /** Make a free-text field public; throws on a credential field. */
  public(el: Element): Element;
  /** Declare a field sensitive. */
  sensitive(el: Element): Element;
  /** Whether a field is sensitive now. */
  isSensitive(el: Element): boolean;
  /**
   * Register `fn` as a declassifier under `id` (default `fn.name`; an empty
   * or already registered id throws) and return the wrapped function. On
   * record the real value goes in and the output is logged (`Declassify`);
   * on replay the output is returned from the log and `fn` does not run.
   */
  declassify<A extends unknown[], R>(
    fn: (...args: A) => R,
    options?: DeclassifyOptions,
  ): (...args: A) => R;
  /**
   * Record a narrative mark (§13): `Mark{name, data}`, `data` the canonical
   * JSON of `data` (default `null`). Experiment events are marks named
   * `exposure:<experiment>` and `conversion:<goal>`. A name that is not a
   * non-empty string of at most {@link MAX_MARK_NAME} characters, or data
   * that is not JSON data or whose JSON is longer than
   * {@link MAX_MARK_DATA} characters, throws in every mode, so a page
   * behaves the same on record and on replay. Replay ignores marks, so on
   * replay a valid call does nothing.
   */
  mark(name: string, data?: unknown): void;
}

/** The longest `Mark.name` a page may write, in UTF-16 code units. */
export const MAX_MARK_NAME = 256;

/** The longest `Mark.data` a page may write: its JSON, in UTF-16 code units. */
export const MAX_MARK_DATA = 4096;

/**
 * What a mode does with a mark the page made, given its checked name and the
 * canonical JSON of its data: record logs it as `Mark`; replay, and the inert
 * API published when nothing is recorded, do nothing.
 */
export type MarkCall = (name: string, data: string) => void;

/**
 * What a mode supplies to the API: how a call of a registered declassifier
 * runs (record: call and log; replay: answer from the log).
 */
export type DeclassifierCall = (
  id: string,
  fn: (...args: unknown[]) => unknown,
  self: unknown,
  args: unknown[],
) => unknown;

function asElement(
  w: Window & typeof globalThis,
  el: unknown,
  what: string,
): Element {
  if (!(el instanceof w.Element)) {
    throw new TypeError(`ct.${what}() takes an element`);
  }
  return el;
}

/**
 * The page's `ct` API on `w`'s state, its declassifiers run by `call` and its
 * marks handed to `markCall`. The registration rules (an empty or duplicate
 * id throws), the marks' checks and the declarations are the same in every
 * mode, so a page behaves the same on record and on replay.
 */
export function makeCtApi(
  w: Window & typeof globalThis,
  s: SensitiveState,
  call: DeclassifierCall,
  markCall: MarkCall = () => undefined,
): CtApi {
  const ids = new Set<string>();
  return {
    mark(name: string, data?: unknown): void {
      if (
        typeof name !== "string" ||
        name === "" ||
        name.length > MAX_MARK_NAME
      ) {
        throw new TypeError(
          `ct.mark() takes a non-empty name of at most ${MAX_MARK_NAME} characters`,
        );
      }
      const json = canonicalOutput(data === undefined ? null : data);
      if (json === undefined || json.length > MAX_MARK_DATA) {
        throw new TypeError(
          `ct.mark() takes data that is JSON data of at most ${MAX_MARK_DATA} characters`,
        );
      }
      markCall(name, json);
    },
    public(el: Element): Element {
      const e = asElement(w, el, "public");
      if (credentialClass(s, e) !== undefined) {
        throw new TypeError(
          "ct.public(): a credential field (a password, a one-time code, a card) is always sensitive and cannot be made public",
        );
      }
      s.marks.set(e, "public");
      return e;
    },
    sensitive(el: Element): Element {
      const e = asElement(w, el, "sensitive");
      s.marks.set(e, "sensitive");
      return e;
    },
    isSensitive(el: Element): boolean {
      return isSensitive(s, asElement(w, el, "isSensitive"));
    },
    declassify<A extends unknown[], R>(
      fn: (...args: A) => R,
      options?: DeclassifyOptions,
    ): (...args: A) => R {
      if (typeof fn !== "function") {
        throw new TypeError("ct.declassify() takes a function");
      }
      const id = options?.id ?? fn.name;
      if (typeof id !== "string" || id === "") {
        throw new TypeError(
          "ct.declassify(): a declassifier needs a non-empty id (give { id } for an anonymous function)",
        );
      }
      if (ids.has(id)) {
        throw new TypeError(
          `ct.declassify(): a declassifier with id ${JSON.stringify(id)} is already registered`,
        );
      }
      ids.add(id);
      const run = fn as unknown as (...args: unknown[]) => unknown;
      return function declassified(this: unknown, ...args: A): R {
        return call(id, run, this, args) as R;
      };
    },
  };
}

/**
 * Publish `api` as the page's `ct` (non-enumerable, replaceable by the page)
 * unless the page already has a `ct`; the control surface carries it too.
 */
export function publishCtApi(w: Window & typeof globalThis, api: CtApi): void {
  if (CT_GLOBAL in w) return;
  Object.defineProperty(w, CT_GLOBAL, {
    value: api,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

/**
 * The canonical JSON of a declassifier's output (`Declassify.output`,
 * §5.2), or `undefined` when the output is not JSON data (a function, a
 * symbol, a `bigint`, `undefined`, a non-finite number, a cycle), which the
 * log cannot carry and replay could not return as it was. Objects' keys are
 * sorted, so the same value always writes the same text.
 */
export function canonicalOutput(v: unknown): string | undefined {
  const seen = new Set<object>();
  const walk = (x: unknown): unknown => {
    if (x === null || typeof x === "boolean" || typeof x === "string") return x;
    if (typeof x === "number") {
      if (!Number.isFinite(x)) throw new TypeError("non-finite");
      return x;
    }
    if (typeof x !== "object") throw new TypeError(typeof x);
    if (seen.has(x)) throw new TypeError("cycle");
    seen.add(x);
    try {
      if (Array.isArray(x)) return x.map(walk);
      const proto = Object.getPrototypeOf(x) as unknown;
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError("not a plain object");
      }
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(x).sort()) {
        out[k] = walk((x as Record<string, unknown>)[k]);
      }
      return out;
    } finally {
      seen.delete(x);
    }
  };
  try {
    return JSON.stringify(walk(v));
  } catch {
    return undefined;
  }
}

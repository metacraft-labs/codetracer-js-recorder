/**
 * Sensitive inputs in replay mode (CodeTracer's JS-Boundary-Recording
 * specification §11.3.2, §11.3.4, §7.2 `cause`):
 *
 * - the page's `ct` API, whose declassifiers return the output the log has
 *   (`Declassify`, matched by `fn_id` at the cursor) without running their
 *   body, which would only see a placeholder;
 * - a `Scrubbed` record's placeholder put into its field before the input
 *   it precedes is injected (`applyScrubbed`, called by the injector);
 * - the detection of a raw sensitive read: the page reading a sensitive
 *   field's `value`, an editing host's `textContent` or `innerText`, or a
 *   masked property of an injected event, outside a declassifier. The
 *   replay handed it a placeholder there, so a divergence after it may be
 *   that substitution's doing, which the divergence report says (`cause:
 *   substituted-sensitive`, with the read).
 */

import type { RecordOf } from "@codetracer/boundary-format";

import { replaceAccessor } from "../context.js";
import {
  type CtApi,
  fieldOf,
  isEditingHostOrInside,
  isSensitive,
  isValueField,
  makeCtApi,
  placeholder,
  rememberSensitive,
  trackShadowRoots,
} from "../sensitive.js";
import { resolveTarget, targetOf } from "../targets.js";
import type { ReplayContext } from "./context.js";

/** How many stack frames a raw read's report carries. */
const READ_FRAMES = 8;

/** The page's stack at a raw read, innermost first, without this module's frames. */
function pageFrames(): string[] {
  const stack = new Error().stack ?? "";
  return stack
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("at "))
    .slice(2, 2 + READ_FRAMES);
}

/**
 * Install the replay side of sensitive inputs on `ctx` and return the page's
 * `ct` API, which the installer publishes.
 */
export function replaySensitive(ctx: ReplayContext): CtApi {
  const { w, replay, sensitive: s } = ctx;
  // As on record, so the page sees the same `attachShadow`.
  trackShadowRoots(w, s);

  const report = (el: Element, what: string) => {
    if (s.internalDepth > 0) return;
    let target: string;
    try {
      target = targetOf(el);
    } catch {
      target = "";
    }
    replay.noteSensitiveRead({ target, what, frames: pageFrames() });
  };
  s.onRawRead = (read) => report(read.element, read.what);

  // A sensitive field's value read by the page: a raw read (§7.2).
  for (const [proto, get] of [
    [w.HTMLInputElement.prototype, s.getters.inputValue],
    [w.HTMLTextAreaElement.prototype, s.getters.textareaValue],
  ] as const) {
    const d = Object.getOwnPropertyDescriptor(proto, "value")!;
    replaceAccessor(
      proto,
      "value",
      function (this: unknown) {
        const v = (get as (this: unknown) => string).call(this);
        if (s.internalDepth === 0 && isSensitive(s, this as Element)) {
          report(this as Element, "value");
        }
        return v;
      },
      d.set as ((this: unknown, v: unknown) => void) | undefined,
    );
  }
  // An editing host's text, read by the page: a raw read when the host is
  // sensitive.
  const textGetters: [object, string][] = [
    [w.Node.prototype, "textContent"],
    [w.HTMLElement.prototype, "innerText"],
  ];
  for (const [proto, name] of textGetters) {
    const d = Object.getOwnPropertyDescriptor(proto, name);
    if (d?.get === undefined) continue;
    const get = d.get;
    replaceAccessor(
      proto,
      name,
      function (this: unknown) {
        const v = get.call(this) as unknown;
        if (s.internalDepth === 0 && (this as Node).nodeType === 1) {
          const el = this as Element;
          if (isEditingHostOrInside(s, el)) {
            const host = fieldOf(s, el);
            if (host !== null && isSensitive(s, host)) report(host, name);
          }
        }
        return v;
      },
      d.set as ((this: unknown, v: unknown) => void) | undefined,
    );
  }

  // Declassifiers: the logged output, the body not run (§11.3.2). Marks:
  // checked as on record and otherwise ignored, as the cursor skips them
  // (§13).
  return makeCtApi(w, s, (id) => {
    const r = replay.next("Declassify", { fn_id: id });
    return JSON.parse(r.output) as unknown;
  });
}

/**
 * Put the placeholder of a `Scrubbed` record into its field (§11.3.4): the
 * class's shape at the recorded length, through the platform's setter, and
 * remember it, so the replay holes it wherever the page sends it as the
 * recorder holed the visitor's value (§5.2.1). A reason when the target does
 * not resolve to a field that takes a value.
 */
export function applyScrubbed(
  ctx: ReplayContext,
  e: RecordOf<"Scrubbed">,
): string | undefined {
  const { w, sensitive: s } = ctx;
  const t = resolveTarget(e.target, w.document);
  if (!(t instanceof w.Element)) {
    return `Scrubbed target ${e.target} does not resolve`;
  }
  const field = fieldOf(s, t);
  if (field === null) return `Scrubbed target ${e.target} is not a field`;
  const value = placeholder(e.class, e.length);
  if (
    field instanceof w.HTMLInputElement ||
    field instanceof w.HTMLTextAreaElement ||
    field instanceof w.HTMLSelectElement
  ) {
    field.value = value;
  } else {
    field.textContent = value;
  }
  s.seen.add(field);
  rememberSensitive(s, value);
  return undefined;
}

/**
 * Whether the logged properties `props` of a text event were masked on
 * record (§11.3.3): a printable key's `code` is `Masked`, and masked `data`
 * is all `*`.
 */
function loggedMasked(props: Record<string, unknown>): boolean {
  if (props.code === "Masked") return true;
  return typeof props.data === "string" && /^\*+$/.test(props.data);
}

/**
 * An injected event at a sensitive field (§11.3.3), or a masked one at an
 * element that is not a field, which the record side masked because the
 * event may have come from a field in a shadow tree it could not see into
 * (`textEventMaskedAt`): its masked properties (`key`, `code`, `data`) as
 * the log has them, each read reported as a raw sensitive read (on record
 * the page read the visitor's character there). `props` are the event's
 * logged properties. The second case is told by the log, not by the
 * document: what the record side decided may depend on where focus was
 * (`body`'s `:focus`), which an injected event does not reproduce.
 */
export function watchMaskedProps(
  ctx: ReplayContext,
  ev: Event,
  target: EventTarget,
  props: Record<string, unknown>,
): void {
  const { sensitive: s } = ctx;
  const field = fieldOf(s, target);
  if (field === null) return;
  if (
    !isSensitive(s, field) &&
    !(!isValueField(s, field) && loggedMasked(props))
  ) {
    return;
  }
  for (const name of ["key", "code", "data"]) {
    if (!(name in ev)) continue;
    const value = (ev as unknown as Record<string, unknown>)[name];
    Object.defineProperty(ev, name, {
      get() {
        if (s.internalDepth === 0)
          s.onRawRead?.({ element: field, what: `event.${name}` });
        return value;
      },
      configurable: true,
      enumerable: true,
    });
  }
}

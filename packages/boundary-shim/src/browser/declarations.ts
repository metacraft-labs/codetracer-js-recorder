/**
 * What a level-0 page declares for its session's narrative (CodeTracer's
 * JS-Boundary-Recording specification §13, §9.4): the experiment arms the
 * server put the visitor in, and the semantic labels of the elements the
 * visitor acts on. A cooperating framework supplies both itself (§9.4); a
 * generic page states them in its markup, so the shim reads only what the
 * site's author wrote there and never the page's text:
 *
 * - `data-ct-arms` on the document element: a JSON object of experiment key
 *   to arm, which the server that rendered the page writes (the document
 *   element is parsed before the shim's bootstrap, the first element of
 *   `<head>`, runs). It becomes `Env.arms`.
 * - `data-ct-label` on an element or an ancestor: the label of every input
 *   event at it (`Input.label`).
 *
 * Neither changes what replay does: labels are not used for replay, and
 * `Env.arms` is not applied to the replay context.
 */

/** The longest experiment key or arm `data-ct-arms` may carry. */
export const MAX_ARM_TEXT = 256;

/** The most experiments `data-ct-arms` may carry. */
export const MAX_ARMS = 64;

/** The longest label kept from `data-ct-label`; a longer one is cut. */
export const MAX_LABEL = 128;

/** The attribute of the document element that declares the arms. */
export const ARMS_ATTRIBUTE = "data-ct-arms";

/** The attribute that declares an element's label. */
export const LABEL_ATTRIBUTE = "data-ct-label";

/**
 * `Env.arms`: the canonical JSON (keys sorted) of the document element's
 * `data-ct-arms` when it is a JSON object of at most {@link MAX_ARMS}
 * experiments whose keys and arms are non-empty strings of at most
 * {@link MAX_ARM_TEXT} characters; `{}` otherwise (no attribute, or one
 * that is not such an object, which is ignored as a whole rather than
 * half-read).
 */
export function declaredArms(doc: Document): string {
  let raw: string | null = null;
  try {
    raw = doc.documentElement?.getAttribute(ARMS_ATTRIBUTE) ?? null;
  } catch {
    raw = null;
  }
  if (raw === null) return "{}";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "{}";
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "{}";
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length > MAX_ARMS) return "{}";
  const arms: Record<string, string> = {};
  for (const [key, arm] of entries.sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    if (
      key === "" ||
      key.length > MAX_ARM_TEXT ||
      typeof arm !== "string" ||
      arm === "" ||
      arm.length > MAX_ARM_TEXT
    ) {
      return "{}";
    }
    arms[key] = arm;
  }
  return JSON.stringify(arms);
}

/**
 * `Input.label` of an event at `target`: the `data-ct-label` of the nearest
 * element, the target itself or an ancestor, that has one, trimmed, its
 * whitespace collapsed and cut at {@link MAX_LABEL} characters; empty when
 * none has one (§9.4: a label may be empty). A text node's label is its
 * parent's.
 */
export function declaredLabel(target: unknown): string {
  let el: Element | null = null;
  if (typeof Element !== "undefined" && target instanceof Element) {
    el = target;
  } else if (typeof Node !== "undefined" && target instanceof Node) {
    el = target.parentElement;
  }
  if (el === null) return "";
  let labelled: Element | null = null;
  try {
    labelled = el.closest(`[${LABEL_ATTRIBUTE}]`);
  } catch {
    labelled = null;
  }
  const raw = labelled?.getAttribute(LABEL_ATTRIBUTE) ?? "";
  return raw.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL);
}

/**
 * Level-0 structural targets (JS-Boundary-Recording.md §9.3, §10.2): the
 * string an `Input`, `DomEffect` or `LayoutRead` names its target by.
 *
 * ```text
 * win | doc | path:<start>(><tag>:<n>)*
 * <start> := #<id>      the nearest ancestor-or-self with a non-empty id
 *          | html       the document element, when no ancestor has an id
 *          | ~<tag>     the root of a subtree not in the document
 * ```
 *
 * `<tag>:<n>` is the element's lowercase local name and its index among its
 * parent's element children with the same local name. In `<id>`, `\` and `>`
 * are escaped with a backslash, so the path splits unambiguously on an
 * unescaped `>`. Example: `path:#cart>ul:0>li:3>button:0`.
 */

/** The target string of an event target or node. */
export function targetOf(t: unknown): string {
  if (t === null || t === undefined) return "doc";
  if (typeof Window !== "undefined" && t instanceof Window) return "win";
  if (typeof Document !== "undefined" && t instanceof Document) return "doc";
  if (typeof Element !== "undefined" && t instanceof Element) {
    return "path:" + elementPath(t);
  }
  if (typeof Node !== "undefined" && t instanceof Node) {
    // A text node or similar: its parent element is the target.
    const parent = t.parentElement;
    return parent === null ? "doc" : "path:" + elementPath(parent);
  }
  return "doc";
}

function elementPath(el: Element): string {
  const steps: string[] = [];
  let cur: Element = el;
  for (;;) {
    const id = cur.getAttribute("id");
    if (id !== null && id !== "") {
      steps.push("#" + escapeId(id));
      break;
    }
    const parent = cur.parentElement;
    if (parent === null) {
      const doc = cur.ownerDocument;
      steps.push(
        doc !== null && doc.documentElement === cur
          ? cur.localName
          : "~" + cur.localName,
      );
      break;
    }
    let index = 0;
    for (
      let sib = cur.previousElementSibling;
      sib !== null;
      sib = sib.previousElementSibling
    ) {
      if (sib.localName === cur.localName) index++;
    }
    steps.push(`${cur.localName}:${index}`);
    cur = parent;
  }
  return steps.reverse().join(">");
}

function escapeId(id: string): string {
  return id.replace(/[\\>]/g, (c) => "\\" + c);
}

/**
 * The node a level-0 target string names in `doc` now: the inverse of
 * {@link targetOf}. `win` is `doc`'s window, `doc` the document, and a
 * `path:` the element its steps reach from its start. `null` when the
 * string is not a target, its start is a detached subtree (`~<tag>`, which
 * no document lookup can reach), or a step names no element.
 */
export function resolveTarget(
  target: string,
  doc: Document,
): Element | Document | Window | null {
  if (target === "win") return doc.defaultView;
  if (target === "doc") return doc;
  if (!target.startsWith("path:")) return null;
  const steps = splitPath(target.slice("path:".length));
  if (steps === null || steps.length === 0) return null;
  const start = steps[0];
  let cur: Element | null;
  if (start.startsWith("#")) {
    cur = doc.getElementById(start.slice(1));
  } else if (start.startsWith("~")) {
    return null;
  } else {
    const root = doc.documentElement;
    cur = root !== null && root.localName === start ? root : null;
  }
  for (const step of steps.slice(1)) {
    if (cur === null) return null;
    const m = /^([^:]+):(\d+)$/.exec(step);
    if (m === null) return null;
    const [, tag, n] = m;
    let index = Number(n);
    let found: Element | null = null;
    for (let c = cur.firstElementChild; c !== null; c = c.nextElementSibling) {
      if (c.localName === tag && index-- === 0) {
        found = c;
        break;
      }
    }
    cur = found;
  }
  return cur;
}

/**
 * Split a path at its unescaped `>`s, unescaping the start's id (only an
 * id can hold `\` or `>`). `null` for a dangling backslash.
 */
function splitPath(path: string): string[] | null {
  const steps: string[] = [];
  let cur = "";
  for (let i = 0; i < path.length; i++) {
    const c = path[i];
    if (c === "\\") {
      if (i + 1 >= path.length) return null;
      cur += path[++i];
    } else if (c === ">") {
      steps.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  steps.push(cur);
  return steps;
}

/**
 * The rewrite that gives the recorder a seam at a page's dynamic `import()`
 * calls (CodeTracer's JS-Boundary-Recording specification §6, §8.1, §10.1).
 *
 * `import()` is syntax: no global a page can patch stands behind it, so the
 * recorder cannot see a module graph fetched and evaluated outside any script
 * element, nor when its promise settles. The deploy step that installs the
 * shim (`codetracer-js-recorder boundary-shim`) therefore rewrites each call
 * of the bundle, and the replay runner applies the same rewrite to the
 * bundle it serves:
 *
 * ```text
 * import ( x )        ->  CALLEE ( (__ctS)=>import(__ctS), x )
 * import ( x , o )    ->  CALLEE ( (__ctS,__ctO)=>import(__ctS,__ctO), x , o )
 * ```
 *
 * where `CALLEE` is `(globalThis.__ctBoundaryImport||((f,s,o)=>f(s,o)))`
 * ({@link IMPORT_SEAM_CALLEE}): the seam the shim installs, or a function that
 * performs the `import()` as written where no shim is installed. The
 * `import()` stays in the page's own module or script, so its specifier
 * resolves against that module's URL exactly as before; only the keyword is
 * replaced and one function inserted after the call's `(`, so every other
 * byte, the whitespace and comments inside the call included, is kept, and
 * a call with one argument keeps one (a two-argument `import()` would be a
 * syntax error in an engine without import attributes).
 *
 * The rewrite is exactly undone by {@link stripImportSeam}, a text
 * replacement of the three inserted strings, which `bundle-manifest` applies
 * before it hashes a file, so the build hash is the same before and after
 * the deploy step, as it is for the bootstrap (§8.1). Calls are found with
 * SWC's parser (https://swc.rs), never a text search: an `import(` in a
 * string, a comment or a regular expression is not a call. A file SWC
 * cannot parse is refused, naming it, rather than left with calls the
 * recorder cannot see.
 */

import { parseSync } from "@swc/core";

import {
  BOOTSTRAP_MARKER,
  IMPORT_SEAM_CALLEE,
  IMPORT_SEAM_LOAD_1,
  IMPORT_SEAM_LOAD_2,
} from "./browser/config.js";
import { scanTags, tagAttributes } from "./html-scan.js";

/** A file the seam cannot be inserted into without changing it otherwise. */
export class ImportSeamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportSeamError";
  }
}

/** Every string the rewrite inserts, and what each stands for. */
const INSERTED: readonly (readonly [string, string])[] = [
  [IMPORT_SEAM_CALLEE, "import"],
  [IMPORT_SEAM_LOAD_2, ""],
  [IMPORT_SEAM_LOAD_1, ""],
];

/**
 * `text` with every rewritten call put back as it was: the exact inverse of
 * {@link rewriteDynamicImports} (and of {@link rewriteHtmlImports}). It works
 * on a decoded text or on a latin1 view of the bytes alike, since the
 * inserted strings are ASCII.
 */
export function stripImportSeam(text: string): string {
  if (!text.includes(IMPORT_SEAM_CALLEE)) return text;
  let out = text;
  for (const [inserted, original] of INSERTED) {
    out = out.split(inserted).join(original);
  }
  return out;
}

/** One insertion or replacement, at a UTF-8 byte offset. */
interface Edit {
  at: number;
  /** Bytes replaced from `at` (the keyword's six, or none). */
  remove: number;
  text: string;
}

type Node = Record<string, unknown>;

/** Every `CallExpression` whose callee is `import`, in the AST `node`. */
function importCalls(node: unknown, out: Node[]): void {
  if (Array.isArray(node)) {
    for (const n of node) importCalls(n, out);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const n = node as Node;
  if (
    n.type === "CallExpression" &&
    (n.callee as Node | undefined)?.type === "Import"
  ) {
    out.push(n);
  }
  for (const key of Object.keys(n)) {
    if (key === "span") continue;
    const v = n[key];
    if (v !== null && typeof v === "object") importCalls(v, out);
  }
}

/** The byte after whitespace and comments from `at` in `bytes`. */
function skipTrivia(bytes: Buffer, at: number): number {
  let k = at;
  for (;;) {
    const c = bytes[k];
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0c) {
      k++;
    } else if (c === 0x2f && bytes[k + 1] === 0x2f) {
      while (k < bytes.length && bytes[k] !== 0x0a) k++;
    } else if (c === 0x2f && bytes[k + 1] === 0x2a) {
      const close = bytes.indexOf("*/", k + 2, "latin1");
      k = close < 0 ? bytes.length : close + 2;
    } else if (
      c === 0xe2 &&
      bytes[k + 1] === 0x80 &&
      (bytes[k + 2] === 0xa8 || bytes[k + 2] === 0xa9)
    ) {
      k += 3; // U+2028, U+2029: line terminators
    } else if (c === 0xc2 && bytes[k + 1] === 0xa0) {
      k += 2; // U+00A0
    } else if (c === 0xef && bytes[k + 1] === 0xbb && bytes[k + 2] === 0xbf) {
      k += 3; // U+FEFF
    } else {
      return k;
    }
  }
}

/** Parse `code` as a module, or as a classic script if it is not one. */
function parse(code: string, name: string): { ast: Node; base: number } {
  const options = {
    syntax: "ecmascript" as const,
    target: "es2022" as const,
    comments: false,
  };
  let ast: Node;
  try {
    // A module by default.
    ast = parseSync(code, options) as unknown as Node;
  } catch {
    try {
      ast = parseSync(code, { ...options, isModule: false }) as unknown as Node;
    } catch (e) {
      throw new ImportSeamError(
        `${name}: the dynamic import() seam cannot be inserted: SWC cannot parse it (${String((e as Error).message ?? e).split("\n")[0]})`,
      );
    }
  }
  // SWC numbers bytes from a counter shared by every parse in the process,
  // starting at the program's first token: the counter's value at byte 0 of
  // this source. Every edit is checked against the source below, so a wrong
  // base is refused, never applied.
  const bytes = Buffer.from(code, "utf-8");
  const first = skipFirstTrivia(bytes);
  return { ast, base: (ast.span as { start: number }).start - first };
}

/** Where the first token of a source is (after a hashbang, comments, BOM). */
function skipFirstTrivia(bytes: Buffer): number {
  let k = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) k = 3;
  if (bytes[k] === 0x23 && bytes[k + 1] === 0x21) {
    while (k < bytes.length && bytes[k] !== 0x0a) k++;
  }
  return skipTrivia(bytes, k);
}

const IMPORT = Buffer.from("import", "latin1");

/**
 * `code` with every dynamic `import()` call rewritten into a call of the seam
 * (see the module comment); `name` names the file in a refusal. Code already
 * rewritten is rewritten from its original, so the rewrite is idempotent.
 */
export function rewriteDynamicImports(code: string, name: string): string {
  return rewriteWithEdits(code, name).code;
}

/**
 * One change the rewrite made to the original text, at a UTF-16 index of it
 * (what a source map's columns count): `remove` code units replaced by
 * `text`, which holds no line break.
 */
export interface SeamEdit {
  index: number;
  remove: number;
  text: string;
}

/**
 * {@link rewriteDynamicImports}, with the original it rewrote (`code` without
 * any earlier seam) and the edits that turn it into the result, for a caller
 * that keeps a source map of the code in step ({@link shiftMappings}).
 */
export function rewriteWithEdits(
  code: string,
  name: string,
): { code: string; original: string; edits: SeamEdit[] } {
  const original = stripImportSeam(code);
  const unchanged = { code: original, original, edits: [] };
  if (!original.includes("import")) return unchanged;
  const { ast, base } = parse(original, name);
  const calls: Node[] = [];
  importCalls(ast, calls);
  if (calls.length === 0) return unchanged;
  const bytes = Buffer.from(original, "utf-8");
  const edits: Edit[] = [];
  for (const call of calls) {
    const at = (call.callee as { span: { start: number } }).span.start - base;
    if (bytes.compare(IMPORT, 0, 6, at, at + 6) !== 0) {
      throw new ImportSeamError(
        `${name}: the dynamic import() seam cannot be inserted: a call is not where the parser placed it (byte ${at})`,
      );
    }
    const paren = skipTrivia(bytes, at + 6);
    if (bytes[paren] !== 0x28) {
      throw new ImportSeamError(
        `${name}: the dynamic import() seam cannot be inserted: no ( after import at byte ${at}`,
      );
    }
    const args = (call.arguments as unknown[] | undefined)?.length ?? 0;
    edits.push({ at, remove: 6, text: IMPORT_SEAM_CALLEE });
    edits.push({
      at: paren + 1,
      remove: 0,
      text: args > 1 ? IMPORT_SEAM_LOAD_2 : IMPORT_SEAM_LOAD_1,
    });
  }
  edits.sort((a, b) => a.at - b.at);
  const parts: Buffer[] = [];
  let from = 0;
  for (const e of edits) {
    parts.push(bytes.subarray(from, e.at), Buffer.from(e.text, "latin1"));
    from = e.at + e.remove;
  }
  parts.push(bytes.subarray(from));
  return {
    code: Buffer.concat(parts).toString("utf-8"),
    original,
    edits: edits.map((e) => ({
      // A byte offset of the UTF-8 original as a UTF-16 index: the bytes
      // before it, decoded.
      index: bytes.subarray(0, e.at).toString("utf-8").length,
      remove: e.remove,
      text: e.text,
    })),
  };
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** The integers of one source-map segment (Base64 VLQ, Source Map v3 §"mappings"). */
function decodeSegment(s: string): number[] {
  const out: number[] = [];
  let value = 0;
  let shift = 0;
  for (const ch of s) {
    const digit = B64.indexOf(ch);
    if (digit < 0) throw new Error(`not a Base64 VLQ digit: ${ch}`);
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
      continue;
    }
    out.push(value & 1 ? -(value >>> 1) : value >>> 1);
    value = 0;
    shift = 0;
  }
  return out;
}

function encodeVlq(n: number): string {
  let v = n < 0 ? (-n << 1) | 1 : n << 1;
  let out = "";
  do {
    let digit = v & 31;
    v >>>= 5;
    if (v > 0) digit |= 32;
    out += B64[digit];
  } while (v > 0);
  return out;
}

/**
 * A source map's `mappings` (Source Map Revision 3,
 * https://sourcemaps.info/spec.html) for the code {@link rewriteWithEdits}
 * returned, given those of the original it rewrote: every segment keeps what
 * it maps to, and its generated column moves past the text the rewrite put
 * before it on its line. The edits insert no line, so lines stay as they
 * were; a segment inside a replaced keyword stays at its start.
 */
export function shiftMappings(
  mappings: string,
  original: string,
  edits: readonly SeamEdit[],
): string {
  if (edits.length === 0) return mappings;
  // Each edit's line and column in the original.
  const byLine = new Map<
    number,
    { column: number; remove: number; delta: number }[]
  >();
  let line = 0;
  let lineStart = 0;
  let k = 0;
  const sorted = [...edits].sort((a, b) => a.index - b.index);
  for (const e of sorted) {
    for (; k < e.index; k++) {
      if (original.charCodeAt(k) === 10) {
        line++;
        lineStart = k + 1;
      }
    }
    const list = byLine.get(line) ?? [];
    list.push({
      column: e.index - lineStart,
      remove: e.remove,
      delta: e.text.length - e.remove,
    });
    byLine.set(line, list);
  }
  return mappings
    .split(";")
    .map((segments, l) => {
      const here = byLine.get(l);
      if (here === undefined || segments === "") return segments;
      // Generated columns are relative within a line: decode to absolute,
      // shift, encode back.
      let prev = 0;
      let prevOut = 0;
      return segments
        .split(",")
        .map((seg) => {
          const f = decodeSegment(seg);
          const col = prev + f[0];
          prev = col;
          let out = col;
          for (const e of here) {
            // After the replaced keyword, or at or after an insertion.
            if (col >= e.column + e.remove) out += e.delta;
          }
          const rel = out - prevOut;
          prevOut = out;
          return encodeVlq(rel) + f.slice(1).map(encodeVlq).join("");
        })
        .join(",");
    })
    .join(";");
}

/**
 * The `type` values of a `<script>` whose text is JavaScript (HTML, "the
 * script element": a JavaScript MIME type essence match, or none, or
 * `module`). An import map, JSON or a template is not.
 */
function isJavaScriptType(type: string | undefined): boolean {
  if (type === undefined) return true;
  const t = type.trim().toLowerCase();
  return (
    t === "" ||
    t === "module" ||
    /^(application|text)\/(x-)?(java|ecma)script$/.test(t) ||
    /^text\/javascript1\.[0-5]$/.test(t) ||
    t === "text/jscript" ||
    t === "text/livescript"
  );
}

/**
 * The page `html` with the dynamic `import()` calls of its inline scripts
 * rewritten (an external script is rewritten as its own file). The
 * record bootstrap is not the page's and is left as it is.
 */
export function rewriteHtmlImports(html: string, name: string): string {
  const original = stripImportSeam(html);
  if (!original.includes("import")) return original;
  const spans: { from: number; to: number }[] = [];
  scanTags(original, (tag) => {
    if (tag.end || tag.name !== "script" || tag.rawTextEnd === undefined)
      return;
    const attrs = tagAttributes(tag.attributes);
    if (attrs.has("src") || attrs.has(BOOTSTRAP_MARKER)) return;
    if (!isJavaScriptType(attrs.get("type"))) return;
    spans.push({ from: tag.stop, to: tag.rawTextEnd });
  });
  if (spans.length === 0) return original;
  let out = "";
  let at = 0;
  for (const s of spans) {
    const body = original.slice(s.from, s.to);
    out += original.slice(at, s.from) + rewriteDynamicImports(body, name);
    at = s.to;
  }
  return out + original.slice(at);
}

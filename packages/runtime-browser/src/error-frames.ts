/**
 * The stack frames of a JavaScript error, as the boundary log's `Error`
 * record (CodeTracer's JS-Boundary-Recording specification §5.2) and the
 * browser error report (`error-report.ts`) both carry them: `{url, line,
 * col, fn}`, innermost first, at most {@link MAX_FRAMES}. One parser, so a
 * report and a boundary log name the same frames for the same error.
 */

/** The most frames an error carries. */
export const MAX_FRAMES = 32;

/** One frame: `{url, line, col, fn}`. */
export interface ErrorFrame {
  url: string;
  line: number;
  col: number;
  fn: string;
}

/**
 * V8's stack trace lines (https://v8.dev/docs/stack-trace-api): `at fn
 * (url:line:col)` or `at url:line:col`, `async` and `new` prefixes allowed.
 */
const V8_FRAME =
  /^\s*at (?:(?:async |new )?(?<fn>[^\s(][^(]*?) \()?(?<url>.+?):(?<line>\d+):(?<col>\d+)\)?\s*$/;

/** The frames of `stack` that V8's format names, innermost first. */
export function framesOf(stack: unknown): ErrorFrame[] {
  if (typeof stack !== "string") return [];
  const out: ErrorFrame[] = [];
  for (const line of stack.split("\n")) {
    const m = V8_FRAME.exec(line);
    if (m?.groups === undefined) continue;
    out.push({
      url: m.groups.url,
      line: Number(m.groups.line),
      col: Number(m.groups.col),
      fn: m.groups.fn ?? "",
    });
    if (out.length >= MAX_FRAMES) break;
  }
  return out;
}

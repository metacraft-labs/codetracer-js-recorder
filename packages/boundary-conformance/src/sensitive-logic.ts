/**
 * The pure functions the sensitive fixtures' declassifiers compute
 * (CodeTracer's JS-Boundary-Recording specification §11.3.2; the fixtures
 * in `fixtures.ts`), shared by the generic and the reference builds so the
 * two answer alike. Each output is bounded (a small integer or an enum) and
 * not a reversible function of its input, as a declassifier's must be.
 */

/** How many of the classes lowercase, uppercase, digit and other `s` holds (0 to 4). */
export function characterClasses(s: string): number {
  let n = 0;
  if (/[a-z]/.test(s)) n++;
  if (/[A-Z]/.test(s)) n++;
  if (/[0-9]/.test(s)) n++;
  if (/[^a-zA-Z0-9]/.test(s)) n++;
  return n;
}

/** What the `sensitive-email` fixture's declassifier answers. */
export type EmailKind = "invalid" | "valid" | "valid-mixed-case";

/** `invalid`, or which kind of well-formed address `s` is. */
export function emailKind(s: string): EmailKind {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) return "invalid";
  return /[A-Z]/.test(s) ? "valid-mixed-case" : "valid";
}

/**
 * Set by the build (esbuild `define`): the seeded fault of the
 * non-interference leg's falsifier (§11.3.6), a component that reads the
 * raw sensitive value outside a declassifier and branches a request's URL
 * on its first character.
 */
declare const __CT_FX_LEAK__: boolean | undefined;

/** Whether this build carries the raw-read fault. */
export const LEAK_RAW_READ: boolean =
  typeof __CT_FX_LEAK__ === "undefined" ? false : __CT_FX_LEAK__ === true;

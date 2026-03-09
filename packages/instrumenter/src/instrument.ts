import type { InstrumentOptions, InstrumentResult } from "./index.js";

/**
 * Instrument a JavaScript/TypeScript source file by inserting
 * __ct.step/enter/ret calls via SWC transformation.
 *
 * TODO(M1): Implement SWC visitor for statement and function instrumentation.
 */
export function instrument(
  _code: string,
  _options: InstrumentOptions,
): InstrumentResult {
  throw new Error("Not yet implemented — see milestone M1");
}

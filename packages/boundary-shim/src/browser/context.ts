/**
 * What every group of seams is given, and the small helpers they share for
 * replacing a platform property without changing how it looks to the page.
 */

import type { ShimOriginals } from "./originals.js";
import type { Recorder } from "./recorder.js";

/** The window type the shim runs in. */
export type ShimWindow = Window & typeof globalThis;

export interface SeamContext {
  w: ShimWindow;
  rec: Recorder;
  orig: ShimOriginals;
  /**
   * Write `Refusal{feature, detail}` the first time `feature` is used in
   * this session (JS-Boundary-Recording.md §7.5); later uses write nothing.
   */
  refuseOnce(feature: string, detail: string): void;
}

/**
 * Replace the data property `name` of `owner` with `value`, keeping its
 * enumerability, writability and configurability. Throws (into the
 * caller's guard) when the property cannot be replaced, so a seam that
 * could not be patched becomes a recorder fault rather than a silent hole
 * in the log.
 */
export function replaceValue(
  owner: object,
  name: string,
  value: unknown,
): void {
  const d = Object.getOwnPropertyDescriptor(owner, name);
  Object.defineProperty(owner, name, {
    value,
    writable: d?.writable ?? true,
    enumerable: d?.enumerable ?? true,
    configurable: d?.configurable ?? true,
  });
}

/** Replace the accessor `name` of `owner`, keeping its attributes. */
export function replaceAccessor(
  owner: object,
  name: string,
  get: (this: unknown) => unknown,
  set: ((this: unknown, v: unknown) => void) | undefined,
): void {
  const d = Object.getOwnPropertyDescriptor(owner, name);
  Object.defineProperty(owner, name, {
    get,
    set,
    enumerable: d?.enumerable ?? true,
    configurable: d?.configurable ?? true,
  });
}

/**
 * Make `patched` a drop-in replacement for the constructor `original`:
 * same prototype object (so `instanceof` and prototype patches keep
 * working), statics inherited, same `name` and `length`.
 */
export function asConstructor(patched: Function, original: Function): void {
  patched.prototype = original.prototype;
  Object.setPrototypeOf(patched, original);
  Object.defineProperty(patched, "name", { value: original.name });
  Object.defineProperty(patched, "length", { value: original.length });
}

const utf8 = new TextEncoder();

/** UTF-8 bytes of `s`. */
export function utf8Bytes(s: string): Uint8Array {
  return utf8.encode(s);
}

/** An inline `blobref` of `bytes` (§5.2, §5.4: the assembler moves large ones). */
export function inline(bytes: Uint8Array): {
  kind: "inline";
  bytes: Uint8Array;
} {
  return { kind: "inline", bytes };
}

/** The bytes of an `ArrayBuffer` or view, copied. */
export function copyBytes(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  return data instanceof ArrayBuffer
    ? new Uint8Array(data.slice(0))
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
}

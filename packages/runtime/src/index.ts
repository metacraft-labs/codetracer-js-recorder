/**
 * CodeTracer runtime library.
 *
 * Instrumented code calls these functions. Events are buffered in typed arrays
 * and flushed in batches to the Rust N-API addon.
 *
 * TODO(M2): Implement typed-array buffering, manifest loading, lifecycle hooks.
 */

export interface CtRuntime {
  init(manifestPath: string): void;
  step(siteId: number): void;
  enter(fnId: number, argsLike: IArguments): void;
  ret(fnId: number, value?: unknown): unknown;
}

/** Global runtime instance, initialized on first instrumented module load. */
export const __ct: CtRuntime = {
  init(_manifestPath: string): void {
    throw new Error("Not yet implemented — see milestone M2");
  },
  step(_siteId: number): void {
    throw new Error("Not yet implemented — see milestone M2");
  },
  enter(_fnId: number, _argsLike: IArguments): void {
    throw new Error("Not yet implemented — see milestone M2");
  },
  ret(_fnId: number, value?: unknown): unknown {
    throw new Error("Not yet implemented — see milestone M2");
    return value;
  },
};

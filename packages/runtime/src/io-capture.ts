/**
 * Console monkey-patching for IO capture.
 *
 * When recording, intercepts console.log, console.warn, console.error,
 * and console.info calls and records them as Write events in the trace.
 *
 * The original console methods are always called so that program output
 * is not affected.
 */

type WriteCallback = (kind: string, content: string) => void;

/** Saved original console methods for restoration. */
let savedLog: typeof console.log | null = null;
let savedWarn: typeof console.warn | null = null;
let savedError: typeof console.error | null = null;
let savedInfo: typeof console.info | null = null;

/**
 * Format console arguments to a single string, similar to how Node.js
 * formats console.log output.
 */
function formatArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      try {
        return String(arg);
      } catch {
        return "[object]";
      }
    })
    .join(" ");
}

/**
 * Install console capture.
 *
 * Replaces console.log/warn/error/info with wrappers that call the
 * original method AND invoke `onWrite` with the output kind and content.
 *
 * - console.log, console.info -> kind = "stdout"
 * - console.warn, console.error -> kind = "stderr"
 *
 * @param onWrite Callback invoked for each console write with (kind, content)
 */
export function installConsoleCapture(onWrite: WriteCallback): void {
  // Save originals
  savedLog = console.log;
  savedWarn = console.warn;
  savedError = console.error;
  savedInfo = console.info;

  console.log = (...args: unknown[]) => {
    savedLog!.apply(console, args);
    try {
      onWrite("stdout", formatArgs(args));
    } catch {
      // Never let capture errors affect the program
    }
  };

  console.info = (...args: unknown[]) => {
    savedInfo!.apply(console, args);
    try {
      onWrite("stdout", formatArgs(args));
    } catch {
      // Never let capture errors affect the program
    }
  };

  console.warn = (...args: unknown[]) => {
    savedWarn!.apply(console, args);
    try {
      onWrite("stderr", formatArgs(args));
    } catch {
      // Never let capture errors affect the program
    }
  };

  console.error = (...args: unknown[]) => {
    savedError!.apply(console, args);
    try {
      onWrite("stderr", formatArgs(args));
    } catch {
      // Never let capture errors affect the program
    }
  };
}

/**
 * Remove console capture, restoring original console methods.
 */
export function removeConsoleCapture(): void {
  if (savedLog) console.log = savedLog;
  if (savedWarn) console.warn = savedWarn;
  if (savedError) console.error = savedError;
  if (savedInfo) console.info = savedInfo;

  savedLog = null;
  savedWarn = null;
  savedError = null;
  savedInfo = null;
}

/**
 * The browser error reporter: an uncaught error in a page (a window `error`
 * event of a script error, or an `unhandledrejection`) becomes one scrubbed
 * error report, uploaded to the site's endpoint with the W3C `traceparent`
 * of the server-rendered response (`trace-context.ts`), so the error can be
 * joined to the backend span that served the page.
 *
 * It is off unless the site turns it on, and even then nothing leaves the
 * page without consent:
 *
 * - **Inert unless enabled.** {@link installErrorReporter} with `enabled`
 *   other than `true`, or without a usable `http(s)` endpoint, installs no
 *   listener and makes no request.
 * - **Privacy signals.** When the browser sends Do Not Track
 *   (`navigator.doNotTrack == "1"`) or Global Privacy Control
 *   (`navigator.globalPrivacyControl === true`) the reporter installs no
 *   listener and makes no request: the same predicate, `privacySignal`, the
 *   boundary recorder's transport uses. The signals are read again before
 *   each upload.
 * - **Consent, per report.** Each report is handed, exactly as it would be
 *   sent, to the page's consent callback, which answers a boolean or a native
 *   promise of one; only `true` uploads that report. No callback, anything
 *   else, a throw or a rejection is no, and the report is dropped, never
 *   queued for later.
 * - **Scrubbed before it is shown or sent.** The message is reduced to its
 *   template and every URL in the report is scrubbed by the rules the
 *   boundary recorder applies to its log (`scrub.ts`); the value of every
 *   sensitive field (`sensitive.ts`: a credential field always, a free-text
 *   field unless the page marks it public) is holed in the message, the
 *   error class, the frames and the URLs first. The report carries no
 *   request or response header and no cookie, and the upload is made with
 *   no credentials and no referrer, so neither a cookie, an `Authorization`
 *   header nor the page's unscrubbed URL goes with it.
 *
 * Every platform function it calls (`fetch`, `addEventListener`,
 * `Promise.prototype.then`) is one captured before a boundary shim patched
 * it (`resolveTransportOriginals`), so on a page recorded at the boundary its
 * upload is not recorded as the page's request.
 *
 * References: HTML's error reporting
 * (https://html.spec.whatwg.org/multipage/webappapis.html#runtime-script-errors)
 * and unhandled rejections
 * (https://html.spec.whatwg.org/multipage/webappapis.html#unhandled-promise-rejections);
 * the Fetch standard's `keepalive` and its 64 KiB in-flight budget
 * (https://fetch.spec.whatwg.org/#http-network-or-cache-fetch); Do Not Track
 * (https://www.w3.org/TR/tracking-dnt/#dom-navigator-donottrack); Global
 * Privacy Control (https://privacycg.github.io/gpc-spec/#dom-globalprivacycontrol).
 */

import {
  type PrivacySignals,
  type TransportOriginals,
  privacySignal,
  resolveTransportOriginals,
} from "./batch-transport.js";
import { type ErrorFrame, framesOf } from "./error-frames.js";
import {
  NO_SCRUB_LISTS,
  type ScrubLists,
  readScrubList,
  scrubUrl,
  templateErrorMessage,
} from "./scrub.js";
import {
  currentSensitiveValues,
  holeText,
  sensitiveState,
  type SensitiveState,
} from "./sensitive.js";
import { readPageTraceContext, timelineThrough } from "./trace-context.js";

/** The `schema` of a report this module writes. */
export const ERROR_REPORT_SCHEMA = "codetracer.browser-error-report/1";

/** The default, and the largest, number of reports a page captures. */
export const DEFAULT_MAX_REPORTS = 8;
export const MAX_MAX_REPORTS = 64;

/** The longest URL, function name and error class a report carries. */
const MAX_URL = 2048;
const MAX_FN = 256;
const MAX_CLASS = 128;

/** A body this size or smaller goes as a `keepalive` request (Fetch's budget). */
const KEEPALIVE_BODY_LIMIT = 64 * 1024;

/** What raised the report. */
export type ErrorReportKind = "error" | "unhandledrejection";

/**
 * One error report, as it is shown to the consent callback and uploaded
 * (as JSON, `Content-Type: application/json`).
 */
export interface BrowserErrorReport {
  schema: typeof ERROR_REPORT_SCHEMA;
  kind: ErrorReportKind;
  /**
   * The error's class: the `Error`'s `name` (`TypeError`, a page's own
   * subclass), the tag of any other object thrown (`Object`), or the type
   * of a primitive (`String`, `Number`, …); `Error` when it is not an
   * identifier.
   */
  error_class: string;
  /** The message reduced to its template (no raw value). */
  message: string;
  /** The stack frames, innermost first, at most 32, their URLs scrubbed. */
  frames: ErrorFrame[];
  /** The page's URL, scrubbed. */
  page_url: string;
  /** The server-rendered response's W3C `traceparent`, or `null`. */
  traceparent: string | null;
  /** When the error was captured, milliseconds since the Unix epoch. */
  occurred_at_unix_ms: number;
}

/** What the page's consent callback answers: a boolean, or a promise of one. */
export type ReportConsentAnswer = boolean | Promise<boolean>;

/**
 * The page's consent callback: shown the report exactly as it would be sent
 * (a frozen copy), it answers whether to send it.
 */
export type ReportConsentCallback = (
  report: Readonly<BrowserErrorReport>,
) => ReportConsentAnswer;

/** How a site configures the reporter. */
export interface ErrorReporterOptions {
  /** Must be `true` for the reporter to do anything (it is off by default). */
  enabled?: boolean;
  /** Where reports are POSTed; resolved against the page's URL; `http(s)` only. */
  endpoint?: string;
  /** The consent callback (also settable later with {@link ErrorReporter.consent}). */
  consent?: ReportConsentCallback;
  /**
   * Query (and fragment) keys whose values are scrubbed in every URL of a
   * report, besides the values of credential shape (the site's list, read
   * as the boundary recorder reads its own).
   */
  scrubQueryKeys?: readonly unknown[];
  /** The most reports a page captures (default {@link DEFAULT_MAX_REPORTS}, at most {@link MAX_MAX_REPORTS}). */
  maxReports?: number;
  /** Platform functions to use instead of the resolved originals. */
  originals?: Partial<TransportOriginals>;
  /** The window to report from (default: the global one). */
  window?: Window & typeof globalThis;
}

/** Where the reporter is, and what it has done. */
export interface ErrorReporterStatus {
  state: "on" | "off";
  /** Why it is off: `disabled`, `dnt`, `gpc`, `no-endpoint`, `no-fetch`, `stopped`, `failed`. */
  reason: string | undefined;
  /** Reports built (each error captured, duplicates and those past the cap excepted). */
  captured: number;
  /** Reports whose consent callback answered yes and that were sent. */
  sent: number;
  /** Uploads the endpoint answered with a 2xx status. */
  accepted: number;
  /** Reports dropped: no callback, a no, a privacy signal at upload time. */
  declined: number;
  /** Uploads that failed (a network error or a non-2xx answer). */
  failed: number;
}

/** The installed reporter. */
export interface ErrorReporter {
  /** Set (or replace) the consent callback. */
  consent(callback: ReportConsentCallback): void;
  /** Where the reporter is. */
  status(): ErrorReporterStatus;
  /** Stop capturing; reports already handed to the consent callback may still be sent. */
  stop(): void;
}

/** An identifier, as an error class must be (a page's subclass name included). */
const CLASS_NAME = /^[A-Za-z_$][\w$.]*$/;

/** What was thrown, read without letting a page's getter or `toString` throw out. */
interface Thrown {
  errorClass: string;
  message: string;
  stack: unknown;
}

function safeGet(o: object, key: string): unknown {
  try {
    return (o as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** The class, message and stack of a thrown value (see {@link BrowserErrorReport.error_class}). */
function describeThrown(w: Window & typeof globalThis, value: unknown): Thrown {
  if (
    value !== null &&
    (typeof value === "object" || typeof value === "function")
  ) {
    let isError = false;
    try {
      isError = value instanceof w.Error;
    } catch {
      isError = false;
    }
    if (isError) {
      const name = safeGet(value, "name");
      const message = safeGet(value, "message");
      return {
        errorClass: typeof name === "string" ? name : "Error",
        message: typeof message === "string" ? message : "",
        stack: safeGet(value, "stack"),
      };
    }
    let tag = "Object";
    try {
      tag = Object.prototype.toString.call(value).slice(8, -1);
    } catch {
      tag = "Object";
    }
    return { errorClass: tag, message: "", stack: undefined };
  }
  const type = typeof value;
  const errorClass =
    value === null ? "Null" : type.charAt(0).toUpperCase() + type.slice(1);
  let message = "";
  if (type === "string") message = value as string;
  else if (type === "number" || type === "boolean" || type === "bigint") {
    message = String(value);
  } else if (type === "symbol") {
    message = (value as symbol).description ?? "";
  }
  return { errorClass, message, stack: undefined };
}

/** The text before the report is scrubbed (never shown, never sent). */
export interface RawErrorReport {
  kind: ErrorReportKind;
  errorClass: string;
  message: string;
  frames: ErrorFrame[];
  pageUrl: string;
  traceparent: string | null;
  occurredAtUnixMs: number;
}

function cut(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}

/**
 * `raw` scrubbed into the report that is shown and sent: every value of
 * `holes` (the sensitive values, longest first) holed in the class, the
 * message, the frames and the URLs; the message reduced to its template;
 * every URL's query and fragment values of the listed keys and of credential
 * shape replaced by `<scrubbed>`. The same rules, by the same functions, as
 * the boundary recorder's `Error` record and URLs.
 */
export function scrubErrorReport(
  raw: RawErrorReport,
  lists: ScrubLists,
  holes: readonly string[],
): BrowserErrorReport {
  const url = (u: string): string =>
    u === "" ? u : cut(scrubUrl(holeText(u, holes), lists), MAX_URL);
  const errorClass = holeText(raw.errorClass, holes);
  return {
    schema: ERROR_REPORT_SCHEMA,
    kind: raw.kind,
    error_class:
      CLASS_NAME.test(errorClass) && errorClass.length <= MAX_CLASS
        ? errorClass
        : "Error",
    message: templateErrorMessage(holeText(raw.message, holes)),
    frames: raw.frames.map((f) => ({
      url: url(f.url),
      line: f.line,
      col: f.col,
      fn: cut(holeText(f.fn, holes), MAX_FN),
    })),
    page_url: url(raw.pageUrl),
    traceparent: raw.traceparent,
    occurred_at_unix_ms: raw.occurredAtUnixMs,
  };
}

/** A copy of `report` the consent callback may look at but not change. */
function frozenCopy(report: BrowserErrorReport): Readonly<BrowserErrorReport> {
  const copy = JSON.parse(JSON.stringify(report)) as BrowserErrorReport;
  for (const f of copy.frames) Object.freeze(f);
  Object.freeze(copy.frames);
  return Object.freeze(copy);
}

/** The endpoint as an absolute `http(s)` URL with no user info, or `undefined`. */
function resolveEndpoint(
  endpoint: unknown,
  base: string | undefined,
): string | undefined {
  if (typeof endpoint !== "string" || endpoint === "") return undefined;
  let u: URL;
  try {
    u = base === undefined ? new URL(endpoint) : new URL(endpoint, base);
  } catch {
    return undefined;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
  if (u.username !== "" || u.password !== "") return undefined;
  return u.href;
}

/**
 * `Date.now` as it was before a boundary shim patched it (the replay
 * runner's, else the shim's published original, else the global), so the
 * report's own clock read is not logged as a read of the page.
 */
function originalDateNow(): () => number {
  const g = globalThis as {
    __ctReplay?: { originals?: { dateNow?: () => number } };
    __ctBoundaryShim?: { originals?: { dateNow?: () => number } };
  };
  return (
    g.__ctReplay?.originals?.dateNow ??
    g.__ctBoundaryShim?.originals?.dateNow ??
    Date.now
  );
}

/**
 * The UTF-8 length of `s`, the bytes `fetch` sends for a string body and
 * counts against the `keepalive` budget (a `.length` counts UTF-16 code
 * units, up to three times fewer than the bytes of text outside ASCII; a
 * `keepalive` request over the budget fails instead of being sent). A lone
 * surrogate counts as the three bytes of U+FFFD it is encoded as.
 */
export function utf8Bytes(s: string): number {
  let bytes = 0;
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (
      c >= 0xd800 &&
      c <= 0xdbff &&
      k + 1 < s.length &&
      (s.charCodeAt(k + 1) & 0xfc00) === 0xdc00
    ) {
      bytes += 4;
      k++;
    } else bytes += 3;
  }
  return bytes;
}

function clampReports(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_MAX_REPORTS;
  return Math.min(MAX_MAX_REPORTS, Math.max(1, Math.floor(n)));
}

/**
 * Install the error reporter on the page (see the module comment). Call it
 * as early as the page can, before the page's own code, so that the
 * platform getters the sensitive-field rules read through are the
 * platform's. Never throws; whatever it cannot do turns it off.
 */
export function installErrorReporter(
  options: ErrorReporterOptions = {},
): ErrorReporter {
  const w =
    options.window ?? (globalThis as unknown as Window & typeof globalThis);
  const status: ErrorReporterStatus = {
    state: "off",
    reason: undefined,
    captured: 0,
    sent: 0,
    accepted: 0,
    declined: 0,
    failed: 0,
  };
  let consentCallback: ReportConsentCallback | undefined = options.consent;
  const off = (reason: string): void => {
    status.state = "off";
    status.reason ??= reason;
  };
  const reporter: ErrorReporter = {
    consent(callback: ReportConsentCallback): void {
      if (typeof callback === "function") consentCallback = callback;
    },
    status(): ErrorReporterStatus {
      return { ...status };
    },
    stop(): void {
      off("stopped");
    },
  };

  try {
    if (options.enabled !== true) {
      off("disabled");
      return reporter;
    }
    const signal = privacySignal(w.navigator as PrivacySignals | undefined);
    if (signal !== undefined) {
      off(signal);
      return reporter;
    }
    let base: string | undefined;
    try {
      base = w.location.href;
    } catch {
      base = undefined;
    }
    const endpoint = resolveEndpoint(options.endpoint, base);
    if (endpoint === undefined) {
      off("no-endpoint");
      return reporter;
    }
    const orig = resolveTransportOriginals(options.originals);
    if (orig.fetch === undefined || orig.addEventListener === undefined) {
      off("no-fetch");
      return reporter;
    }
    const lists: ScrubLists = {
      ...NO_SCRUB_LISTS,
      queryKeys: readScrubList(options.scrubQueryKeys),
    };
    // Made now, before the page's code can patch the getters it reads
    // field values through (or found, when a boundary shim made it first).
    const sensitive: SensitiveState = sensitiveState(w);
    const maxReports = clampReports(options.maxReports);
    const now = originalDateNow();
    const seen = new Set<string>();
    const then = <T>(
      p: Promise<T>,
      ok: (value: T) => unknown,
      err: (reason: unknown) => unknown,
    ): void => {
      (
        orig.promiseThen as (
          this: Promise<T>,
          ok: (value: T) => unknown,
          err: (reason: unknown) => unknown,
        ) => unknown
      ).call(p, ok, err);
    };

    const upload = (body: string): void => {
      // Read again: a signal turned on after load still stops the upload.
      const later = privacySignal(w.navigator as PrivacySignals | undefined);
      if (later !== undefined || status.state !== "on") {
        status.declined++;
        return;
      }
      status.sent++;
      let request: Promise<Response>;
      try {
        request = orig.fetch!.call(w, endpoint, {
          method: "POST",
          credentials: "omit",
          referrerPolicy: "no-referrer",
          keepalive: utf8Bytes(body) <= KEEPALIVE_BODY_LIMIT,
          headers: { "Content-Type": "application/json" },
          body,
        });
      } catch {
        status.failed++;
        return;
      }
      then(
        request,
        (res) => {
          if (res.ok) status.accepted++;
          else status.failed++;
        },
        () => {
          status.failed++;
        },
      );
    };

    const ask = (report: BrowserErrorReport): void => {
      const callback = consentCallback;
      if (callback === undefined) {
        status.declined++;
        return;
      }
      // Built before the callback runs: what it is shown is what is sent.
      const body = JSON.stringify(report);
      let answer: unknown;
      try {
        answer = callback(frozenCopy(report));
      } catch {
        answer = false;
      }
      const decide = (yes: unknown): void => {
        if (yes === true) upload(body);
        else status.declined++;
      };
      if (typeof answer === "boolean") decide(answer);
      else if (answer instanceof orig.Promise) {
        // Only a native promise: a page's thenable is not an answer.
        then(answer as Promise<unknown>, decide, () => decide(false));
      } else decide(false);
    };

    const capture = (
      kind: ErrorReportKind,
      thrown: Thrown,
      fallback: ErrorFrame | undefined,
    ): void => {
      if (status.state !== "on") return;
      if (status.captured >= maxReports) return;
      let frames = framesOf(thrown.stack);
      if (frames.length === 0 && fallback !== undefined) frames = [fallback];
      let pageUrl = "";
      try {
        pageUrl = w.location.href;
      } catch {
        pageUrl = "";
      }
      // The timeline is read through the captured original: on a page a
      // boundary shim records, the patched method would log this read as
      // the page's.
      const trace = readPageTraceContext(
        w.document as unknown as Parameters<typeof readPageTraceContext>[0],
        timelineThrough(w.performance, orig.getEntriesByType),
      );
      const raw: RawErrorReport = {
        kind,
        errorClass: thrown.errorClass,
        message: thrown.message,
        frames,
        pageUrl,
        traceparent: trace?.value ?? null,
        occurredAtUnixMs: now.call(Date),
      };
      const report = scrubErrorReport(
        raw,
        lists,
        currentSensitiveValues(w, sensitive),
      );
      // The same error raised again (a handler that throws on every click)
      // is one report.
      const key = JSON.stringify([
        report.kind,
        report.error_class,
        report.message,
        report.frames[0] ?? null,
      ]);
      if (seen.has(key)) return;
      seen.add(key);
      status.captured++;
      ask(report);
    };

    const guard = (f: () => void): void => {
      try {
        f();
      } catch {
        // A reporter must never throw into the page it reports on.
        status.failed++;
        off("failed");
      }
    };

    orig.addEventListener.call(
      w,
      "error",
      (ev: Event) =>
        guard(() => {
          // A script error reaches the window as an ErrorEvent targeted at
          // it; a resource element's `error` does not (HTML, "report an
          // exception").
          if (!(ev instanceof w.ErrorEvent) || ev.target !== w) return;
          const thrown = describeThrown(w, ev.error);
          const message = typeof ev.message === "string" ? ev.message : "";
          capture(
            "error",
            {
              errorClass:
                ev.error === null || ev.error === undefined
                  ? "Error"
                  : thrown.errorClass,
              // The event's message, as the boundary log's `Error` record
              // has it, so both template the same text.
              message,
              stack: thrown.stack,
            },
            ev.filename
              ? {
                  url: ev.filename,
                  line: ev.lineno,
                  col: ev.colno,
                  fn: "",
                }
              : undefined,
          );
        }),
      { capture: true },
    );
    orig.addEventListener.call(w, "unhandledrejection", (ev: Event) =>
      guard(() => {
        const reason = (ev as PromiseRejectionEvent).reason as unknown;
        capture("unhandledrejection", describeThrown(w, reason), undefined);
      }),
    );
    status.state = "on";
  } catch {
    off("failed");
  }
  return reporter;
}

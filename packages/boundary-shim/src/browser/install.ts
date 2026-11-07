/**
 * Install the generic boundary shim in record mode
 * (JS-Boundary-Recording.md §10): capture the originals, write `Header`
 * and `Env`, patch the seams of §10.1, listen for input (§10.2), and
 * publish the control surface on `globalThis.__ctBoundaryShim`. With an
 * ingest configured the log is uploaded through `HttpBatchTransport`
 * (§11.1); when the browser sends Do Not Track or Global Privacy Control
 * the shim does not install at all (§11.2).
 *
 * Must run before any of the page's own code: the bootstrap `<script>` is
 * the first element of `<head>` (see the package's `injectBoundaryShim`).
 */

import {
  type ConsentCallback,
  HttpBatchTransport,
  privacySignal,
  type TransportStatus,
} from "@codetracer/runtime-browser/dist/batch-transport.js";
import {
  readPageTraceContext,
  timelineThrough,
} from "@codetracer/runtime-browser/dist/trace-context.js";

import {
  CONTROL_GLOBAL,
  IMPORT_SEAM_CAPABILITY,
  RECORDER_NAME,
  type ShimConfig,
} from "./config.js";
import type { SeamContext, ShimWindow } from "./context.js";
import { declaredArms } from "./declarations.js";
import { domV1Hash } from "./dom-v1.js";
import { recordDocumentProgress } from "./document-progress.js";
import { captureOriginals, type ShimOriginals } from "./originals.js";
import { Recorder } from "./recorder.js";
import { listenForPageEvents, patchDomSeams } from "./seams-dom.js";
import { patchNotifications } from "./seams-notification.js";
import { listenForStorageEvents, patchMessageSeams } from "./seams-message.js";
import { patchEnvironmentSeams } from "./seams-environment.js";
import { patchImportSeam } from "./seams-import.js";
import { patchMediaSeams } from "./seams-media.js";
import { patchNetSeams } from "./seams-net.js";
import { patchPerformance } from "./seams-perf.js";
import { patchPlatformSeams } from "./seams-platform.js";
import { patchRefusals } from "./seams-refusals.js";
import { patchTimeSeams } from "./seams-time.js";
import { listenForPageErrors } from "./seams-error.js";
import { rescrubFrame, sanitizeRecord } from "./record-scrub.js";
import {
  addsToScrubLists,
  joinScrubLists,
  NO_SCRUB_LISTS,
  type ScrubLists,
} from "./scrub.js";
import {
  canonicalOutput,
  type CtApi,
  currentSensitiveValues,
  makeCtApi,
  publishCtApi,
  rememberShadowFieldReads,
  sensitiveState,
  trackShadowRoots,
} from "./sensitive.js";

/** The shim's version; `Header.recorder_id` is `codetracer-boundary-shim/<this>`. */
export const SHIM_VERSION = "0.1.0";

/** The checkpoint scheme of protocol level 0 (§7.3). */
export const DOM_V1 = "dom-v1";

/** `End.reason` (§5.2). */
const EndReason = { pagehide: 1, stop: 2 };

/**
 * The `Refusal.feature` of a declassifier call the log cannot carry
 * (§7.5, §11.3.2): its output is not JSON data, or it threw.
 */
export const UNRECORDABLE_DECLASSIFIER = "unrecordable-declassifier";

/** What the installed shim publishes on `globalThis.__ctBoundaryShim`. */
export interface ShimControl {
  /** Always 0: the generic shim (§9.1). */
  readonly protocolLevel: 0;
  /** `Header.session_id`. */
  readonly sessionId: string;
  /**
   * The platform functions as they were before the shim patched them. The
   * `__ct` runtime uses these, so its own timers and socket are not part
   * of the recorded page (§6).
   */
  readonly originals: ShimOriginals;
  /** Whether records are still being written. */
  readonly recording: boolean;
  /**
   * The log so far as a `jsbound.log` stream. Bodies are inlined whatever
   * their size, as in an uploaded batch (§5.2), so a log carrying a body
   * over 1024 bytes is a batch rather than an assembled `jsbound.log`.
   * Without an ingest this is how the log leaves the page; with one the
   * frames belong to the upload transport, and this throws.
   */
  log(): Uint8Array;
  /** The frames so far without the stream prefix: an upload batch's body. Throws when uploading, as `log()`. */
  frames(): Uint8Array;
  /**
   * End the session: a final checkpoint, then `End{reason: explicit stop}`.
   * Resolves once the final batch has been answered when uploading (or
   * the transport is off), at once otherwise.
   */
  stop(): Promise<void>;
  /**
   * Register the site's consent callback (§11.2). It is called at once,
   * here, and again by a replay of the page at the same point; with
   * consent required, nothing is requested until it answers yes (a
   * boolean, or a promise of one). Without an ingest it is only called.
   */
  consent(callback: ConsentCallback): void;
  /** The upload transport's state, `undefined` without an ingest. */
  uploadStatus(): TransportStatus | undefined;
  /** The `dom-v1` hash of the document now. */
  domV1Hash(): string;
  /** Test seam: the next frame the encoder is asked for throws. */
  injectEncoderFault(): void;
  /**
   * The page's sensitive-input API (§11.3.1, §11.3.2), also published as
   * `globalThis.ct` when the page has no `ct` of its own.
   */
  readonly ct: CtApi;
}

/**
 * Install the shim on `w` and return its control surface. A second call
 * returns the first installation's control. When the browser sends Do Not
 * Track or Global Privacy Control the recorder does not start (§11.2):
 * nothing is patched or published, and this returns `undefined`.
 */
export function installBoundaryShim(
  w: ShimWindow,
  config: ShimConfig = {},
): ShimControl | undefined {
  const existing = (w as unknown as Record<string, ShimControl | undefined>)[
    CONTROL_GLOBAL
  ];
  if (existing !== undefined) return existing;
  const sensitive = sensitiveState(w);
  if (privacySignal(w.navigator) !== undefined) {
    // Nothing is recorded, but a page that declares its fields and
    // declassifiers must still run: its `ct` calls run the declassifier and
    // log nothing (§11.2, §11.3.2).
    publishCtApi(
      w,
      makeCtApi(w, sensitive, (_id, fn, self, args) => fn.apply(self, args)),
    );
    return undefined;
  }

  const orig = captureOriginals(w);
  // The site's scrub lists (§11.3.5): the ingest's `config` carries them,
  // and no batch is sent before it arrives; the frames written before are
  // scrubbed again with them then (`onConfig`).
  let lists: ScrubLists = NO_SCRUB_LISTS;
  const holes = () => currentSensitiveValues(w, sensitive);
  const doc = w.document;
  const sessionId = newSessionId(w, orig);
  // The transport is made before the first frame is written, with the
  // originals captured above: its requests and timers are not the page's.
  const late: { rec?: Recorder } = {};
  const transport =
    config.ingest === undefined
      ? undefined
      : new HttpBatchTransport({
          ingest: config.ingest,
          sessionId,
          buildHash: config.buildHash ?? "",
          consentRequired: config.consentRequired === true,
          ringBytes: config.ringBytes,
          originals: orig,
          window: w,
          // No consent, or the ingest disabled recording: stop recording,
          // since the records could go nowhere.
          onDisabled: () => late.rec?.halt(),
          onConfig: (c) => {
            const site: ScrubLists = {
              headers: c.scrubHeaders,
              queryKeys: c.scrubQueryKeys,
            };
            if (!addsToScrubLists(lists, site)) return undefined;
            lists = joinScrubLists(lists, site);
            const now = lists;
            return (frame) => rescrubFrame(frame, now);
          },
        });
  const rec = new Recorder({
    checkpointHash: () => domV1Hash(doc),
    checkpointScheme: DOM_V1,
    sink: transport,
    sanitize: (r) => sanitizeRecord(r, lists, holes),
  });
  late.rec = rec;
  if (transport?.status().state === "off") rec.halt();

  rec.start(
    {
      vocab: 1,
      protocol_level: 0,
      recorder_id: `${RECORDER_NAME}/${SHIM_VERSION}`,
      framework: "",
      build_hash: config.buildHash ?? "",
      session_id: sessionId,
      prev_session: config.prevSession ?? "",
      // The dynamic import() seam is the one capability a level-0 session
      // declares: the deploy step was asked to put it into the page (§8.1).
      capabilities: JSON.stringify(
        config.importSeam === true ? [IMPORT_SEAM_CAPABILITY] : [],
      ),
    },
    readEnvironment(w, orig),
  );

  const refused = new Set<string>();
  const ctx: SeamContext = {
    w,
    rec,
    orig,
    sensitive,
    holes,
    refuseOnce(feature, detail) {
      if (refused.has(feature) || !rec.recording) return;
      refused.add(feature);
      rec.guard(() => rec.emit("Refusal", { feature, detail }));
    },
  };

  // The document's own loading (§6, "The document's own tasks"): its
  // listeners go first, so a script's `DocTask` precedes the page's own
  // listeners of its `load`.
  rec.guard(() => recordDocumentProgress(w, rec, orig.addEventListener));
  // A seam that cannot be patched would leave a silent hole in the log, so
  // it is a recorder fault: the log says why it stops.
  for (const patch of [
    // The shadow roots the page attaches, before it can attach one: the
    // field focused in a closed one is found through them (§11.3.3).
    (c: SeamContext) => trackShadowRoots(c.w, c.sensitive),
    // A sensitive field in a shadow tree whose value the page reads: its
    // value is holed wherever the page sends it (§11.3.1, §5.2.1).
    (c: SeamContext) => rememberShadowFieldReads(c.w, c.sensitive),
    patchTimeSeams,
    patchNetSeams,
    patchDomSeams,
    patchPlatformSeams,
    patchPerformance,
    patchMessageSeams,
    patchRefusals,
    patchMediaSeams,
    patchEnvironmentSeams,
    // After the environment seams: the constructor it replaces inherits the
    // statics they patched.
    patchNotifications,
    // Only where the deploy step rewrote the page's import() calls into
    // calls of the seam (§8.1); the Header declares it above.
    ...(config.importSeam === true ? [patchImportSeam] : []),
  ]) {
    rec.guard(() => patch(ctx));
  }
  rec.guard(() => listenForStorageEvents(ctx, storageAreaNamer(w, orig)));
  rec.guard(() =>
    listenForPageEvents(ctx, () => rec.end(EndReason.pagehide, true)),
  );
  rec.guard(() => listenForPageErrors(ctx));
  // A mark made inside a declassifier's body is part of that body, which
  // replay does not run, and could carry what the body was given: it is not
  // logged. One depth for both, so they agree on what "inside" is.
  const declassifying = { depth: 0 };
  const ct = makeCtApi(
    w,
    sensitive,
    recordDeclassifier(ctx, declassifying),
    (name, data) => {
      if (!rec.recording || declassifying.depth > 0) return;
      rec.guard(() => rec.emit("Mark", { name, data }));
    },
  );
  publishCtApi(w, ct);

  const inMemory = <T>(read: () => T): T => {
    if (transport !== undefined) {
      throw new Error(
        "the boundary shim uploads its log (an ingest is configured): it is not kept in the page",
      );
    }
    return read();
  };
  const control: ShimControl = {
    protocolLevel: 0,
    sessionId,
    originals: orig,
    get recording() {
      return rec.recording;
    },
    log: () => inMemory(() => rec.log()),
    frames: () => inMemory(() => rec.frameRun()),
    stop: () => {
      rec.end(EndReason.stop);
      return transport?.end() ?? orig.Promise.resolve();
    },
    consent: (callback) => {
      if (transport !== undefined) {
        transport.consent(callback);
        return;
      }
      try {
        callback();
      } catch {
        // Its answer, or its failure, is nobody's business without an ingest.
      }
    },
    uploadStatus: () => transport?.status(),
    domV1Hash: () => domV1Hash(doc),
    injectEncoderFault: () => rec.injectEncoderFault(),
    ct,
  };
  Object.defineProperty(w, CONTROL_GLOBAL, {
    value: control,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return control;
}

/**
 * How a declassifier runs on record (§11.3.2): the real value goes in, the
 * function runs, and its output is logged as `Declassify{fn_id, output}`
 * and returned. Only the outermost call is logged: a declassifier a
 * declassifier calls is part of the outer one's body, which replay does not
 * run. An output that is not JSON data, or a declassifier that throws, is
 * refused (`unrecordable-declassifier`, §7.5): the log could not return it.
 */
function recordDeclassifier(
  ctx: SeamContext,
  declassifying: { depth: number },
): Parameters<typeof makeCtApi>[2] {
  const { rec } = ctx;
  return (id, fn, self, args) => {
    if (!rec.recording || declassifying.depth > 0) return fn.apply(self, args);
    let out: unknown;
    declassifying.depth++;
    try {
      out = fn.apply(self, args);
    } catch (e) {
      ctx.refuseOnce(UNRECORDABLE_DECLASSIFIER, `${id} threw`);
      throw e;
    } finally {
      declassifying.depth--;
    }
    rec.guard(() => {
      const output = canonicalOutput(out);
      if (output === undefined) {
        ctx.refuseOnce(
          UNRECORDABLE_DECLASSIFIER,
          `${id} returned a value that is not JSON data`,
        );
      } else {
        rec.emit("Declassify", { fn_id: id, output });
      }
    });
    return out;
  };
}

/**
 * The name a storage event's `Input` gives its area (§10.4): the real
 * `localStorage` and `sessionStorage` objects, read through the captured
 * getters (a document denied storage has neither).
 */
function storageAreaNamer(
  w: ShimWindow,
  orig: ShimOriginals,
): (s: Storage | null) => "localStorage" | "sessionStorage" | null {
  const real = new Map<Storage, "localStorage" | "sessionStorage">();
  for (const name of ["localStorage", "sessionStorage"] as const) {
    try {
      const s = orig.storageAreas.get(name)?.descriptor.get!.call(w) as
        | Storage
        | undefined;
      if (s !== undefined) real.set(s, name);
    } catch {
      // Storage denied to this document.
    }
  }
  return (s) => (s === null ? null : (real.get(s) ?? null));
}

/** A client-minted 128-bit random session id, lowercase hex (§5.2). */
function newSessionId(w: ShimWindow, orig: ShimOriginals): string {
  const b = new Uint8Array(16);
  orig.getRandomValues.call(w.crypto, b);
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function u16(v: number): number {
  return Number.isInteger(v) && v >= 0 && v <= 0xffff ? v : 0;
}

function u32(v: number): number {
  const n = Math.floor(v);
  return Number.isFinite(n) && n >= 0 && n <= 0xffffffff ? n : 0;
}

/**
 * The `Env` record, read before any seam is patched so none of it is
 * logged as the page's (a cooperating framework that records natively
 * reads it the same way). `color_scheme` is 0 (no preference), 1 (light) or
 * 2 (dark); `reduced_motion` is 1 when the user asked for reduced motion.
 * `traceparent` is the W3C trace context of the server-rendered response
 * (`readPageTraceContext`, the reader the browser error reporter uses): a
 * `<meta name="traceparent">` the parser has already put in the document
 * (one before the bootstrap), else the navigation's `Server-Timing`
 * `traceparent` entry, read through the captured original; empty when
 * neither is a well-formed one.
 */
export function readEnvironment(w: ShimWindow, orig: ShimOriginals) {
  const nav = w.navigator;
  const ua = nav.userAgent;
  const major = /(?:Chrome|Chromium|Firefox|Version)\/(\d+)/.exec(ua);
  const media = (q: string) => {
    try {
      return orig.matchMedia?.call(w, q).matches === true;
    } catch {
      return false;
    }
  };
  let tz = "";
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    tz = "";
  }
  let referrerOrigin = "";
  try {
    referrerOrigin = w.document.referrer
      ? new URL(w.document.referrer).origin
      : "";
  } catch {
    referrerOrigin = "";
  }
  return {
    ua,
    ua_major: u16(major === null ? 0 : Number(major[1])),
    viewport_w: u32(w.innerWidth),
    viewport_h: u32(w.innerHeight),
    dpr: w.devicePixelRatio,
    locale: nav.language ?? "",
    tz,
    fonts_digest: "",
    color_scheme: media("(prefers-color-scheme: dark)")
      ? 2
      : media("(prefers-color-scheme: light)")
        ? 1
        : 0,
    reduced_motion: media("(prefers-reduced-motion: reduce)") ? 1 : 0,
    // The experiment arms the server rendered the page for (§13), from the
    // document element's `data-ct-arms`.
    arms: declaredArms(w.document),
    // The whole URL, query and fragment included: the page reads them
    // (`location.search`, `location.hash`), and replay loads the page at
    // this URL (§5.2, §7.4). `meta.dat`'s `program` leaves them out (§5.1).
    url: w.location.href,
    referrer_origin: referrerOrigin,
    traceparent:
      readPageTraceContext(
        w.document,
        timelineThrough(w.performance, orig.getEntriesByType),
      )?.value ?? "",
  };
}

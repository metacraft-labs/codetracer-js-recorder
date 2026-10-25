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
  CONTROL_GLOBAL,
  IMPORT_SEAM_CAPABILITY,
  RECORDER_NAME,
  type ShimConfig,
} from "./config.js";
import type { SeamContext, ShimWindow } from "./context.js";
import { domV1Hash } from "./dom-v1.js";
import { recordDocumentProgress } from "./document-progress.js";
import { captureOriginals, type ShimOriginals } from "./originals.js";
import { Recorder } from "./recorder.js";
import { listenForPageEvents, patchDomSeams } from "./seams-dom.js";
import { listenForStorageEvents, patchMessageSeams } from "./seams-message.js";
import { patchImportSeam } from "./seams-import.js";
import { patchMediaSeams } from "./seams-media.js";
import { patchNetSeams } from "./seams-net.js";
import { patchPerformance } from "./seams-perf.js";
import { patchPlatformSeams } from "./seams-platform.js";
import { patchRefusals } from "./seams-refusals.js";
import { patchTimeSeams } from "./seams-time.js";

/** The shim's version; `Header.recorder_id` is `codetracer-boundary-shim/<this>`. */
export const SHIM_VERSION = "0.1.0";

/** The checkpoint scheme of protocol level 0 (§7.3). */
export const DOM_V1 = "dom-v1";

/** `End.reason` (§5.2). */
const EndReason = { pagehide: 1, stop: 2 };

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
  if (privacySignal(w.navigator) !== undefined) return undefined;

  const orig = captureOriginals(w);
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
        });
  const rec = new Recorder({
    checkpointHash: () => domV1Hash(doc),
    checkpointScheme: DOM_V1,
    sink: transport,
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
    patchTimeSeams,
    patchNetSeams,
    patchDomSeams,
    patchPlatformSeams,
    patchPerformance,
    patchMessageSeams,
    patchRefusals,
    patchMediaSeams,
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
    arms: "{}",
    // The whole URL, query and fragment included: the page reads them
    // (`location.search`, `location.hash`), and replay loads the page at
    // this URL (§5.2, §7.4). `meta.dat`'s `program` leaves them out (§5.1).
    url: w.location.href,
    referrer_origin: referrerOrigin,
    traceparent: "",
  };
}

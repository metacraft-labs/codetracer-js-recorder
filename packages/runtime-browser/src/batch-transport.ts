/**
 * `HttpBatchTransport`: the batched upload transport of CodeTracer's browser
 * boundary recording (JS-Boundary-Recording specification §11.1, §11.2;
 * the batch envelope and routes of the Boundary-Ingest specification §3,
 * §4, §6).
 *
 * A recorder (the generic boundary shim, or any cooperating framework that
 * writes the `jsbound` frames itself) hands it every frame it writes, in
 * order, with the frame's `seq`. The transport keeps the unsent frames in a
 * capped ring, sends them to the ingest as batches with the envelope of
 * Boundary-Ingest §4, and reports every frame it had to drop in the next
 * batch's `dropped`, so the assembler turns it into a `Gap`:
 *
 * - **Batches.** A batch is sent once 256 records are waiting, or once the
 *   oldest waiting record has waited (almost) 50 ms, whichever comes
 *   first, with `fetch(…, {keepalive: true})`. One request is in flight at
 *   a time, so batches arrive in `batch_seq` order; a batch holds at most
 *   256 records and, so that `keepalive` applies to it, at most 64 KiB
 *   unless a single frame is larger.
 * - **The ring.** Unsent frames are capped (default 4 MiB). When the cap is
 *   reached and a batch can be sent, it is sent; when it cannot (a request
 *   is in flight, or the gates below are still closed), the oldest unsent
 *   frames are dropped. `Header` and `Env`, which the first batch must
 *   begin with, and `End` are never dropped.
 * - **Leaving the page.** At `pagehide` and when the document becomes
 *   hidden every waiting frame is sent at once with `navigator.sendBeacon`
 *   (falling back to a `keepalive` fetch when the browser refuses the
 *   beacon), since the page may never run again.
 * - **Gates (§11.2).** No request at all is made when the browser sends Do
 *   Not Track (`navigator.doNotTrack == "1"`) or Global Privacy Control
 *   (`navigator.globalPrivacyControl === true`); when the page requires
 *   consent, nothing is requested (not even the configuration) until the
 *   site's consent callback answers yes. Then the ingest's `config` route
 *   decides: `enabled: false` (also its answer for an unknown or disabled
 *   site key), a session not sampled, or a configuration that requires a
 *   consent the site has not given, and nothing more is requested.
 *
 * It never throws into its caller: every failure of its own turns it off,
 * silently, and the recorder is told through `onDisabled`.
 *
 * It must not change the page it records. Every platform function it calls
 * (the timers, `fetch`, `sendBeacon`, `addEventListener`, `Math.random`
 * for sampling, `performance.now` for the deadline, `Promise.prototype.then`)
 * is one captured before the boundary shim patched it, so none of its
 * requests, timers or reads appears in the recorded log or in the page's
 * task order (JS-Boundary-Recording §6, "originals captured before any
 * patching"). The originals are looked up as the `__ct` runtime's are: the
 * replay runner's, else the boundary shim's, else the globals as this
 * module found them; a recorder can pass its own.
 *
 * References: the Fetch standard's `keepalive` and its 64 KiB in-flight
 * budget (https://fetch.spec.whatwg.org/#http-network-or-cache-fetch, step
 * "keepalive"); the Beacon API (https://w3c.github.io/beacon/); Do Not
 * Track (https://www.w3.org/TR/tracking-dnt/#dom-navigator-donottrack);
 * Global Privacy Control
 * (https://privacycg.github.io/gpc-spec/#dom-globalprivacycontrol).
 */

import { encodeBatch } from "@codetracer/boundary-format";

// ── Limits ──────────────────────────────────────────────────────────────

/** The default cap on unsent frames, in bytes (§11.1). */
export const DEFAULT_RING_BYTES = 4 * 1024 * 1024;
/** The smallest ring a configuration may ask for. */
export const MIN_RING_BYTES = 1024;
/** The largest ring a configuration may ask for. */
export const MAX_RING_BYTES = 64 * 1024 * 1024;
/** A batch is sent once this many records wait, and holds at most this many (§11.1). */
export const FLUSH_RECORDS = 256;
/** No record waits longer than this, in ms of browser time, before its batch is sent (§11.1). */
export const FLUSH_DEADLINE_MS = 50;
/**
 * How far ahead of the deadline the flush timer is aimed. A timer fires no
 * earlier than asked and, on a busy page, some milliseconds later; aiming
 * ahead keeps the deadline a bound rather than an average.
 */
export const FLUSH_TIMER_LEAD_MS = 10;
/**
 * The largest body sent with `keepalive` (and by `sendBeacon`): the Fetch
 * standard caps a document's in-flight keepalive bodies at 64 KiB.
 */
export const KEEPALIVE_BODY_LIMIT = 64 * 1024;
/** The ingest's batch body limit (Boundary-Ingest §6). */
export const MAX_BATCH_BYTES = 1024 * 1024;
/** Retries of a batch the network failed or the ingest answered 5xx or 429. */
export const MAX_RETRIES = 5;
/** The first retry's delay, doubled for each next one. */
export const RETRY_BASE_MS = 100;
/** The longest `Retry-After` honoured, in ms. */
export const MAX_RETRY_AFTER_MS = 60_000;
/**
 * A batch request not answered within this many ms is abandoned and
 * retried (the same `batch_seq` and bytes, which the ingest takes as an
 * idempotent retry), so a server that never answers cannot hold the ring
 * for the rest of the page's life.
 */
export const REQUEST_TIMEOUT_MS = 30_000;

/** The batch envelope's fixed bytes: magic, version, envelope length. */
const BATCH_PREFIX_BYTES = 9;
/** A generous bound on the envelope's JSON, for sizing a batch. */
const ENVELOPE_ALLOWANCE = 1024;

// ── Privacy signals and configuration ───────────────────────────────────

/** What {@link privacySignal} reads: the navigator, or a stand-in for it. */
export interface PrivacySignals {
  doNotTrack?: string | null;
  globalPrivacyControl?: boolean;
}

/**
 * The privacy signal that forbids recording, if the browser sends one
 * (§11.2): `"dnt"` when `navigator.doNotTrack == "1"`, `"gpc"` when
 * `navigator.globalPrivacyControl === true`, else `undefined`. The one
 * predicate both the shim (which then does not install) and the transport
 * (which then makes no request) use.
 */
export function privacySignal(
  nav: PrivacySignals | undefined,
): "dnt" | "gpc" | undefined {
  try {
    if (nav === undefined || nav === null) return undefined;
    if (nav.doNotTrack == "1") return "dnt";
    if (nav.globalPrivacyControl === true) return "gpc";
  } catch {
    // A navigator whose getters throw sends no signal we can read.
  }
  return undefined;
}

/**
 * The recorder configuration the ingest's `config` route answers
 * (Boundary-Ingest §3): `{"enabled": bool, "sampling_rate": number,
 * "consent_required": bool, "ring_bytes": integer}`. Unknown fields are
 * ignored (the scrub lists the configuration will carry are read elsewhere).
 */
export interface IngestConfig {
  /** Record at all. Absent or not `true` means no. */
  enabled: boolean;
  /** The share of sessions recorded, 0 to 1 (default 1). */
  samplingRate: number;
  /** The site's consent callback must answer yes first (default false). */
  consentRequired: boolean;
  /** The ring's cap in bytes, when the ingest sets one. */
  ringBytes?: number;
}

/**
 * Read the `config` answer. Anything that is not an object with
 * `enabled: true` disables recording (it fails closed); a malformed
 * optional field takes its default.
 */
export function parseIngestConfig(json: unknown): IngestConfig {
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    return { enabled: false, samplingRate: 0, consentRequired: false };
  }
  const o = json as Record<string, unknown>;
  const rate = o.sampling_rate;
  const ring = o.ring_bytes;
  return {
    enabled: o.enabled === true,
    samplingRate: typeof rate === "number" && rate >= 0 && rate <= 1 ? rate : 1,
    consentRequired: o.consent_required === true,
    ringBytes:
      typeof ring === "number" && Number.isSafeInteger(ring)
        ? Math.min(MAX_RING_BYTES, Math.max(MIN_RING_BYTES, ring))
        : undefined,
  };
}

/** The ingest routes under its base URL (Boundary-Ingest §3). */
export function ingestRoutes(
  base: string,
  location: string,
): { config: string; batches: string } {
  const root = new URL(base, location);
  if (root.protocol !== "https:" && root.protocol !== "http:") {
    throw new Error(`the ingest ${root.href} is not an http(s) URL`);
  }
  const prefix = root.href.replace(/\/+$/, "");
  return { config: `${prefix}/config`, batches: `${prefix}/batches` };
}

// ── Originals ───────────────────────────────────────────────────────────

/** The platform functions the transport calls, captured before any patching. */
export interface TransportOriginals {
  fetch: typeof fetch | undefined;
  /** `Navigator.prototype.sendBeacon`, called with the navigator as `this`. */
  sendBeacon: Navigator["sendBeacon"] | undefined;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  /** `EventTarget.prototype.addEventListener`. */
  addEventListener: EventTarget["addEventListener"] | undefined;
  /** `Promise.prototype.then`, which a page may replace. */
  promiseThen: Promise<unknown>["then"];
  Promise: PromiseConstructor;
  mathRandom: () => number;
  performanceNow: (() => number) | undefined;
}

function moduleOriginals(): TransportOriginals {
  const g = globalThis as unknown as {
    fetch?: typeof fetch;
    Navigator?: { prototype: Navigator };
    EventTarget?: { prototype: EventTarget };
    performance?: { now?: () => number };
  };
  return {
    fetch: g.fetch,
    sendBeacon: g.Navigator?.prototype.sendBeacon,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    addEventListener: g.EventTarget?.prototype.addEventListener,
    promiseThen: Promise.prototype.then,
    Promise,
    mathRandom: Math.random,
    performanceNow: g.performance?.now,
  };
}

const MODULE_ORIGINALS = moduleOriginals();

/**
 * The originals the transport uses: the replay runner's
 * (`__ctReplay.originals`), else the boundary shim's
 * (`__ctBoundaryShim.originals`), else the globals as this module was
 * evaluated, entry by entry.
 */
export function resolveTransportOriginals(
  given: Partial<TransportOriginals> = {},
): TransportOriginals {
  const g = globalThis as {
    __ctReplay?: { originals?: Partial<TransportOriginals> };
    __ctBoundaryShim?: { originals?: Partial<TransportOriginals> };
  };
  const published: Partial<TransportOriginals> =
    g.__ctReplay?.originals ?? g.__ctBoundaryShim?.originals ?? {};
  const pick = <K extends keyof TransportOriginals>(
    k: K,
  ): TransportOriginals[K] =>
    (given[k] ?? published[k] ?? MODULE_ORIGINALS[k]) as TransportOriginals[K];
  return {
    fetch: pick("fetch"),
    sendBeacon: pick("sendBeacon"),
    setTimeout: pick("setTimeout"),
    clearTimeout: pick("clearTimeout"),
    addEventListener: pick("addEventListener"),
    promiseThen: pick("promiseThen"),
    Promise: pick("Promise"),
    mathRandom: pick("mathRandom"),
    performanceNow: pick("performanceNow"),
  };
}

// ── The transport ───────────────────────────────────────────────────────

/** What a site's consent callback answers: a boolean, or a promise of one. */
export type ConsentAnswer = boolean | Promise<boolean>;
/** The site's consent callback (§11.2). */
export type ConsentCallback = () => ConsentAnswer;

/** Where the transport is in its life. */
export type TransportState =
  /** The page requires consent and no callback has answered yes yet. */
  | "waiting-for-consent"
  /** The configuration is being fetched. */
  | "configuring"
  /** Batches are being sent. */
  | "open"
  /** The final batch was answered. */
  | "ended"
  /** Nothing more will be requested; {@link TransportStatus.reason} says why. */
  | "off";

/** What {@link HttpBatchTransport.status} reports (for diagnostics and tests). */
export interface TransportStatus {
  state: TransportState;
  /** Why the transport is off. */
  reason?: string;
  /** Batches handed to the network, beacons included. */
  batchesSent: number;
  /** Batches the ingest answered with a 2xx. */
  batchesAccepted: number;
  /** The greatest `last_seq` of a batch the ingest accepted (0 if none). */
  lastAcceptedSeq: number;
  /** Records dropped so far: evicted from the ring or refused by the ingest. */
  droppedRecords: number;
  /** Unsent frames held now, and their bytes. */
  bufferedFrames: number;
  bufferedBytes: number;
  /** The ring's cap now. */
  ringBytes: number;
}

export interface HttpBatchTransportOptions {
  /**
   * The ingest's base URL, absolute or relative to the page: the
   * configuration is `GET <ingest>/config` and each batch `POST
   * <ingest>/batches` (Boundary-Ingest §3, where the base is
   * `/api/v1/ingest/js-boundary/<site key>`).
   */
  ingest: string;
  /** `Header.session_id`: 32 lowercase hex digits. */
  sessionId: string;
  /** `Header.build_hash`: 64 lowercase hex digits. */
  buildHash: string;
  /** The page requires consent before anything is requested (§11.2). */
  consentRequired?: boolean;
  /** The ring's cap in bytes until the configuration sets one. */
  ringBytes?: number;
  /** A batch is sent once this many records wait (default 256). */
  flushRecords?: number;
  /** The longest a record waits before its batch is sent, in ms (default 50). */
  flushDeadlineMs?: number;
  /** Platform functions to use instead of the resolved originals. */
  originals?: Partial<TransportOriginals>;
  /** The window whose navigator, document and location are read (default `globalThis`). */
  window?: Window;
  /** Told once, with the reason, when the transport turns off. */
  onDisabled?: (reason: string) => void;
}

/** One unsent frame, or a run of records that will never be sent. */
type Entry =
  | {
      kind: "frame";
      bytes: Uint8Array;
      /** The record's `seq`; absent for `Header`, `Env` and `End`. */
      seq: number | undefined;
      /** `Header`, `Env` and `End` are never dropped. */
      pinned: boolean;
      /** `performance.now()` when it was appended. */
      at: number;
    }
  | { kind: "drop"; first: number; last: number };

/** A batch built from the ring, and what to do when it is answered. */
interface Batch {
  batchSeq: number;
  body: Uint8Array;
  firstSeq: number | undefined;
  lastSeq: number | undefined;
  /** The drop ranges it reports: lost with it unless reported again. */
  dropped: [number, number][];
  /** It carries `Header` (batch 0): refusing it loses the session. */
  hasHeader: boolean;
  final: boolean;
  attempts: number;
}

/**
 * The ring's storage: a double-ended queue over an array with a moving
 * head, so that taking from the front, putting back at the front and
 * removing or inserting a few places from the front cost O(1) (O(i) for
 * place `i`), however many entries it holds.
 *
 * The ring holds up to its cap in frames, which at a few dozen bytes per
 * record is over a hundred thousand entries. Eviction removes the oldest
 * unpinned frame, a few places from the front (after `Header`, `Env` and
 * the drop marker), on every append once the cap is reached; with
 * `Array.prototype.splice` that moved every entry behind it, and a page
 * whose ring was full (consent not yet given, or a long synchronous burst)
 * spent about 165 µs in the recorder per boundary read (measured
 * 2026-10-24 in headless Chromium 141: 200,000 reads took 33 s instead of
 * 0.3 s).
 */
class Deque<T> {
  private items: (T | undefined)[] = [];
  private head = 0;

  get length(): number {
    return this.items.length - this.head;
  }

  /** The entry at place `i` from the front (`undefined` past the end). */
  at(i: number): T | undefined {
    return i < 0 ? undefined : this.items[this.head + i];
  }

  last(): T | undefined {
    return this.at(this.length - 1);
  }

  push(x: T): void {
    this.items.push(x);
  }

  shift(): T | undefined {
    if (this.length === 0) return undefined;
    const x = this.items[this.head];
    this.items[this.head] = undefined;
    this.head += 1;
    this.compact();
    return x;
  }

  unshift(x: T): void {
    if (this.head > 0) {
      this.head -= 1;
      this.items[this.head] = x;
    } else {
      this.items.unshift(x);
    }
  }

  /** Remove the entry at place `i`, moving the `i` before it up by one. */
  removeAt(i: number): T | undefined {
    if (i < 0 || i >= this.length) return undefined;
    const at = this.head + i;
    const x = this.items[at];
    for (let j = at; j > this.head; j--) this.items[j] = this.items[j - 1];
    this.items[this.head] = undefined;
    this.head += 1;
    this.compact();
    return x;
  }

  /** Insert `x` at place `i`, moving the `i` before it down by one. */
  insertAt(i: number, x: T): void {
    if (i <= 0) return this.unshift(x);
    if (i >= this.length) return this.push(x);
    if (this.head === 0) {
      this.items.splice(i, 0, x);
      return;
    }
    this.head -= 1;
    const at = this.head + i;
    for (let j = this.head; j < at; j++) this.items[j] = this.items[j + 1];
    this.items[at] = x;
  }

  clear(): void {
    this.items = [];
    this.head = 0;
  }

  *[Symbol.iterator](): IterableIterator<T> {
    for (let j = this.head; j < this.items.length; j++) yield this.items[j]!;
  }

  /** Drop the vacated front once it is most of the array. */
  private compact(): void {
    if (this.head >= 1024 && this.head * 2 >= this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
  }
}

const isLowerHex = (s: unknown, len: number): boolean =>
  typeof s === "string" && s.length === len && /^[0-9a-f]+$/.test(s);

/**
 * The batched upload transport (§11.1). Construct it before the recorder
 * writes its first frame; hand it every frame with {@link append}; call
 * {@link end} after `End`.
 */
export class HttpBatchTransport {
  private readonly orig: TransportOriginals;
  private readonly win: Window;
  private readonly flushRecords: number;
  private readonly flushDeadlineMs: number;
  private readonly onDisabled: ((reason: string) => void) | undefined;
  private readonly sessionId: string;
  private readonly buildHash: string;
  private routes: { config: string; batches: string } | undefined;

  private state: TransportState = "configuring";
  private reason: string | undefined;
  private consentGiven = false;
  private consentAsked = false;
  /** Asked again once the configuration requires a consent. */
  private consentCallback: ConsentCallback | undefined;
  private configRequested = false;

  private readonly queue = new Deque<Entry>();
  private queuedBytes = 0;
  private queuedRecords = 0;
  private ringBytes: number;

  private nextBatchSeq = 0;
  private lastSentSeq = 0;
  private inFlight: Batch | undefined;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private ended = false;
  private halted = false;
  private finalSent = false;

  private batchesSent = 0;
  private batchesAccepted = 0;
  private lastAcceptedSeq = 0;
  private droppedRecords = 0;

  private settle: (() => void) | undefined;
  private readonly settled: Promise<void>;

  constructor(options: HttpBatchTransportOptions) {
    this.orig = resolveTransportOriginals(options.originals);
    this.win = options.window ?? (globalThis as unknown as Window);
    this.flushRecords = Math.max(
      1,
      Math.min(FLUSH_RECORDS, options.flushRecords ?? FLUSH_RECORDS),
    );
    this.flushDeadlineMs = Math.max(
      0,
      options.flushDeadlineMs ?? FLUSH_DEADLINE_MS,
    );
    this.onDisabled = options.onDisabled;
    this.sessionId = options.sessionId;
    this.buildHash = options.buildHash;
    this.ringBytes = clampRing(options.ringBytes ?? DEFAULT_RING_BYTES);
    let settle!: () => void;
    this.settled = new this.orig.Promise<void>((r) => (settle = r));
    this.settle = settle;

    this.guard(() => {
      const signal = privacySignal(this.win.navigator as PrivacySignals);
      if (signal !== undefined) return this.off(`privacy signal: ${signal}`);
      if (!isLowerHex(this.sessionId, 32)) {
        return this.off("the session id is not 32 lowercase hex digits");
      }
      if (!isLowerHex(this.buildHash, 64)) {
        return this.off(
          "the build hash is not 64 lowercase hex digits (install the shim with --build-hash)",
        );
      }
      if (typeof this.orig.fetch !== "function") {
        return this.off("this browser has no fetch");
      }
      this.routes = ingestRoutes(options.ingest, this.win.location.href);
      this.listenForLeaving();
      if (options.consentRequired === true) {
        this.state = "waiting-for-consent";
      } else {
        this.requestConfig();
      }
    });
  }

  // ── The recorder's side ──────────────────────────────────────────────

  /**
   * Take one frame, as written: `seq` is the record's (`undefined` for
   * `Header`, `Env` and `End`). Frames must be appended in the order they
   * were written.
   */
  append(frame: Uint8Array, seq: bigint | number | undefined): void {
    this.guard(() => {
      if (this.ended || this.halted) return;
      this.enqueue(frame, seq);
    });
  }

  private enqueue(frame: Uint8Array, seq: bigint | number | undefined): void {
    if (this.state === "off" || this.state === "ended") return;
    const n = seq === undefined ? undefined : Number(seq);
    if (
      n !== undefined &&
      frame.length + BATCH_PREFIX_BYTES + ENVELOPE_ALLOWANCE > MAX_BATCH_BYTES
    ) {
      // No batch could carry it (Boundary-Ingest §6): report it dropped.
      this.droppedRecords += 1;
      this.appendDrop(n);
      return;
    }
    this.queue.push({
      kind: "frame",
      bytes: frame,
      seq: n,
      pinned: n === undefined,
      at: this.now(),
    });
    this.queuedBytes += frame.length;
    this.queuedRecords += 1;
    if (this.queuedBytes > this.ringBytes) {
      // Send rather than drop, when a batch can be sent now.
      if (this.canSend()) this.pump();
      this.evictToCap();
    } else if (
      this.queuedRecords >= this.flushRecords ||
      this.queuedBytes >= KEEPALIVE_BODY_LIMIT - ENVELOPE_ALLOWANCE
    ) {
      this.pump();
    }
    this.armFlushTimer();
  }

  /**
   * The session ended. `endFrame`, when given, is its `End` frame, taken
   * as the last frame; without it `End` must already have been appended.
   * Sends what is left, the last batch `final`, by beacon when `unloading`
   * (the page is going away). Resolves once the final batch is answered,
   * or the transport is off.
   */
  end(unloading = false, endFrame?: Uint8Array): Promise<void> {
    this.guard(() => {
      if (this.ended || this.state === "off" || this.state === "ended") return;
      // Ended before End is taken, so no batch carries End without `final`.
      this.ended = true;
      if (endFrame !== undefined) this.enqueue(endFrame, undefined);
      if (unloading) this.drainByBeacon();
      else this.pump();
    });
    return this.settled;
  }

  /**
   * The recorder stopped without an `End` (it faulted, §10.1): send what is
   * left, none of it `final` (the ingest ends the session when it idles,
   * `End{reason: 3}`), and take nothing more.
   */
  halt(): void {
    this.guard(() => {
      if (this.halted || this.ended) return;
      this.halted = true;
      this.pump();
    });
  }

  /**
   * Register the site's consent callback (§11.2). It is called at once,
   * here, whatever the configuration, so that a replay of the page, which
   * calls it the same way, runs the same page code at the same point; its
   * answer matters only when consent is required. A boolean or a native
   * promise of one; anything else, a throw or a rejection, is no. The
   * first answer is final.
   */
  consent(callback: ConsentCallback): void {
    let answer: unknown;
    try {
      answer = callback();
    } catch {
      answer = false;
    }
    this.guard(() => {
      if (this.consentAsked) return;
      this.consentAsked = true;
      this.consentCallback = callback;
      const decide = (yes: unknown) =>
        this.guard(() => this.onConsent(yes === true));
      if (typeof answer === "boolean") {
        decide(answer);
      } else if (answer instanceof this.orig.Promise) {
        // Only a native promise: a page's thenable would run page code in a
        // job the replay of the page would not run.
        this.then(answer, decide, () => decide(false));
      } else {
        decide(false);
      }
    });
  }

  /** Send what is waiting now, if a batch can be sent. */
  flush(): void {
    this.guard(() => this.pump());
  }

  /** Where the transport is. */
  status(): TransportStatus {
    return {
      state: this.state,
      reason: this.reason,
      batchesSent: this.batchesSent,
      batchesAccepted: this.batchesAccepted,
      lastAcceptedSeq: this.lastAcceptedSeq,
      droppedRecords: this.droppedRecords,
      bufferedFrames: this.queuedRecords,
      bufferedBytes: this.queuedBytes,
      ringBytes: this.ringBytes,
    };
  }

  // ── Gates ─────────────────────────────────────────────────────────────

  private onConsent(yes: boolean): void {
    if (this.state === "off" || this.state === "ended") return;
    if (!yes) return this.off("consent was not given");
    this.consentGiven = true;
    if (this.state === "waiting-for-consent") {
      if (this.configRequested) this.open();
      else this.requestConfig();
    }
  }

  private requestConfig(): void {
    if (this.routes === undefined) return;
    this.state = "configuring";
    this.configRequested = true;
    const f = this.orig.fetch!;
    const answered = (res: Response) =>
      this.guard(() => {
        if (!res.ok) return this.off(`config answered ${res.status}`);
        this.then(
          res.json(),
          (json: unknown) => this.guard(() => this.configure(json)),
          () => this.off("config is not JSON"),
        );
      });
    this.then(
      f.call(this.win, this.routes.config, {
        method: "GET",
        credentials: "omit",
        mode: "cors",
      }),
      answered,
      () => this.off("config could not be fetched"),
    );
  }

  private configure(json: unknown): void {
    if (this.state === "off") return;
    const config = parseIngestConfig(json);
    if (!config.enabled) return this.off("config: enabled is not true");
    if (
      config.samplingRate < 1 &&
      !(this.orig.mathRandom() < config.samplingRate)
    ) {
      return this.off("config: this session is not sampled");
    }
    if (config.ringBytes !== undefined) {
      this.ringBytes = config.ringBytes;
      this.evictToCap();
    }
    if (config.consentRequired && !this.consentGiven) {
      this.state = "waiting-for-consent";
      return;
    }
    this.open();
  }

  private open(): void {
    this.state = "open";
    this.pump();
    this.armFlushTimer();
  }

  /** Turn off: drop everything, request nothing more, tell the recorder. */
  private off(reason: string): void {
    if (this.state === "off") return;
    this.state = "off";
    this.reason = reason;
    this.queue.clear();
    this.queuedBytes = 0;
    this.queuedRecords = 0;
    this.cancelTimer("flushTimer");
    this.cancelTimer("retryTimer");
    this.settle?.();
    this.settle = undefined;
    try {
      this.onDisabled?.(reason);
    } catch {
      // The recorder's callback must not undo the transport's silence.
    }
  }

  // ── Sending ───────────────────────────────────────────────────────────

  private canSend(): boolean {
    return this.state === "open" && this.inFlight === undefined;
  }

  /** Whether a batch should be sent now, rather than at the deadline. */
  private due(): boolean {
    if (this.ended || this.halted) return true;
    if (this.queuedRecords >= this.flushRecords) return true;
    if (this.queuedBytes >= KEEPALIVE_BODY_LIMIT - ENVELOPE_ALLOWANCE)
      return true;
    const oldest = this.oldestAt();
    return (
      oldest !== undefined &&
      this.now() - oldest >= this.flushDeadlineMs - FLUSH_TIMER_LEAD_MS
    );
  }

  /** Send one batch when a batch can be sent and there is one to send. */
  private pump(): void {
    if (!this.canSend()) return;
    // At most what `keepalive` can carry, so that a batch in flight when
    // the page goes away is still delivered (a larger frame goes alone).
    const batch = this.takeBatch(KEEPALIVE_BODY_LIMIT);
    if (batch === undefined) {
      if (this.ended && !this.finalSent && !this.hasFrames()) {
        this.sendFinalEmpty();
      }
      return;
    }
    this.send(batch, false);
  }

  /**
   * Build the next batch from the front of the ring: at most
   * `flushRecords` records and `limit` bytes (a single larger frame goes
   * alone), the drop markers before its first record in its `dropped`, and
   * a drop marker after one of its records ending it.
   */
  private takeBatch(limit: number): Batch | undefined {
    const frames: Uint8Array[] = [];
    const dropped: [number, number][] = [];
    let bytes = BATCH_PREFIX_BYTES + ENVELOPE_ALLOWANCE;
    let records = 0;
    let firstSeq: number | undefined;
    let lastSeq: number | undefined;
    let hasHeader = false;
    while (this.queue.length > 0) {
      const e = this.queue.at(0)!;
      if (e.kind === "drop") {
        // Drops after a record of this batch belong to the next one.
        if (firstSeq !== undefined) break;
        dropped.push([e.first, e.last]);
        this.queue.shift();
        continue;
      }
      if (records >= this.flushRecords) break;
      if (records > 0 && bytes + e.bytes.length > limit) break;
      this.queue.shift();
      this.queuedBytes -= e.bytes.length;
      this.queuedRecords -= 1;
      frames.push(e.bytes);
      bytes += e.bytes.length;
      records += 1;
      if (e.seq !== undefined) {
        firstSeq ??= e.seq;
        lastSeq = e.seq;
      } else if (this.nextBatchSeq === 0 && records === 1) {
        hasHeader = true;
      }
    }
    if (frames.length === 0 && dropped.length === 0) return undefined;
    if (frames.length === 0) {
      // Only drops are left: keep them for the batch that follows.
      for (const [a, b] of dropped.reverse()) this.unshiftDrop(a, b);
      return undefined;
    }
    const final = this.ended && this.queue.length === 0;
    let size = 0;
    for (const f of frames) size += f.length;
    const run = new Uint8Array(size);
    let at = 0;
    for (const f of frames) {
      run.set(f, at);
      at += f.length;
    }
    const batchSeq = this.nextBatchSeq++;
    // A batch with no seq-bearing record (only End, say) declares the seq
    // after the last one sent; nobody checks it (Boundary-Ingest §4).
    const body = encodeBatch(
      {
        session_id: this.sessionId,
        batch_seq: batchSeq,
        first_seq: firstSeq ?? this.lastSentSeq + 1,
        last_seq: lastSeq ?? this.lastSentSeq,
        dropped,
        build_hash: this.buildHash,
        final,
      },
      run,
    );
    if (lastSeq !== undefined) this.lastSentSeq = lastSeq;
    if (final) this.finalSent = true;
    return {
      batchSeq,
      body,
      firstSeq,
      lastSeq,
      dropped,
      hasHeader,
      final,
      attempts: 0,
    };
  }

  /**
   * The session ended with nothing left to send but no batch was `final`
   * (a recorder that appended `End` before calling {@link end}, whose
   * batch had already left): a final batch of no frames, carrying any
   * drops still to report. Sent by beacon when the page is going away.
   */
  private sendFinalEmpty(beacon = false): void {
    const dropped: [number, number][] = [];
    while (this.queue.length > 0) {
      const e = this.queue.shift()!;
      if (e.kind === "drop") dropped.push([e.first, e.last]);
    }
    const batchSeq = this.nextBatchSeq++;
    const body = encodeBatch(
      {
        session_id: this.sessionId,
        batch_seq: batchSeq,
        first_seq: this.lastSentSeq + 1,
        last_seq: this.lastSentSeq,
        dropped,
        build_hash: this.buildHash,
        final: true,
      },
      new Uint8Array(0),
    );
    this.finalSent = true;
    this.send(
      {
        batchSeq,
        body,
        firstSeq: undefined,
        lastSeq: undefined,
        dropped,
        hasHeader: false,
        final: true,
        attempts: 0,
      },
      beacon,
    );
    if (beacon) this.finish();
  }

  private hasFrames(): boolean {
    return this.queuedRecords > 0;
  }

  /** Send `batch` with fetch (`keepalive` when it fits), or by beacon. */
  private send(batch: Batch, beacon: boolean): void {
    const routes = this.routes!;
    this.batchesSent += 1;
    if (beacon && this.beacon(routes.batches, batch.body)) return;
    const keepalive = batch.body.length <= KEEPALIVE_BODY_LIMIT;
    let request: Promise<Response>;
    try {
      const init: RequestInit = {
        method: "POST",
        credentials: "omit",
        mode: "cors",
        keepalive,
        headers: { "content-type": "application/octet-stream" },
        body: batch.body as unknown as BodyInit,
      };
      // AbortSignal.timeout keeps its own clock: no page timer is used.
      const timeout = (
        AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal }
      ).timeout;
      if (!beacon && typeof timeout === "function") {
        init.signal = timeout.call(AbortSignal, REQUEST_TIMEOUT_MS);
      }
      request = this.orig.fetch!.call(this.win, routes.batches, init);
    } catch {
      // A keepalive fetch over the document's budget throws synchronously.
      if (!beacon) this.failed(batch, undefined);
      return;
    }
    if (beacon) {
      // The page is going away: nothing will read the answer.
      this.then(request, undefined, () => undefined);
      return;
    }
    this.inFlight = batch;
    this.then(
      request,
      (res: Response) => this.guard(() => this.answered(batch, res)),
      () => this.guard(() => this.failed(batch, undefined)),
    );
  }

  /** `sendBeacon`; `false` when the browser would not queue it. */
  private beacon(url: string, body: Uint8Array): boolean {
    const send = this.orig.sendBeacon;
    if (typeof send !== "function") return false;
    try {
      // No type: a typed Blob is not a CORS-safelisted body, and a beacon
      // to another origin then needs a preflight it cannot complete.
      return send.call(this.win.navigator, url, new Blob([body as BlobPart]));
    } catch {
      return false;
    }
  }

  private answered(batch: Batch, res: Response): void {
    if (this.inFlight !== batch) return;
    const status = res.status;
    if (status >= 200 && status < 300) {
      this.inFlight = undefined;
      this.batchesAccepted += 1;
      if (batch.lastSeq !== undefined && batch.lastSeq > this.lastAcceptedSeq)
        this.lastAcceptedSeq = batch.lastSeq;
      if (batch.final) return this.finish();
      return this.afterAnswer();
    }
    if (status === 429 || status >= 500) {
      const after = retryAfterMs(res.headers.get("retry-after"));
      return this.failed(batch, after);
    }
    if (status === 413) {
      // Over the size limit: the ingest will never take it (§6).
      this.inFlight = undefined;
      return this.refused(batch);
    }
    // 400, 403, 409 and anything else: the ingest refuses this session.
    this.inFlight = undefined;
    this.off(`the ingest answered ${status}`);
  }

  /** The network failed, or the ingest answered 5xx or 429: retry, then drop. */
  private failed(batch: Batch, retryAfter: number | undefined): void {
    if (this.state === "off") return;
    batch.attempts += 1;
    if (batch.attempts > MAX_RETRIES) {
      this.inFlight = undefined;
      return this.refused(batch);
    }
    this.inFlight = batch;
    const delay = retryAfter ?? RETRY_BASE_MS * Math.pow(2, batch.attempts - 1);
    this.cancelTimer("retryTimer");
    this.retryTimer = this.orig.setTimeout.call(
      globalThis,
      () =>
        this.guard(() => {
          this.retryTimer = undefined;
          if (this.inFlight !== batch) return;
          this.inFlight = undefined;
          // The same batch_seq and bytes: the ingest's idempotent retry.
          this.send(batch, false);
        }),
      delay,
    );
  }

  /**
   * The batch will never be accepted: its records are dropped and the next
   * batch reports them (Boundary-Ingest §6), together with the drops the
   * refused batch itself reported, which the ingest never saw. Losing the
   * first batch loses the session's `Header`, so the transport turns off
   * instead.
   */
  private refused(batch: Batch): void {
    if (batch.hasHeader)
      return this.off("the session's first batch was refused");
    if (batch.firstSeq !== undefined && batch.lastSeq !== undefined) {
      this.unshiftDrop(batch.firstSeq, batch.lastSeq);
      this.droppedRecords += batch.lastSeq - batch.firstSeq + 1;
    }
    // Its own drops precede its records: put them back in front, merging.
    for (let i = batch.dropped.length - 1; i >= 0; i--) {
      const [a, b] = batch.dropped[i];
      this.unshiftDrop(a, b);
    }
    if (batch.final) return this.finish();
    this.afterAnswer();
  }

  /** A batch was answered: send the next one now or at its deadline. */
  private afterAnswer(): void {
    if (this.due()) this.pump();
    this.armFlushTimer();
  }

  private finish(): void {
    if (this.state !== "off") this.state = "ended";
    this.cancelTimer("flushTimer");
    this.cancelTimer("retryTimer");
    this.settle?.();
    this.settle = undefined;
  }

  // ── Leaving the page ─────────────────────────────────────────────────

  private listenForLeaving(): void {
    const add = this.orig.addEventListener;
    if (typeof add !== "function") return;
    const doc = this.win.document;
    // Listeners of our own on the window and the document, added through the
    // original addEventListener: the page cannot see them, and the shim's
    // pagehide listener (added at install, earlier) has written End first.
    add.call(this.win, "pagehide", () =>
      this.guard(() => this.drainByBeacon()),
    );
    if (doc !== undefined) {
      add.call(doc, "visibilitychange", () =>
        this.guard(() => {
          if (doc.visibilityState === "hidden") this.drainByBeacon();
        }),
      );
    }
  }

  /**
   * Send everything waiting now, by beacon, without waiting for a batch in
   * flight: the page may never run again. Only once the gates are open.
   */
  private drainByBeacon(): void {
    if (this.state !== "open") return;
    // A batch waiting for its retry would otherwise be lost with the page.
    if (this.inFlight !== undefined && this.retryTimer !== undefined) {
      const waiting = this.inFlight;
      this.cancelTimer("retryTimer");
      this.inFlight = undefined;
      this.send(waiting, true);
      if (waiting.final) return this.finish();
    }
    if (this.ended && !this.finalSent && !this.hasFrames()) {
      return this.sendFinalEmpty(true);
    }
    for (;;) {
      const batch = this.takeBatch(KEEPALIVE_BODY_LIMIT);
      if (batch === undefined) break;
      this.send(batch, true);
      if (batch.final) {
        this.finish();
        break;
      }
    }
  }

  // ── The ring ──────────────────────────────────────────────────────────

  /** Drop the oldest unpinned frames until the ring is within its cap. */
  private evictToCap(): void {
    let i = 0;
    while (this.queuedBytes > this.ringBytes && i < this.queue.length) {
      const e = this.queue.at(i)!;
      if (e.kind !== "frame" || e.pinned || e.seq === undefined) {
        i += 1;
        continue;
      }
      this.queue.removeAt(i);
      this.queuedBytes -= e.bytes.length;
      this.queuedRecords -= 1;
      this.droppedRecords += 1;
      // Merge with the drop marker before it, or put one in its place.
      const prev = this.queue.at(i - 1);
      if (prev?.kind === "drop" && prev.last + 1 === e.seq) {
        prev.last = e.seq;
      } else {
        this.queue.insertAt(i, { kind: "drop", first: e.seq, last: e.seq });
        i += 1;
      }
    }
  }

  /** Put the drop of `seq` at the back of the ring, merging. */
  private appendDrop(seq: number): void {
    const tail = this.queue.last();
    if (tail?.kind === "drop" && tail.last + 1 === seq) tail.last = seq;
    else this.queue.push({ kind: "drop", first: seq, last: seq });
  }

  /** Put the drop `a..b` at the front of the ring, merging. */
  private unshiftDrop(a: number, b: number): void {
    const head = this.queue.at(0);
    if (head?.kind === "drop" && b + 1 === head.first) {
      head.first = a;
    } else {
      this.queue.unshift({ kind: "drop", first: a, last: b });
    }
  }

  private oldestAt(): number | undefined {
    for (const e of this.queue) if (e.kind === "frame") return e.at;
    return undefined;
  }

  // ── Timers and helpers ───────────────────────────────────────────────

  /**
   * Aim the flush timer at the oldest waiting record's deadline. Not while
   * a batch is in flight: nothing can be sent before its answer, which
   * re-arms the timer ({@link afterAnswer}); a timer aimed at a deadline
   * already past would otherwise fire and re-arm itself at once for as
   * long as the request takes, a stream of timer tasks on the page.
   */
  private armFlushTimer(): void {
    if (
      this.flushTimer !== undefined ||
      this.state !== "open" ||
      this.inFlight !== undefined
    )
      return;
    const oldest = this.oldestAt();
    if (oldest === undefined) return;
    const aim = this.flushDeadlineMs - FLUSH_TIMER_LEAD_MS;
    const delay = Math.max(0, aim - (this.now() - oldest));
    this.flushTimer = this.orig.setTimeout.call(
      globalThis,
      () =>
        this.guard(() => {
          this.flushTimer = undefined;
          this.pump();
          this.armFlushTimer();
        }),
      delay,
    );
  }

  private cancelTimer(which: "flushTimer" | "retryTimer"): void {
    const t = this[which];
    if (t === undefined) return;
    this[which] = undefined;
    try {
      this.orig.clearTimeout.call(globalThis, t);
    } catch {
      // Best effort.
    }
  }

  private now(): number {
    try {
      const pn = this.orig.performanceNow;
      if (typeof pn === "function") return pn.call(this.win.performance);
    } catch {
      // Fall through.
    }
    return 0;
  }

  /**
   * `p.then(ok, err)` through the original `Promise.prototype.then`, which
   * a page may have replaced.
   */
  private then<T>(
    p: Promise<T>,
    ok: ((value: T) => unknown) | undefined,
    err: (reason: unknown) => unknown,
  ): void {
    (
      this.orig.promiseThen as (
        this: Promise<T>,
        ok: ((value: T) => unknown) | undefined,
        err: (reason: unknown) => unknown,
      ) => unknown
    ).call(p, ok, err);
  }

  /** Run `f`; anything it throws turns the transport off, never out. */
  private guard(f: () => void): void {
    try {
      f();
    } catch (e) {
      try {
        this.off(`transport fault: ${describe(e)}`);
      } catch {
        // Nothing more can be done silently.
      }
    }
  }
}

function clampRing(n: number): number {
  return Number.isSafeInteger(n)
    ? Math.min(MAX_RING_BYTES, Math.max(MIN_RING_BYTES, n))
    : DEFAULT_RING_BYTES;
}

/**
 * `Retry-After` in ms, capped; `undefined` when absent or not a whole
 * number of seconds. The HTTP-date form is not read: it would need the
 * page's `Date`, which the boundary shim records, so the usual backoff
 * applies to it instead.
 */
function retryAfterMs(value: string | null): number | undefined {
  if (value === null || !/^\s*\d+\s*$/.test(value)) return undefined;
  return Math.min(MAX_RETRY_AFTER_MS, Number(value) * 1000);
}

function describe(error: unknown): string {
  try {
    return error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error);
  } catch {
    return "unprintable error";
  }
}

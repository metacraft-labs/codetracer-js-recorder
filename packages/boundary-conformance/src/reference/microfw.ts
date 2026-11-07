/**
 * The reference cooperating micro-framework: a test-only implementation of
 * the cooperation protocol at level 1 (CodeTracer's JS-Boundary-Recording
 * specification §9), whose one job is to prove that the conformance suite
 * discriminates. A real framework (IsoNim, for one) implements the same
 * protocol in its own runtime; nothing here is meant for a real page.
 *
 * It emits the boundary format natively, as §9 asks a cooperating framework
 * to, and loads no generic shim: the application's boundary reads go
 * through the framework's own seams (`now`, `random`, `fetchText`,
 * `setTimeout`, …), input is captured where handlers are registered
 * (`on`), targets are stable ids (`iid:`, stamped as `data-iid` by the
 * build) or creation ordinals (`ord:`, for nodes the client creates),
 * checkpoints hash the framework's own state (`state` signals) with
 * `dom-v1` beside it, a pre-hydration queue catches clicks before the page
 * hydrates, and the log leaves the page as batches with the envelope of the
 * Boundary-Ingest specification §4.
 *
 * Numbering, encoding and the checkpoint cadence are the generic shim's
 * `Recorder`, reused rather than written again; everything that makes this
 * level 1 rather than level 0 is here.
 *
 * When the replay runner's `__ctReplay` is present (§9.7) the framework
 * records nothing and installs replay backends instead: every seam reads
 * from `__ctReplay.next`, timers and requests run when the runner's
 * scheduler releases their tasks, and `__ctBoundaryProtocol.replay`
 * offers `inject` (which calls the registered handler directly, §9.5) and
 * `checkpoint` (its state hash, §9.6).
 *
 * Sensitive inputs (§11.3, capability `sensitive`): a field the app
 * declares sensitive with `sensitive(el)` (and every free-text field it does
 * not declare `public(el)`, as the generic shim decides, so the two agree on
 * the `dom-v1` digest) has its events masked and its value written as
 * `Scrubbed`; `secret(initial)` is a signal its checkpoint hash leaves out
 * entirely (§9.6) and whose read on replay outside a declassifier is reported
 * as the framework's "unchecked unwrap" (§7.2 `cause`); `declassify(fn, id)`
 * logs its output as `Declassify` and on replay returns it without running
 * `fn`; and the network seam holes the sensitive values in what it logs
 * (§5.2.1).
 *
 * Seeded defects (`ReferenceDefects`, compiled in by the build) turn it into
 * the broken frameworks the suite must reject.
 */

import {
  type BoundaryRecord,
  decodeRecord,
  encodeBatch,
  seqOf,
} from "@codetracer/boundary-format";
import { domV1Hash } from "@codetracer/boundary-shim/dist/browser/dom-v1.js";
import { recordDocumentProgress } from "@codetracer/boundary-shim/dist/browser/document-progress.js";
import { readEnvironment } from "@codetracer/boundary-shim/dist/browser/install.js";
import {
  NO_RESPONSE_META,
  type NetResponseMeta,
  fetchResponseMeta,
} from "@codetracer/boundary-shim/dist/browser/stream-body.js";
import { captureOriginals } from "@codetracer/boundary-shim/dist/browser/originals.js";
import {
  Recorder,
  type RecorderOptions,
  numberToBits,
} from "@codetracer/boundary-shim/dist/browser/recorder.js";
import {
  type CtReplay,
  type ReplayHooks,
  replayOf,
} from "@codetracer/boundary-shim/dist/browser/replay-api.js";
import { sha256Hex } from "@codetracer/boundary-shim/dist/browser/sha256.js";
import { sanitizeRecord } from "@codetracer/boundary-shim/dist/browser/record-scrub.js";
import { NO_SCRUB_LISTS } from "@codetracer/boundary-shim/dist/browser/scrub.js";
import {
  canonicalOutput,
  currentSensitiveValues,
  holeText,
  isSensitive,
  makeCtApi,
  maskEventProps,
  placeholder,
  rememberSensitive,
  sensitiveClass,
  sensitiveState,
} from "@codetracer/boundary-shim/dist/browser/sensitive.js";
import type { InputEffect } from "@codetracer/boundary-shim/dist/browser/replay-api.js";

import {
  PROTOCOL_GLOBAL,
  PROTOCOL_VERSION,
  type ProtocolDeclaration,
  ROUTES,
} from "../protocol.js";

/** Defects the build can seed (see `build.ts`). */
export interface ReferenceDefects {
  /** Register handlers on the element with this `data-iid` unwrapped. */
  unwrappedHandler?: string;
  /** Name elements by their position in the document instead of `data-iid`. */
  positionalIds?: boolean;
  /** Never write a checkpoint. */
  noCheckpoints?: boolean;
  /** Leave this capability out of the declaration. */
  omitCapability?: string;
  /**
   * On replay, inject input by dispatching a synthetic DOM event at the
   * target instead of calling the registered handler (§9.5 forbids it).
   */
  injectByDispatch?: boolean;
  /**
   * Record a sensitive field's value as a plain `DomEffect` and its events
   * unmasked, as a framework that ignores the declaration would: the
   * non-interference leg must find the secret in the batches.
   */
  leakSensitive?: boolean;
  /**
   * The sensitive fixtures' apps read the raw sensitive signal outside a
   * declassifier and branch a request on it (compiled into the apps, not
   * the framework): the non-interference leg must fail (§11.3.6).
   */
  leakRawRead?: boolean;
}

/** Set by the build (esbuild `define`). */
declare const __CT_REF_DEFECTS__: ReferenceDefects;

/** The configuration the page's bootstrap element sets (§8.1, §9.2). */
interface PageConfig {
  buildHash?: string;
}

export const FRAMEWORK = "ct-reference/1.0.0";
export const RECORDER_ID = "ct-reference-recorder/1.0.0";
export const SCHEME = "ct-reference-state-v1";
const CAPABILITIES = [
  "input",
  "targets",
  "inject",
  "checkpoint",
  "sensitive",
  "labels",
  "prehydration",
];
/** Frames per uploaded batch: small, so a session spans several batches. */
const FRAMES_PER_BATCH = 16;

/** A signal: the framework state a checkpoint hashes. */
export interface Signal<T> {
  get(): T;
  set(v: T): void;
}

/** What the fixture apps program against (`globalThis.__ctRef`). */
export interface ReferenceApi {
  state<T>(initial: T): Signal<T>;
  /**
   * A signal that holds a sensitive value: left out of the checkpoint hash
   * (§9.6); read on replay outside a declassifier, a raw sensitive read.
   */
  secret(initial: string): Signal<string>;
  /** Declare a field sensitive (§11.3.1). */
  sensitive(el: Element): void;
  /** Declare a free-text field public (§11.3.1); throws on a credential field. */
  public(el: Element): void;
  /**
   * A declassifier under `id` (§11.3.2): its output is logged as
   * `Declassify` on record and returned from the log on replay, where `fn`
   * does not run.
   */
  declassify<A extends unknown[], R>(
    fn: (...args: A) => R,
    id: string,
  ): (...args: A) => R;
  /** The seeded defects, for an app whose defect is its own (`leakRawRead`). */
  readonly defects: ReferenceDefects;
  now(): number;
  perfNow(): number;
  random(): number;
  storageGet(key: string): string | null;
  rect(el: Element): { height: number; width: number };
  fetchText(method: string, url: string, body?: string): Promise<string>;
  setTimeout(fn: () => void, ms: number): void;
  setInterval(fn: () => void, ms: number): number;
  clearInterval(handle: number): void;
  raf(fn: (ts: number) => void): void;
  on(el: Element, type: string, handler: (ev: Event) => void): void;
  create<K extends keyof HTMLElementTagNameMap>(
    tag: K,
  ): HTMLElementTagNameMap[K];
  pushState(url: string): void;
  onPopState(fn: () => void): void;
  hydrate(register: () => void): void;
}

const defects: ReferenceDefects =
  typeof __CT_REF_DEFECTS__ === "undefined" ? {} : __CT_REF_DEFECTS__;

const w = window as Window & typeof globalThis;
const doc = document;
const orig = captureOriginals(w);
const utf8 = new TextEncoder();
/** The replay runner, when this page is being replayed (§9.7). */
const replay: CtReplay | undefined = replayOf(w);

// ── State and checkpoints ───────────────────────────────────────────────

const signals: Signal<unknown>[] = [];
/** The sensitive-input state the page shares with dom-v1 (§11.3). */
const sensitive = sensitiveState(w);
const holes = () => currentSensitiveValues(w, sensitive);

/** `ct-reference-state-v1`: SHA-256 of the JSON of every signal's value. */
function stateHash(): string {
  return sha256Hex(JSON.stringify(signals.map((s) => s.get())));
}

/** The defect "no checkpoints": a recorder that never writes one. */
class NoCheckpointRecorder extends Recorder {
  override checkpointDue(): boolean {
    return false;
  }
  override checkpoint(): void {}
}

const recorderOptions: RecorderOptions = {
  checkpointHash: stateHash,
  checkpointScheme: SCHEME,
  checkpointDomDigest: () => domV1Hash(doc),
  // The URLs it logs, scrubbed and holed as the generic shim's are.
  sanitize: (r) => sanitizeRecord(r, NO_SCRUB_LISTS, holes),
};
const rec = defects.noCheckpoints
  ? new NoCheckpointRecorder(recorderOptions)
  : new Recorder(recorderOptions);

// ── Session start ───────────────────────────────────────────────────────

const config: PageConfig =
  (w as unknown as { __ctBoundaryShimConfig?: PageConfig })
    .__ctBoundaryShimConfig ?? {};
const capabilities = CAPABILITIES.filter((c) => c !== defects.omitCapability);
const sessionBytes = new Uint8Array(16);
orig.getRandomValues.call(w.crypto, sessionBytes);
const sessionId = Array.from(sessionBytes, (b) =>
  b.toString(16).padStart(2, "0"),
).join("");
if (replay === undefined)
  rec.start(
    {
      vocab: 1,
      protocol_level: 1,
      recorder_id: RECORDER_ID,
      framework: FRAMEWORK,
      build_hash: config.buildHash ?? "",
      session_id: sessionId,
      prev_session: "",
      capabilities: JSON.stringify(capabilities),
    },
    readEnvironment(w, orig),
  );
// The document's own loading (§6, "The document's own tasks"): a
// cooperating framework records it as the generic shim does, with the same
// implementation, so its tasks recorded while the page loads replay where
// they ran.
if (replay === undefined) recordDocumentProgress(w, rec, orig.addEventListener);

// ── Targets (§9.3) ──────────────────────────────────────────────────────

const ordTable: Element[] = [];
const ordOf = new Map<Element, number>();

function targetOf(el: Element): string {
  if (defects.positionalIds) {
    return `iid:${Array.prototype.indexOf.call(doc.getElementsByTagName("*"), el)}`;
  }
  const iid = el.getAttribute("data-iid");
  if (iid !== null) return `iid:${iid}`;
  const n = ordOf.get(el);
  if (n !== undefined) return `ord:${n}`;
  throw new Error(`<${el.localName}> has neither a data-iid nor an ord`);
}

function resolveTarget(target: string): Element | Document | Window | null {
  if (target === "doc") return doc;
  if (target === "win") return w;
  if (target.startsWith("ord:"))
    return ordTable[Number(target.slice(4)) - 1] ?? null;
  if (!target.startsWith("iid:")) return null;
  const id = target.slice(4);
  if (defects.positionalIds)
    return doc.getElementsByTagName("*")[Number(id)] ?? null;
  for (const el of Array.from(doc.querySelectorAll("[data-iid]"))) {
    if (el.getAttribute("data-iid") === id) return el;
  }
  return null;
}

// ── Input (§9.5) ────────────────────────────────────────────────────────

/** The event properties an `Input` carries, as the generic shim's subset. */
const PROPS = [
  "key",
  "code",
  "clientX",
  "clientY",
  "button",
  "detail",
  "data",
  "inputType",
];

function propsOf(ev: Event): string {
  const out: Record<string, unknown> = {};
  for (const k of PROPS) {
    const v = (ev as unknown as Record<string, unknown>)[k];
    if (
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean" ||
      v === null
    ) {
      if (k in ev) out[k] = v;
    }
  }
  return JSON.stringify(out);
}

/** §9.4: the component and accessible name of the element. */
function labelOf(el: Element): string {
  const iid = el.getAttribute("data-iid");
  const component = iid === null ? "client" : iid.split("/")[0];
  const name =
    el.getAttribute("aria-label") ?? (el.textContent ?? "").trim().slice(0, 40);
  return `${component}/${el.localName} ${JSON.stringify(name)}`;
}

/** The `DomEffect`s of default actions that already changed `el` (§9.5). */
function effectsOf(el: Element, ev: Event): [number, unknown][] {
  const c = el as HTMLInputElement;
  const isControl = ["input", "textarea", "select"].includes(el.localName);
  if (!isControl) return [];
  const checkable =
    el.localName === "input" && (c.type === "checkbox" || c.type === "radio");
  if (checkable && ["click", "input", "change"].includes(ev.type))
    return [[2, c.checked]];
  if (ev.type === "input" || ev.type === "change") return [[1, c.value]];
  return [];
}

interface Registration {
  el: Element;
  type: string;
  handler: (ev: Event) => void;
}
const registrations: Registration[] = [];

/** Write the records of one handler invocation: effects, then Task and Input. */
function recordInvocation(
  reg: Registration,
  ev: Event,
  hydrationTask?: bigint,
): void {
  const target = targetOf(reg.el);
  if (hydrationTask === undefined) rec.macrotask();
  const masked = !defects.leakSensitive && isSensitive(sensitive, reg.el);
  if (masked) sensitive.seen.add(reg.el);
  for (const [effect, value] of effectsOf(reg.el, ev)) {
    if (masked && effect === 1) {
      const v = String(value);
      rememberSensitive(sensitive, v);
      rec.emit("Scrubbed", {
        target,
        class: sensitiveClass(sensitive, reg.el),
        length: v.length,
      });
      continue;
    }
    rec.emit("DomEffect", { target, effect, value: JSON.stringify(value) });
  }
  let taskId = hydrationTask;
  if (taskId === undefined) {
    taskId = rec.nextTaskId();
    rec.emit("Task", { task_id: taskId, kind: 5 });
  }
  rec.emit("Input", {
    task_id: taskId,
    type: ev.type,
    target,
    props: masked
      ? JSON.stringify(
          maskEventProps(JSON.parse(propsOf(ev)) as Record<string, unknown>),
        )
      : propsOf(ev),
    label: labelOf(reg.el),
  });
}

function on(el: Element, type: string, handler: (ev: Event) => void): void {
  targetOf(el); // an element the protocol cannot name is refused here
  const reg: Registration = { el, type, handler };
  registrations.push(reg);
  if (
    defects.unwrappedHandler !== undefined &&
    el.getAttribute("data-iid") === defects.unwrappedHandler
  ) {
    orig.addEventListener.call(el, type, handler as EventListener);
    return;
  }
  orig.addEventListener.call(el, type, ((ev: Event) => {
    if (replay !== undefined) {
      // Replayed input arrives through `inject`; only what the page
      // dispatches itself reaches the handler through the DOM.
      if (!ev.isTrusted) handler(ev);
      return;
    }
    // A page-dispatched event is the page's own deterministic behaviour.
    if (ev.isTrusted) recordInvocation(reg, ev);
    handler(ev);
  }) as EventListener);
}

// ── The pre-hydration queue (§9.5) ──────────────────────────────────────

const deferred =
  doc.documentElement.getAttribute("data-ref-hydration") === "deferred";
let hydrated = !deferred;
const queued: Event[] = [];
if (deferred && replay === undefined) {
  orig.addEventListener.call(
    doc,
    "click",
    ((ev: Event) => {
      if (!hydrated && ev.isTrusted) queued.push(ev);
    }) as EventListener,
    { capture: true },
  );
}

function hydrate(register: () => void): void {
  if (replay !== undefined) {
    replayHydrate(replay, register);
    return;
  }
  // Hydration is a macrotask of its own, and the framework mints its id:
  // `Task{kind: 11}` with no `TaskReg` (§6).
  orig.setTimeout.call(
    w,
    () => {
      const h = rec.nextTaskId();
      rec.task(h, 11);
      hydrated = true;
      register();
      for (const ev of queued.splice(0)) {
        for (const reg of registrations) {
          if (
            reg.type === ev.type &&
            ev.target instanceof Node &&
            reg.el.contains(ev.target)
          ) {
            recordInvocation(reg, ev, h);
            reg.handler(ev);
          }
        }
      }
    },
    0,
  );
}

// ── Seams ───────────────────────────────────────────────────────────────

function clock(src: number, v: number): number {
  rec.emit("Clock", { src, bits: numberToBits(v) });
  return v;
}

function fetchText(
  method: string,
  url: string,
  body?: string,
): Promise<string> {
  const abs = new URL(url, w.location.href).href;
  const reqId = rec.nextReqId();
  // The network seam is the sanctioned sink (§11.3.1): the real value goes
  // out, its holed form is logged (§5.2.1).
  rec.emit("NetRequest", {
    req_id: reqId,
    api: 1,
    method,
    url: abs,
    body_digest: body === undefined ? "" : sha256Hex(holeText(body, holes())),
  });
  const taskId = rec.nextTaskId();
  rec.emit("TaskReg", { task_id: taskId, kind: 4, delay_ms: 0 });
  const complete = (
    outcome: number,
    status: number,
    meta: NetResponseMeta,
    headers: [string, string][],
    text: string,
  ) =>
    new Promise<void>((resolve) => {
      // The completion is released as a macrotask of its own, so its
      // records and the application's continuation start at a quiescent
      // point (§6, §7.3).
      orig.setTimeout.call(
        w,
        () => {
          rec.task(taskId, 4);
          rec.emit("NetResponse", {
            req_id: reqId,
            outcome,
            status,
            ...meta,
            headers: JSON.stringify(headers),
            body: { kind: "inline", bytes: utf8.encode(text) },
          });
          resolve();
        },
        0,
      );
    });
  return orig
    .fetch!.call(w, abs, {
      method,
      body,
      headers:
        body === undefined ? undefined : { "content-type": "application/json" },
    })
    .then(
      async (res) => {
        const text = await res.text();
        const headers: [string, string][] = [];
        res.headers.forEach((v, k) => headers.push([k, v]));
        await complete(1, res.status, fetchResponseMeta(res), headers, text);
        return text;
      },
      async (e: unknown) => {
        await complete(2, 0, NO_RESPONSE_META, [], "");
        throw e;
      },
    );
}

/** A declassifier's call on record: run it and log its output (§11.3.2). */
const recordDeclassify = makeCtApi(w, sensitive, (id, fn, self, args) => {
  const out = fn.apply(self, args);
  const output = canonicalOutput(out);
  if (output === undefined) {
    rec.emit("Refusal", {
      feature: "unrecordable-declassifier",
      detail: `${id} returned a value that is not JSON data`,
    });
  } else {
    rec.emit("Declassify", { fn_id: id, output });
  }
  return out;
});

const api: ReferenceApi = {
  defects,
  secret(initial: string): Signal<string> {
    let value = initial;
    // Not in `signals`: a sensitive signal contributes nothing to the
    // checkpoint hash, not even a write count (§9.6).
    return {
      get: () => value,
      set: (v) => {
        value = v;
      },
    };
  },
  sensitive(el) {
    recordDeclassify.sensitive(el);
  },
  public(el) {
    recordDeclassify.public(el);
  },
  declassify(fn, id) {
    return recordDeclassify.declassify(fn, { id });
  },
  state<T>(initial: T): Signal<T> {
    let value = initial;
    const s: Signal<T> = {
      get: () => value,
      set: (v) => {
        value = v;
      },
    };
    signals.push(s as Signal<unknown>);
    return s;
  },
  now: () => clock(1, orig.dateNow()),
  perfNow: () => clock(2, orig.performanceNow.call(w.performance)),
  random() {
    const v = orig.mathRandom();
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, v, true);
    rec.emit("Random", { src: 1, bytes });
    return v;
  },
  storageGet(key) {
    const v = orig.storageGetItem.call(w.localStorage, key);
    rec.emit("StorageRead", {
      area: 1,
      key,
      present: v === null ? 0 : 1,
      value: v ?? "",
    });
    return v;
  },
  rect(el) {
    const r = orig.getBoundingClientRect.call(el);
    const value = {
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      left: r.left,
    };
    rec.emit("LayoutRead", {
      target: targetOf(el),
      prop: "getBoundingClientRect",
      value: JSON.stringify(value),
    });
    return value;
  },
  fetchText,
  setTimeout(fn, ms) {
    const id = rec.nextTaskId();
    rec.emit("TaskReg", { task_id: id, kind: 1, delay_ms: ms });
    orig.setTimeout.call(
      w,
      () => {
        rec.task(id, 1);
        fn();
      },
      ms,
    );
  },
  setInterval(fn, ms) {
    const id = rec.nextTaskId();
    rec.emit("TaskReg", { task_id: id, kind: 2, delay_ms: ms });
    return orig.setInterval.call(
      w,
      () => {
        rec.task(id, 2);
        fn();
      },
      ms,
    ) as unknown as number;
  },
  clearInterval(handle) {
    orig.clearInterval.call(w, handle);
  },
  raf(fn) {
    const id = rec.nextTaskId();
    rec.emit("TaskReg", { task_id: id, kind: 3, delay_ms: 0 });
    orig.requestAnimationFrame!.call(w, (ts) => {
      rec.task(id, 3);
      clock(4, ts);
      fn(ts);
    });
  },
  on,
  create(tag) {
    const el = doc.createElement(tag);
    ordTable.push(el);
    ordOf.set(el, ordTable.length);
    return el;
  },
  pushState(url) {
    orig.pushState.call(w.history, null, "", url);
    rec.emit("Navigation", { kind: 1, url: w.location.href });
  },
  onPopState(fn) {
    if (replay !== undefined) {
      replayOnPopState(replay, fn);
      return;
    }
    orig.addEventListener.call(w, "popstate", ((ev: Event) => {
      if (ev.isTrusted) {
        // Dispatched by the browser: no TaskReg, the id is minted here (§6).
        rec.task(rec.nextTaskId(), 12);
        rec.emit("Navigation", { kind: 3, url: w.location.href });
      }
      fn();
    }) as EventListener);
  },
  hydrate,
};

// ── Upload (§9.8) and the declaration (§9.2) ────────────────────────────

let stopped: Promise<void> | undefined;

/** Send every frame as batches with the Boundary-Ingest envelope. */
async function upload(): Promise<void> {
  const frames = rec.frameList.slice();
  let lastSeq = 0;
  for (
    let i = 0, batchSeq = 0;
    i < frames.length;
    i += FRAMES_PER_BATCH, batchSeq++
  ) {
    const chunk = frames.slice(i, i + FRAMES_PER_BATCH);
    const seqs = chunk
      .map((f) => seqOf(decodeRecord(f.subarray(4)) as BoundaryRecord))
      .filter((s): s is bigint => s !== undefined)
      .map(Number);
    const first = seqs.length > 0 ? seqs[0] : lastSeq + 1;
    const last = seqs.length > 0 ? seqs[seqs.length - 1] : lastSeq;
    lastSeq = last;
    let size = 0;
    for (const f of chunk) size += f.length;
    const run = new Uint8Array(size);
    let at = 0;
    for (const f of chunk) {
      run.set(f, at);
      at += f.length;
    }
    const body = encodeBatch(
      {
        session_id: sessionId,
        batch_seq: batchSeq,
        first_seq: first,
        last_seq: last,
        dropped: [],
        build_hash: config.buildHash ?? "",
        final: i + FRAMES_PER_BATCH >= frames.length,
      },
      run,
    );
    const res = await orig.fetch!.call(w, ROUTES.batches, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: body as unknown as BodyInit,
    });
    if (res.status !== 202)
      throw new Error(`batch ${batchSeq} answered ${res.status}`);
  }
}

const declaration: ProtocolDeclaration & { replay?: ReplayHooks } =
  replay === undefined
    ? {
        protocol: PROTOCOL_VERSION,
        framework: FRAMEWORK,
        capabilities,
        record: {
          stop() {
            stopped ??= (async () => {
              rec.end(2);
              await upload();
            })();
            return stopped;
          },
          resolveTarget,
        },
      }
    : {
        protocol: PROTOCOL_VERSION,
        framework: FRAMEWORK,
        capabilities,
        replay: replayHooks(replay),
      };
Object.defineProperty(w, PROTOCOL_GLOBAL, {
  value: declaration,
  configurable: false,
  writable: false,
});
Object.defineProperty(w, "__ctRef", {
  value: replay === undefined ? api : replayApi(replay),
  configurable: false,
  writable: false,
});

// ── Replay (§9.5, §9.7) ─────────────────────────────────────────────────
//
// The same seams, answering from the runner's cursor. Task and request ids
// are minted at the points the record side minted them, so they are the
// log's ids and the cursor checks them.

let replayTaskIds = 1n;
let replayReqIds = 1n;

/** The task id the browser's dispatch was recorded under must be the next. */
function claimTask(r: CtReplay, logged: bigint): void {
  if (logged !== replayTaskIds) {
    r.fail(
      "TaskOrderMismatch",
      `task ${logged} was minted when it ran, but the framework's next task id is ${replayTaskIds}`,
    );
  }
  replayTaskIds++;
}

function replayClock(r: CtReplay, src: number): number {
  const bits = r.next("Clock", { src }).bits;
  const v = new DataView(new ArrayBuffer(8));
  v.setBigUint64(0, bits, true);
  return v.getFloat64(0, true);
}

/**
 * The `DomEffect`s of default actions, applied before a handler runs; a
 * `Scrubbed` puts the placeholder of its class and length into the field
 * (§11.3.4).
 */
function applyEffects(effects: InputEffect[]): string | undefined {
  for (const e of effects) {
    const t = resolveTarget(e.target) as HTMLInputElement | null;
    if (t === null) return `${e.record} target ${e.target} does not resolve`;
    if (e.record === "Scrubbed") {
      const value = placeholder(e.class, e.length);
      t.value = value;
      sensitive.seen.add(t);
      rememberSensitive(sensitive, value);
      continue;
    }
    const v = JSON.parse(e.value) as unknown;
    if (e.effect === 1) t.value = String(v);
    else if (e.effect === 2) t.checked = v === true;
    else return `DomEffect ${e.effect} is not one this framework records`;
  }
  return undefined;
}

/** An event with the recorded properties, as a handler of `type` reads it. */
function eventFor(
  type: string,
  props: Record<string, unknown>,
  target: Element,
): Event {
  const init = { ...props, bubbles: true, cancelable: true };
  const ev =
    type === "click"
      ? new w.MouseEvent(type, init as MouseEventInit)
      : type === "input"
        ? new w.InputEvent(type, init as InputEventInit)
        : type === "keydown" || type === "keyup"
          ? new w.KeyboardEvent(type, init as KeyboardEventInit)
          : new w.Event(type, init);
  Object.defineProperty(ev, "target", { value: target });
  Object.defineProperty(ev, "currentTarget", { value: target });
  return ev;
}

/** Call the registered handler for `input` (§9.5); `"ok"` or why not. */
function invoke(
  input: { type: string; target: string; props: string },
  effects: InputEffect[],
): string {
  const problem = applyEffects(effects);
  if (problem !== undefined) return problem;
  const el = resolveTarget(input.target);
  if (!(el instanceof w.Element))
    return `target ${input.target} does not resolve`;
  const reg = registrations.find((r) => r.el === el && r.type === input.type);
  if (reg === undefined) {
    return `no ${input.type} handler is registered on ${input.target}`;
  }
  const ev = eventFor(
    input.type,
    JSON.parse(input.props) as Record<string, unknown>,
    el,
  );
  if (defects.injectByDispatch) {
    el.dispatchEvent(ev);
    return "ok";
  }
  reg.handler(ev);
  return "ok";
}

function replayHooks(r: CtReplay): ReplayHooks {
  return {
    inject(input, effects) {
      claimTask(r, input.task_id);
      return invoke(input, effects);
    },
    checkpoint: () => ({ scheme: SCHEME, state_hash: stateHash() }),
  };
}

function replayHydrate(r: CtReplay, register: () => void): void {
  r.onUnregisteredTask(11, (task) => {
    claimTask(r, task.task_id);
    hydrated = true;
    register();
    // The inputs that waited for hydration ran inside the hydration task
    // (§9.5): their effects and Inputs follow its Task in the log.
    let effects: InputEffect[] = [];
    for (;;) {
      const v = r.peek().record;
      if (v?.record === "DomEffect") {
        effects.push(r.next("DomEffect"));
      } else if (v?.record === "Scrubbed") {
        effects.push(r.next("Scrubbed"));
      } else if (v?.record === "Input" && v.task_id === task.task_id) {
        const input = r.next("Input");
        const result = invoke(input, effects);
        if (result !== "ok") r.fail("InjectionFailed", result);
        effects = [];
      } else {
        break;
      }
    }
  });
}

function replayOnPopState(r: CtReplay, fn: () => void): void {
  r.onUnregisteredTask(12, (task) => {
    claimTask(r, task.task_id);
    const nav = r.next("Navigation", { kind: 3 });
    orig.replaceState.call(w.history, null, "", nav.url);
    fn();
  });
  orig.addEventListener.call(w, "popstate", ((ev: Event) => {
    if (!ev.isTrusted) fn();
  }) as EventListener);
}

function replayApi(r: CtReplay): ReferenceApi {
  const replayDeclassify = makeCtApi(w, sensitive, (id) => {
    const d = r.next("Declassify", { fn_id: id });
    return JSON.parse(d.output) as unknown;
  });
  return {
    defects,
    secret(initial: string): Signal<string> {
      let value = initial;
      return {
        // Read outside a declassifier: the framework's unchecked unwrap
        // (§7.2), which the replay reports as a raw sensitive read.
        get: () => {
          r.noteSensitiveRead({
            target: "",
            what: "secret signal",
            frames: (new Error().stack ?? "").split("\n").slice(2, 10),
          });
          return value;
        },
        set: (v) => {
          value = v;
        },
      };
    },
    sensitive: (el) => {
      replayDeclassify.sensitive(el);
    },
    public: (el) => {
      replayDeclassify.public(el);
    },
    declassify: (fn, id) => replayDeclassify.declassify(fn, { id }),
    state: api.state,
    create: api.create,
    on,
    hydrate,
    onPopState: api.onPopState,
    now: () => replayClock(r, 1),
    perfNow: () => replayClock(r, 2),
    random() {
      const b = r.next("Random", { src: 1 }).bytes;
      if (b.length !== 8)
        r.fail("ArgumentMismatch", `a Random of ${b.length} bytes`);
      return new DataView(b.buffer, b.byteOffset, 8).getFloat64(0, true);
    },
    storageGet(key) {
      const s = r.next("StorageRead", { area: 1, key });
      return s.present === 1 ? s.value : null;
    },
    rect(el) {
      return JSON.parse(
        r.next("LayoutRead", {
          target: targetOf(el),
          prop: "getBoundingClientRect",
        }).value,
      ) as { height: number; width: number };
    },
    fetchText(method, url, body) {
      const reqId = replayReqIds++;
      const h = holes();
      r.next("NetRequest", {
        req_id: reqId,
        api: 1,
        method,
        url: holeText(new URL(url, w.location.href).href, h),
        body_digest: body === undefined ? "" : sha256Hex(holeText(body, h)),
      });
      const taskId = replayTaskIds++;
      r.registerTask(taskId, 4, 0);
      return new orig.Promise<string>((resolve, reject) => {
        r.onTask(taskId, () => {
          r.offTask(taskId);
          const res = r.next("NetResponse", { req_id: reqId });
          if (res.outcome !== 1 || res.body.kind !== "inline") {
            reject(new TypeError("Failed to fetch"));
            return;
          }
          resolve(new TextDecoder().decode(res.body.bytes));
        });
      });
    },
    setTimeout(fn, ms) {
      const id = replayTaskIds++;
      r.registerTask(id, 1, ms);
      r.onTask(id, () => {
        r.offTask(id);
        fn();
      });
    },
    setInterval(fn, ms) {
      const id = replayTaskIds++;
      r.registerTask(id, 2, ms);
      r.onTask(id, fn);
      return Number(id);
    },
    clearInterval(handle) {
      r.offTask(BigInt(handle));
    },
    raf(fn) {
      const id = replayTaskIds++;
      r.registerTask(id, 3, 0);
      r.onTask(id, () => {
        r.offTask(id);
        fn(replayClock(r, 4));
      });
    },
    pushState(url) {
      orig.pushState.call(w.history, null, "", url);
      r.next("Navigation", { kind: 1, url: w.location.href });
    },
  };
}

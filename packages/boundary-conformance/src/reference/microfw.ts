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
import { readEnvironment } from "@codetracer/boundary-shim/dist/browser/install.js";
import { captureOriginals } from "@codetracer/boundary-shim/dist/browser/originals.js";
import {
  Recorder,
  type RecorderOptions,
  numberToBits,
} from "@codetracer/boundary-shim/dist/browser/recorder.js";
import { sha256Hex } from "@codetracer/boundary-shim/dist/browser/sha256.js";

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

// ── State and checkpoints ───────────────────────────────────────────────

const signals: Signal<unknown>[] = [];

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
  if (hydrationTask === undefined && rec.checkpointDue()) rec.checkpoint();
  for (const [effect, value] of effectsOf(reg.el, ev)) {
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
    props: propsOf(ev),
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
if (deferred) {
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
  rec.emit("NetRequest", {
    req_id: reqId,
    api: 1,
    method,
    url: abs,
    body_digest: body === undefined ? "" : sha256Hex(body),
  });
  const taskId = rec.nextTaskId();
  rec.emit("TaskReg", { task_id: taskId, kind: 4, delay_ms: 0 });
  const complete = (
    outcome: number,
    status: number,
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
        await complete(1, res.status, headers, text);
        return text;
      },
      async (e: unknown) => {
        await complete(2, 0, [], "");
        throw e;
      },
    );
}

const api: ReferenceApi = {
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

const declaration: ProtocolDeclaration = {
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
};
Object.defineProperty(w, PROTOCOL_GLOBAL, {
  value: declaration,
  configurable: false,
  writable: false,
});
Object.defineProperty(w, "__ctRef", {
  value: api,
  configurable: false,
  writable: false,
});

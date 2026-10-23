/**
 * Replay of `fetch`, `navigator.sendBeacon`, `WebSocket` and `EventSource`
 * (CodeTracer's JS-Boundary-Recording specification §5.2 `NetRequest`,
 * `NetResponse`, `WsMessage`; §6; §10.1; §10.4). XMLHttpRequest is in
 * `xhr.ts`.
 *
 * Nothing reaches the network: a request is matched against the log's
 * `NetRequest` (method, URL and body digest are checked) and its
 * `TaskReg`, and what came back is delivered from the log when the
 * scheduler releases the request's tasks, in the shapes the record side
 * wrote them (§10.4): a `fetch` response's head (outcome 5) and then its
 * body piece by piece as the page reads it, a whole response (outcome 1)
 * or a failure; a socket's or event stream's events one per task.
 */

import type { RecordOf } from "@codetracer/boundary-format";

import { asConstructor, replaceAccessor, replaceValue } from "../context.js";
import { TaskKind } from "../recorder.js";
import {
  absoluteUrl,
  bodyDigest,
  messageBytes,
  normaliseMethod,
} from "../seams-net.js";
import { BODY_CONSUMERS, Dir, Outcome } from "../stream-body.js";
import { type ReplayContext, blobBytes } from "./context.js";

/** `NetRequest.api` (§5.2). */
const Api = { fetch: 1, xhr: 2, beacon: 3, webSocket: 4, eventSource: 5 };

/** Replace every seam this module owns (XMLHttpRequest: `xhr.ts`). */
export function replayNetSeams(ctx: ReplayContext): void {
  replayFetch(ctx);
  replayBeacon(ctx);
  replayWebSocket(ctx);
  replayEventSource(ctx);
}

/** Statuses whose response has no body (Fetch standard, "null body status"). */
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

/** The error a failed request or body rejects with, by `outcome`. */
export function failureError(
  w: Window & typeof globalThis,
  outcome: number,
  signal: AbortSignal | undefined,
): unknown {
  if (outcome === Outcome.abort) {
    return (
      signal?.reason ??
      new w.DOMException("The user aborted a request.", "AbortError")
    );
  }
  if (outcome === Outcome.timeout) {
    return new w.DOMException("signal timed out", "TimeoutError");
  }
  return new w.TypeError("Failed to fetch");
}

/** The `{"outcome": n}` of a body's end (`WsMessage{dir 4}`, §10.4). */
export function endOutcome(
  ctx: ReplayContext,
  m: RecordOf<"WsMessage">,
): number {
  const text = new TextDecoder().decode(blobBytes(ctx.replay, m.data));
  const o = (JSON.parse(text) as { outcome?: unknown }).outcome;
  return typeof o === "number" ? o : Outcome.networkError;
}

/**
 * A whole-body read of a replayed response: `go` continues the page once
 * the platform settled it, `released` once the scheduler released its task,
 * `done` tells the scheduler the continuation ran.
 */
interface BodyRead {
  released: boolean;
  go?: () => void;
  done?: () => void;
}

function replayFetch(ctx: ReplayContext): void {
  const { w, replay, orig } = ctx;
  if (orig.fetch === undefined || orig.Response === undefined) return;
  const OrigResponse = orig.Response;
  const OrigStream = orig.ReadableStream ?? w.ReadableStream;
  const OrigPromise = orig.Promise;
  const queueMicrotask = orig.queueMicrotask;

  // A constructed Response cannot be given what only the platform sets on
  // one: the Response accessors answer those from `meta` for a replayed
  // response, and `clone()` carries them over (as stream-body.ts does on
  // record). The log keeps neither the final URL of a redirect nor the
  // status text (§10.4): the request's URL and "" stand in for them.
  const meta = new WeakMap<object, Record<string, unknown>>();
  for (const [name, g] of orig.responseGetters) {
    const get = g.descriptor.get!;
    replaceAccessor(
      g.owner,
      name,
      function (this: unknown) {
        const m = meta.get(this as object);
        return m !== undefined && name in m ? m[name] : get.call(this);
      },
      g.descriptor.set,
    );
  }
  // A streamed response (and its clones) -> the whole-body reads made of
  // it, waiting for the tasks the recorder wrote when they settled.
  const consuming = new WeakMap<object, BodyRead[]>();
  const origClone = orig.responseClone;
  if (origClone !== undefined) {
    replaceValue(
      OrigResponse.prototype,
      "clone",
      function clone(this: Response) {
        const c = origClone.call(this);
        const m = meta.get(this);
        if (m !== undefined) meta.set(c, m);
        const q = consuming.get(this);
        if (q !== undefined) consuming.set(c, q);
        return c;
      },
    );
  }

  // A whole-body read (`json()`, `text()`, …) of a streamed response settles
  // in a task of the platform's own, which the recorder wrote as a `Task`
  // of the request (stream-body.ts, BODY_CONSUMERS): the page's
  // continuation runs only when the scheduler releases that task, and the
  // scheduler waits for the read to settle.
  const then = orig.promiseThen;
  for (const name of BODY_CONSUMERS) {
    const read = (OrigResponse.prototype as unknown as Record<string, unknown>)[
      name
    ];
    if (typeof read !== "function") continue;
    replaceValue(OrigResponse.prototype, name, function (this: Response) {
      const settled = (read as (...a: unknown[]) => Promise<unknown>).apply(
        this,
        Array.from(arguments),
      );
      const q = consuming.get(this);
      if (q === undefined) return settled;
      const r: BodyRead = { released: false };
      q.push(r);
      return new OrigPromise((resolve, reject) => {
        const settle = (go: () => void) => {
          r.go = go;
          if (r.released) {
            go();
            r.done?.();
          }
        };
        (then as Promise<unknown>["then"]).call(
          settled,
          (v) => settle(() => resolve(v)),
          (e: unknown) => settle(() => reject(e)),
        );
      });
    });
  }

  /** The page's response for a logged head or whole response. */
  const responseOf = (
    r: RecordOf<"NetResponse">,
    url: string,
    body: BodyInit | null,
    reads?: BodyRead[],
  ): Response => {
    const headers = JSON.parse(r.headers) as [string, string][];
    const status = r.status;
    let sameOrigin = false;
    try {
      sameOrigin = new URL(url).origin === w.location.origin;
    } catch {
      sameOrigin = false;
    }
    const m: Record<string, unknown> = {
      url,
      redirected: false,
      type: sameOrigin ? "basic" : "cors",
      statusText: "",
    };
    let resp: Response;
    try {
      resp = new OrigResponse(NULL_BODY.has(status) ? null : body, {
        status,
        headers,
      });
      if (reads !== undefined && body !== null) consuming.set(resp, reads);
    } catch {
      // A status the constructor refuses (an opaque response's 0).
      resp = new OrigResponse(null, { headers });
      m.type = "opaque";
      Object.defineProperty(resp, "status", { value: status });
      Object.defineProperty(resp, "ok", { value: false });
    }
    meta.set(resp, m);
    return resp;
  };

  replaceValue(
    w,
    "fetch",
    function fetch(input: RequestInfo | URL, init?: RequestInit) {
      const isRequest = input instanceof w.Request;
      const method = normaliseMethod(
        init?.method ?? (isRequest ? (input as Request).method : "GET"),
      );
      const url = isRequest
        ? (input as Request).url
        : absoluteUrl(w, input instanceof URL ? input.href : input);
      let digest: string | null;
      if (init?.body !== undefined) digest = bodyDigest(init.body);
      else if (isRequest && (input as Request).body !== null) digest = null;
      else digest = "";
      const reqId = ctx.nextReqId();
      const taskId = ctx.nextTaskId();
      replay.next("NetRequest", {
        req_id: reqId,
        api: Api.fetch,
        method,
        url,
        // An unreadable body was refused on record before this request
        // (the Refusal is reached first); its digest was then empty.
        body_digest: digest ?? "",
      });
      replay.registerTask(taskId, TaskKind.networkCompletion, 0);
      const signal =
        init?.signal ??
        (isRequest ? (input as Request).signal : undefined) ??
        undefined;

      return new OrigPromise<Response>((resolve, reject) => {
        let phase: "head" | "body" | "done" = "head";
        let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
        let waiting: (() => void) | undefined;
        let cancelled = false;
        /** The whole-body reads of the response, in the order made. */
        const reads: BodyRead[] = [];

        // The request's task stays claimed after the body ended: a
        // whole-body read settles in one more.
        const finish = () => {
          phase = "done";
        };

        /** Deliver the body record at the cursor to the page's stream. */
        const deliver = () => {
          const m = replay.next("WsMessage", { req_id: reqId });
          if (m.dir === Dir.in) {
            controller!.enqueue(blobBytes(replay, m.data));
          } else if (m.dir === Dir.end) {
            const outcome = endOutcome(ctx, m);
            finish();
            if (outcome === Outcome.response) controller!.close();
            else controller!.error(failureError(w, outcome, signal));
          } else {
            replay.fail(
              "ArgumentMismatch",
              `a fetch body record has dir ${m.dir}`,
            );
          }
          const done = waiting;
          waiting = undefined;
          done?.();
        };
        const bodyRecordNext = () => {
          const v = replay.peek();
          return v.record?.record === "WsMessage" && v.record.req_id === reqId;
        };

        const stream = new OrigStream<Uint8Array>(
          {
            start(c) {
              controller = c;
            },
            pull() {
              if (phase !== "body") return;
              // A piece that was already there when the page read is next in
              // the log; one that arrived later comes in a task of its own.
              if (bodyRecordNext()) {
                deliver();
                return;
              }
              return new OrigPromise<void>((r) => {
                waiting = r;
              });
            },
            cancel() {
              cancelled = true;
              finish();
            },
          },
          { highWaterMark: 0 },
        );

        replay.onTask(taskId, () => {
          if (phase === "head") {
            const r = replay.next("NetResponse", { req_id: reqId });
            if (r.outcome === Outcome.head) {
              phase = "body";
              resolve(responseOf(r, url, stream, reads));
            } else if (r.outcome === Outcome.response) {
              finish();
              resolve(
                responseOf(r, url, blobBytes(replay, r.body) as BodyInit),
              );
            } else {
              finish();
              reject(failureError(w, r.outcome, signal));
            }
            return;
          }
          if (phase === "body" && waiting !== undefined && !cancelled) {
            deliver();
            return;
          }
          const read = reads.shift();
          if (read !== undefined) {
            read.released = true;
            if (read.go !== undefined) {
              read.go();
              return;
            }
            return new OrigPromise<void>((done) => {
              read.done = done;
            });
          }
          replay.fail(
            "MissingRead",
            "a piece of a fetch response body arrived in a task of its own, but the page was not reading the body",
          );
        });

        // An abort is the page's own call: what it ends is logged without
        // a Task, in the microtask the platform's rejection would run in.
        const onAbort = () =>
          queueMicrotask.call(w, () => {
            if (phase === "head") {
              const v = replay.peek();
              if (
                v.record?.record === "NetResponse" &&
                v.record.req_id === reqId
              ) {
                const r = replay.next("NetResponse", { req_id: reqId });
                finish();
                reject(failureError(w, r.outcome, signal));
              }
            } else if (phase === "body" && bodyRecordNext()) {
              deliver();
            }
          });
        if (signal !== undefined && signal !== null) {
          if (signal.aborted) onAbort();
          else
            orig.addEventListener.call(signal, "abort", onAbort, {
              once: true,
            });
        }
      });
    },
  );
}

function replayBeacon({ w, replay, orig, nextReqId }: ReplayContext): void {
  if (orig.sendBeacon === undefined) return;
  replaceValue(
    w.Navigator.prototype,
    "sendBeacon",
    function sendBeacon(
      this: Navigator,
      url: string | URL,
      data?: BodyInit | null,
    ): boolean {
      const reqId = nextReqId();
      replay.next("NetRequest", {
        req_id: reqId,
        api: Api.beacon,
        method: "POST",
        url: absoluteUrl(w, url instanceof URL ? url.href : url),
        body_digest: bodyDigest(data) ?? "",
      });
      // Logged at once: outcome 1 when the browser queued it (§10.4).
      return (
        replay.next("NetResponse", { req_id: reqId }).outcome ===
        Outcome.response
      );
    },
  );
}

/** A streaming connection's replay state (a socket or an event stream). */
interface Conn {
  url: string;
  readyState: number;
  reqId: bigint;
  taskId: bigint;
  binaryType: BinaryType;
  handlers: Map<string, EventListener>;
  /** Event types the page listens for (an event stream's named events). */
  types: Set<string>;
}

/**
 * Make `Orig`'s instances answer from `conns` when they are replayed
 * connections, and from the platform otherwise (the `__ct` runtime's own
 * socket is a real one, made from the captured original).
 */
function replayAccessors(
  w: Window & typeof globalThis,
  proto: object,
  conns: WeakMap<object, Conn>,
  values: Record<string, (c: Conn) => unknown>,
  handlerTypes: readonly string[],
): void {
  for (const [name, value] of Object.entries(values)) {
    const d = Object.getOwnPropertyDescriptor(proto, name);
    if (d?.get === undefined) continue;
    const get = d.get;
    const set = d.set;
    replaceAccessor(
      proto,
      name,
      function (this: unknown) {
        const c = conns.get(this as object);
        return c === undefined ? get.call(this) : value(c);
      },
      set === undefined
        ? undefined
        : function (this: unknown, v: unknown) {
            const c = conns.get(this as object);
            if (c === undefined) set.call(this, v);
            else if (name === "binaryType") c.binaryType = v as BinaryType;
          },
    );
  }
  for (const type of handlerTypes) {
    const name = `on${type}`;
    const d = Object.getOwnPropertyDescriptor(proto, name);
    if (d?.get === undefined || d.set === undefined) continue;
    const get = d.get;
    const set = d.set;
    replaceAccessor(
      proto,
      name,
      function (this: unknown) {
        const c = conns.get(this as object);
        if (c === undefined) return get.call(this);
        const h = c.handlers.get(type) as { handler?: unknown } | undefined;
        return h?.handler ?? null;
      },
      function (this: unknown, v: unknown) {
        const c = conns.get(this as object);
        if (c === undefined) {
          set.call(this, v);
          return;
        }
        const target = this as EventTarget;
        const prev = c.handlers.get(type);
        if (prev !== undefined) {
          w.EventTarget.prototype.removeEventListener.call(target, type, prev);
          c.handlers.delete(type);
        }
        if (typeof v === "function") {
          const wrapper = Object.assign(
            (ev: Event) => (v as Function).call(target, ev),
            { handler: v },
          );
          c.handlers.set(type, wrapper);
          w.EventTarget.prototype.addEventListener.call(target, type, wrapper);
        }
      },
    );
  }
}

/** A new object that is an `EventTarget` and an instance of `Ctor`. */
function newConnObject(w: Window & typeof globalThis, Ctor: Function): object {
  const o = new w.EventTarget();
  Object.setPrototypeOf(o, (Ctor as { prototype: object }).prototype);
  return o;
}

/**
 * The data of an inbound message: text when the bytes are UTF-8 (a socket's
 * text frame), otherwise binary in the page's `binaryType`. The log keeps
 * the bytes only (§10.4), so a binary frame that happens to be valid UTF-8
 * is delivered as text.
 */
function messageData(
  w: Window & typeof globalThis,
  bytes: Uint8Array,
  binaryType: BinaryType,
): unknown {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    const copy = bytes.slice().buffer;
    return binaryType === "arraybuffer" ? copy : new w.Blob([copy]);
  }
}

function replayWebSocket(ctx: ReplayContext): void {
  const { w, replay, orig } = ctx;
  const OrigWs = orig.WebSocket;
  if (OrigWs === undefined) return;
  const conns = new WeakMap<object, Conn>();
  const origSend = OrigWs.prototype.send;
  const origClose = OrigWs.prototype.close;
  const dispatch = w.EventTarget.prototype.dispatchEvent;

  const PatchedWs = function WebSocket(
    this: unknown,
    url: string | URL,
  ): WebSocket {
    if (new.target === undefined) {
      return (OrigWs as unknown as (...a: unknown[]) => WebSocket)(url);
    }
    const ws = newConnObject(w, new.target) as WebSocket;
    const reqId = ctx.nextReqId();
    const taskId = ctx.nextTaskId();
    const href = absoluteUrl(w, url instanceof URL ? url.href : url);
    const c: Conn = {
      url: href,
      readyState: 0,
      reqId,
      taskId,
      binaryType: "blob",
      handlers: new Map(),
      types: new Set(),
    };
    conns.set(ws, c);
    replay.next("NetRequest", {
      req_id: reqId,
      api: Api.webSocket,
      method: "GET",
      url: href,
      body_digest: "",
    });
    replay.registerTask(taskId, TaskKind.webSocket, 0);
    replay.onTask(taskId, () => {
      const v = replay.peek();
      const mine =
        (v.record?.record === "NetResponse" ||
          v.record?.record === "WsMessage") &&
        v.record.req_id === reqId;
      if (!mine) {
        // An error after the socket opened: a task with no record (§10.4).
        dispatch.call(ws, new w.Event("error"));
        return;
      }
      if (v.record!.record === "NetResponse") {
        const r = replay.next("NetResponse", { req_id: reqId });
        if (r.outcome === Outcome.response) {
          c.readyState = 1;
          dispatch.call(ws, new w.Event("open"));
        } else {
          dispatch.call(ws, new w.Event("error"));
        }
        return;
      }
      const m = replay.next("WsMessage", { req_id: reqId });
      const bytes = blobBytes(replay, m.data);
      if (m.dir === Dir.close) {
        const close = JSON.parse(new TextDecoder().decode(bytes)) as {
          code: number;
          reason: string;
          wasClean: boolean;
        };
        c.readyState = 3;
        replay.offTask(taskId);
        dispatch.call(ws, new w.CloseEvent("close", close));
      } else if (m.dir === Dir.in) {
        dispatch.call(
          ws,
          new w.MessageEvent("message", {
            data: messageData(w, bytes, c.binaryType),
            origin: new URL(href).origin,
          }),
        );
      } else {
        replay.fail(
          "ArgumentMismatch",
          `a socket task's message has dir ${m.dir}`,
        );
      }
    });
    return ws;
  };
  asConstructor(PatchedWs, OrigWs);
  replaceValue(w, "WebSocket", PatchedWs);

  replayAccessors(
    w,
    OrigWs.prototype,
    conns,
    {
      url: (c) => c.url,
      readyState: (c) => c.readyState,
      bufferedAmount: () => 0,
      extensions: () => "",
      protocol: () => "",
      binaryType: (c) => c.binaryType,
    },
    ["open", "message", "error", "close"],
  );
  replaceValue(
    OrigWs.prototype,
    "send",
    function send(
      this: WebSocket,
      data: string | ArrayBufferLike | Blob | ArrayBufferView,
    ): void {
      const c = conns.get(this);
      if (c === undefined) return origSend.call(this, data);
      const m = replay.next("WsMessage", { req_id: c.reqId, dir: Dir.out });
      const sent = messageBytes(data);
      const logged = blobBytes(replay, m.data);
      if (sent !== null && !sameBytes(sent, logged)) {
        replay.fail(
          "ArgumentMismatch",
          `the page sent ${sent.length} byte(s) on socket ${c.reqId}; the log has ${logged.length} different byte(s)`,
        );
      }
    },
  );
  replaceValue(
    OrigWs.prototype,
    "close",
    function close(this: WebSocket, ...args: unknown[]): void {
      const c = conns.get(this);
      if (c === undefined) {
        return (origClose as (...a: unknown[]) => void).apply(this, args);
      }
      if (c.readyState < 2) c.readyState = 2;
    },
  );
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function replayEventSource(ctx: ReplayContext): void {
  const { w, replay, orig } = ctx;
  const OrigEs = orig.EventSource;
  if (OrigEs === undefined) return;
  const conns = new WeakMap<object, Conn>();
  const dispatch = w.EventTarget.prototype.dispatchEvent;
  const origAdd = w.EventTarget.prototype.addEventListener;
  const origEsClose = OrigEs.prototype.close;

  const PatchedEs = function EventSource(
    this: unknown,
    url: string | URL,
  ): EventSource {
    if (new.target === undefined) {
      return (OrigEs as unknown as (...a: unknown[]) => EventSource)(url);
    }
    const es = newConnObject(w, new.target) as EventSource;
    const reqId = ctx.nextReqId();
    const taskId = ctx.nextTaskId();
    const href = absoluteUrl(w, url instanceof URL ? url.href : url);
    const c: Conn = {
      url: href,
      readyState: 0,
      reqId,
      taskId,
      binaryType: "blob",
      handlers: new Map(),
      types: new Set(),
    };
    conns.set(es, c);
    replay.next("NetRequest", {
      req_id: reqId,
      api: Api.eventSource,
      method: "GET",
      url: href,
      body_digest: "",
    });
    replay.registerTask(taskId, TaskKind.message, 0);
    replay.onTask(taskId, () => {
      const v = replay.peek();
      const mine =
        (v.record?.record === "NetResponse" ||
          v.record?.record === "WsMessage") &&
        v.record.req_id === reqId;
      if (!mine) {
        dispatch.call(es, new w.Event("error"));
        return;
      }
      if (v.record!.record === "NetResponse") {
        const r = replay.next("NetResponse", { req_id: reqId });
        c.readyState = r.outcome === Outcome.response ? 1 : 2;
        dispatch.call(
          es,
          new w.Event(r.outcome === Outcome.response ? "open" : "error"),
        );
        return;
      }
      const m = replay.next("WsMessage", { req_id: reqId, dir: Dir.in });
      // The log keeps a message's data but not its event type (§10.4), so
      // a page that listens for named events cannot be replayed exactly.
      const named = [...c.types].filter(
        (t) => t !== "open" && t !== "message" && t !== "error",
      );
      if (named.length > 0) {
        replay.fail(
          "NonReplayable",
          `the page listens for named event-stream events (${named.join(", ")}), whose type the log does not keep`,
        );
      }
      dispatch.call(
        es,
        new w.MessageEvent("message", {
          data: new TextDecoder().decode(blobBytes(replay, m.data)),
          origin: new URL(href).origin,
        }),
      );
    });
    return es;
  };
  asConstructor(PatchedEs, OrigEs);
  replaceValue(w, "EventSource", PatchedEs);

  replayAccessors(
    w,
    OrigEs.prototype,
    conns,
    {
      url: (c) => c.url,
      readyState: (c) => c.readyState,
      withCredentials: () => false,
    },
    ["open", "message", "error"],
  );
  replaceValue(
    OrigEs.prototype,
    "addEventListener",
    function addEventListener(
      this: EventSource,
      type: string,
      ...rest: unknown[]
    ): void {
      conns.get(this)?.types.add(String(type));
      return (origAdd as (...a: unknown[]) => void).call(this, type, ...rest);
    },
  );
  replaceValue(OrigEs.prototype, "close", function close(this: EventSource) {
    const c = conns.get(this);
    if (c === undefined) return origEsClose.call(this);
    c.readyState = 2;
    replay.offTask(c.taskId);
  });
}

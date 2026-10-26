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
import {
  PLATFORM_VALUE_SRC,
  RESPONSE_TYPE,
  WS_FRAME,
} from "@codetracer/boundary-format";

import { asConstructor, replaceAccessor, replaceValue } from "../context.js";
import { TaskKind } from "../recorder.js";
import {
  WS_EXTENSIONS_HEADER,
  WS_PROTOCOL_HEADER,
  absoluteUrl,
  bufferedAmountQuery,
  bodyDigest,
  frameOf,
  messageBytes,
  normaliseMethod,
} from "../seams-net.js";
import { holeBytes } from "../sensitive.js";
import { BODY_CONSUMERS, Dir, Outcome } from "../stream-body.js";
import { type ReplayContext, blobBytes } from "./context.js";
import { replayPlatformTask } from "./platform.js";

/** `NetRequest.api` (§5.2). */
const Api = { fetch: 1, xhr: 2, beacon: 3, webSocket: 4, eventSource: 5 };

/** Replace every seam this module owns (XMLHttpRequest: `xhr.ts`). */
export function replayNetSeams(ctx: ReplayContext): void {
  replayFetch(ctx);
  replayBeacon(ctx);
  replayWebSocket(ctx);
  replayEventSource(ctx);
}

/** `NetResponse.response_type` -> the `Response.type` it names (§5.2). */
const RESPONSE_TYPE_NAMES = new Map<number, string>(
  Object.entries(RESPONSE_TYPE)
    .filter(([, n]) => n !== RESPONSE_TYPE.none)
    .map(([name, n]) => [n, name]),
);

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
  // record). The log holds each of them (`NetResponse` `status_text`,
  // `url`, `redirected`, `response_type`; §5.2).
  const meta = new WeakMap<object, Record<string, unknown>>();
  // A replayed response's headers (and its clones') -> headers the platform
  // made immutable (a `Response.error()`'s, guard "immutable"; Fetch,
  // "Headers class"): the mutators run on those and throw exactly as they
  // do on a fetched response's headers.
  const frozen = new WeakMap<object, Headers>();
  const immutableHeaders = (): Headers => OrigResponse.error().headers;
  for (const [name, f] of orig.headersMutators) {
    const patched = function (this: unknown): unknown {
      const platform = frozen.get(this as object);
      return f.apply(platform ?? this, Array.from(arguments));
    };
    Object.defineProperty(patched, "name", { value: name });
    replaceValue(w.Headers.prototype, name, patched);
  }
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
  // Whether this platform's response bodies are byte streams.
  let byteBodies = false;
  try {
    new OrigResponse("").body!.getReader({ mode: "byob" }).releaseLock();
    byteBodies = true;
  } catch {
    byteBodies = false;
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
        if (m !== undefined) {
          meta.set(c, m);
          frozen.set(c.headers, immutableHeaders());
        }
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
      // A response no fetch of the page produced (or one with no body):
      // its read settles in a platform task of its own (§6, Task kind 13).
      if (q === undefined) return replayPlatformTask(ctx, settled);
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
    body: BodyInit | null,
    reads?: BodyRead[],
  ): Response => {
    const headers = JSON.parse(r.headers) as [string, string][];
    const status = r.status;
    const type = RESPONSE_TYPE_NAMES.get(r.response_type);
    if (type === undefined) {
      replay.fail(
        "ArgumentMismatch",
        `a fetch response's NetResponse.response_type is ${r.response_type}, which names no response type`,
      );
    }
    const m: Record<string, unknown> = {
      url: r.url,
      redirected: r.redirected === 1,
      type,
      statusText: r.status_text,
    };
    const init = (statusText: boolean): ResponseInit => ({
      status,
      headers,
      ...(statusText ? { statusText: r.status_text } : {}),
    });
    const content = NULL_BODY.has(status) ? null : body;
    let resp: Response;
    try {
      try {
        resp = new OrigResponse(content, init(true));
      } catch {
        // A reason phrase the constructor refuses: the accessor answers
        // it from the log anyway.
        resp = new OrigResponse(content, init(false));
      }
      if (reads !== undefined && body !== null) consuming.set(resp, reads);
    } catch {
      // A status the constructor refuses (an opaque response's 0).
      resp = new OrigResponse(null, { headers });
      Object.defineProperty(resp, "status", { value: status });
      Object.defineProperty(resp, "ok", { value: false });
    }
    meta.set(resp, m);
    frozen.set(resp.headers, immutableHeaders());
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
      if (init?.body !== undefined) digest = bodyDigest(init.body, ctx.holes);
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
        let controller: ReadableStreamController<Uint8Array> | undefined;
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
            // A copy: a byte stream transfers the chunk's buffer, which is
            // the decoded log's.
            controller!.enqueue(blobBytes(replay, m.data).slice());
          } else if (m.dir === Dir.end) {
            const outcome = endOutcome(ctx, m);
            finish();
            if (outcome === Outcome.response) {
              controller!.close();
              // A BYOB read waiting for the end is answered with it.
              (controller as ReadableByteStreamController).byobRequest?.respond(
                0,
              );
            } else {
              controller!.error(failureError(w, outcome, signal));
            }
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
            // A byte stream exactly when the platform's response bodies are
            // (Fetch: "with byte reading support"), so a BYOB reader works or
            // fails as it did on record (stream-body.ts).
            type: byteBodies ? "bytes" : undefined,
            start(c: ReadableStreamController<Uint8Array>) {
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
              resolve(responseOf(r, stream, reads));
            } else if (r.outcome === Outcome.response) {
              finish();
              resolve(responseOf(r, blobBytes(replay, r.body) as BodyInit));
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

function replayBeacon({
  w,
  replay,
  orig,
  nextReqId,
  holes,
}: ReplayContext): void {
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
        body_digest: bodyDigest(data, holes) ?? "",
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
  /** A socket's negotiated subprotocol and extensions (its open's headers). */
  protocol: string;
  extensions: string;
  /** An event stream's `withCredentials`, as the page asked for it. */
  withCredentials: boolean;
  handlers: Map<string, EventListener>;
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
 * The data of an inbound message as the logged frame says it came (§5.2
 * `WsMessage.frame`): a string for a text message, the bytes in the page's
 * `binaryType` for a binary one.
 */
function messageData(
  ctx: ReplayContext,
  m: RecordOf<"WsMessage">,
  bytes: Uint8Array,
  binaryType: BinaryType,
): unknown {
  if (m.frame === WS_FRAME.text) return new TextDecoder().decode(bytes);
  if (m.frame !== WS_FRAME.binary) {
    ctx.replay.fail(
      "ArgumentMismatch",
      `an inbound message's WsMessage.frame is ${m.frame}, neither text (1) nor binary (2)`,
    );
  }
  const copy = bytes.slice().buffer;
  return binaryType === "arraybuffer" ? copy : new ctx.w.Blob([copy]);
}

/** The value of header `name` in a logged `NetResponse.headers`, or "". */
function headerOf(r: RecordOf<"NetResponse">, name: string): string {
  const pair = (JSON.parse(r.headers) as [string, string][]).find(
    ([n]) => n.toLowerCase() === name,
  );
  return pair === undefined ? "" : pair[1];
}

function replayWebSocket(ctx: ReplayContext): void {
  const { w, replay, orig } = ctx;
  const OrigWs = orig.WebSocket;
  if (OrigWs === undefined) return;
  const conns = new WeakMap<object, Conn>();
  const origSend = OrigWs.prototype.send;
  const origClose = OrigWs.prototype.close;
  const dispatch = (t: EventTarget, ev: Event) => ctx.trusted.dispatch(t, ev);

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
      protocol: "",
      extensions: "",
      withCredentials: false,
      handlers: new Map(),
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
        dispatch(ws, new w.Event("error"));
        return;
      }
      if (v.record!.record === "NetResponse") {
        const r = replay.next("NetResponse", { req_id: reqId });
        if (r.outcome === Outcome.response) {
          c.readyState = 1;
          c.protocol = headerOf(r, WS_PROTOCOL_HEADER);
          c.extensions = headerOf(r, WS_EXTENSIONS_HEADER);
          dispatch(ws, new w.Event("open"));
        } else {
          dispatch(ws, new w.Event("error"));
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
        dispatch(ws, new w.CloseEvent("close", close));
      } else if (m.dir === Dir.in) {
        dispatch(
          ws,
          new w.MessageEvent("message", {
            data: messageData(ctx, m, bytes, c.binaryType),
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
      // Answered from the log: how fast the visitor's network took the
      // bytes (§10.4).
      bufferedAmount: (c) =>
        Number(
          JSON.parse(
            replay.next("PlatformValue", {
              src: PLATFORM_VALUE_SRC.platformState,
              task_id: 0n,
              query: bufferedAmountQuery(c.reqId),
            }).value,
          ),
        ),
      extensions: (c) => c.extensions,
      protocol: (c) => c.protocol,
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
      const m = replay.next("WsMessage", {
        req_id: c.reqId,
        dir: Dir.out,
        frame: frameOf(data),
      });
      const raw = messageBytes(data);
      // Compared in holed form, as it was logged (§5.2.1).
      const sent = raw === null ? null : holeBytes(raw, ctx.holes());
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
  const dispatch = (t: EventTarget, ev: Event) => ctx.trusted.dispatch(t, ev);
  const origEsClose = OrigEs.prototype.close;

  const PatchedEs = function EventSource(
    this: unknown,
    url: string | URL,
    init?: EventSourceInit,
  ): EventSource {
    if (new.target === undefined) {
      return (OrigEs as unknown as (...a: unknown[]) => EventSource)(url, init);
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
      protocol: "",
      extensions: "",
      withCredentials: init?.withCredentials === true,
      handlers: new Map(),
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
        dispatch(es, new w.Event("error"));
        return;
      }
      if (v.record!.record === "NetResponse") {
        const r = replay.next("NetResponse", { req_id: reqId });
        c.readyState = r.outcome === Outcome.response ? 1 : 2;
        dispatch(
          es,
          new w.Event(r.outcome === Outcome.response ? "open" : "error"),
        );
        return;
      }
      const m = replay.next("WsMessage", { req_id: reqId, dir: Dir.in });
      // The event's type is the stream's `event:` field (`message` when it
      // has none) and its `lastEventId` the last `id:` (HTML, "Server-sent
      // events"), both logged (§5.2).
      dispatch(
        es,
        new w.MessageEvent(m.event === "" ? "message" : m.event, {
          data: messageData(ctx, m, blobBytes(replay, m.data), "blob"),
          origin: new URL(href).origin,
          lastEventId: m.last_event_id,
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
      withCredentials: (c) => c.withCredentials,
    },
    ["open", "message", "error"],
  );
  replaceValue(OrigEs.prototype, "close", function close(this: EventSource) {
    const c = conns.get(this);
    if (c === undefined) return origEsClose.call(this);
    c.readyState = 2;
    replay.offTask(c.taskId);
  });
}

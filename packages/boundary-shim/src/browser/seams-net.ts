/**
 * Network seams (JS-Boundary-Recording.md §5.2 `NetRequest`, `NetResponse`,
 * `WsMessage`; §10.1): `fetch`, `XMLHttpRequest`, `navigator.sendBeacon`,
 * `WebSocket` and `EventSource`.
 *
 * A request writes `NetRequest` and a `TaskReg{kind: network completion}`
 * (or `WebSocket` / `message` for the streaming APIs) when the page makes
 * it; its completion writes the `Task` and then `NetResponse` before any of
 * the page's code that consumes it runs. Bodies are inlined whatever their
 * size, as an uploaded batch carries them (§5.2); the assembler moves those
 * over 1024 bytes into `jsbound.blb`.
 *
 * What cannot be captured synchronously and exactly (a `Blob` or stream
 * request body, a `blob`/`document` XHR response, a binary WebSocket
 * message delivered as a `Blob`) is refused with a named `Refusal`
 * (what cannot be replayed is recorded as such, never dropped silently), and
 * the session is non-replayable from there.
 */

import {
  type SeamContext,
  asConstructor,
  copyBytes,
  inline,
  replaceValue,
  utf8Bytes,
} from "./context.js";
import { TaskKind } from "./recorder.js";
import { sha256Hex } from "./sha256.js";

/** `NetRequest.api` (§5.2). */
const Api = { fetch: 1, xhr: 2, beacon: 3, webSocket: 4, eventSource: 5 };
/** `NetResponse.outcome` (§5.2). */
const Outcome = { response: 1, networkError: 2, abort: 3, timeout: 4 };
/** `WsMessage.dir` (§5.2). */
const Dir = { in: 1, out: 2, close: 3 };

/** Refusal feature names of this module (§7.5, §10.1). */
export const UNRECORDABLE_REQUEST_BODY = "unrecordable-request-body";
export const UNRECORDABLE_RESPONSE_BODY = "unrecordable-response-body";
export const UNRECORDABLE_MESSAGE = "unrecordable-message";

const EMPTY = new Uint8Array(0);
const STANDARD_METHODS = ["DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT"];

/** Patch every seam this module owns. */
export function patchNetSeams(ctx: SeamContext): void {
  patchFetch(ctx);
  patchXhr(ctx);
  patchBeacon(ctx);
  patchWebSocket(ctx);
  patchEventSource(ctx);
}

/** A method normalised as the Fetch standard normalises it. */
function normaliseMethod(m: unknown): string {
  const s = m === undefined || m === null ? "GET" : String(m);
  const upper = s.toUpperCase();
  return STANDARD_METHODS.includes(upper) ? upper : s;
}

/** `url` resolved against the document, as the request will be made. */
function absoluteUrl(w: SeamContext["w"], url: unknown): string {
  try {
    return new URL(String(url), w.document.baseURI).href;
  } catch {
    return String(url);
  }
}

/**
 * `body_digest` of a request body: lowercase hex SHA-256 of its bytes, or
 * `""` when there is none. Returns `null` for a body whose bytes cannot be
 * read synchronously.
 */
function bodyDigest(body: unknown): string | null {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return sha256Hex(body);
  if (body instanceof URLSearchParams) return sha256Hex(body.toString());
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    return sha256Hex(copyBytes(body as ArrayBuffer | ArrayBufferView));
  }
  return null;
}

function typeName(v: unknown): string {
  const ctor = (v as { constructor?: { name?: string } })?.constructor?.name;
  return typeof ctor === "string" ? ctor : typeof v;
}

function headersJson(pairs: [string, string][]): string {
  return JSON.stringify(pairs);
}

function patchFetch(ctx: SeamContext): void {
  const { w, rec, orig } = ctx;
  const origFetch = orig.fetch;
  if (origFetch === undefined) return;

  replaceValue(
    w,
    "fetch",
    function fetch(input: RequestInfo | URL, init?: RequestInit) {
      if (!rec.recording) return origFetch.call(w, input, init);
      const ids = rec.guard(() => {
        const isRequest = input instanceof w.Request;
        const method = normaliseMethod(
          init?.method ?? (isRequest ? (input as Request).method : "GET"),
        );
        const url = isRequest
          ? (input as Request).url
          : absoluteUrl(w, input instanceof URL ? input.href : input);
        let digest: string | null;
        if (init?.body !== undefined) {
          digest = bodyDigest(init.body);
        } else if (isRequest && (input as Request).body !== null) {
          digest = null; // a Request's own body is a stream
        } else {
          digest = "";
        }
        if (digest === null) {
          ctx.refuseOnce(
            UNRECORDABLE_REQUEST_BODY,
            `fetch body ${typeName(init?.body ?? input)}`,
          );
          digest = "";
        }
        const reqId = rec.nextReqId();
        const taskId = rec.nextTaskId();
        rec.emit("NetRequest", {
          req_id: reqId,
          api: Api.fetch,
          method,
          url,
          body_digest: digest,
        });
        rec.emit("TaskReg", {
          task_id: taskId,
          kind: TaskKind.networkCompletion,
          delay_ms: 0,
        });
        return { reqId, taskId };
      });
      const p = origFetch.call(w, input, init);
      if (ids === undefined) return p;
      const complete = (
        outcome: number,
        status: number,
        headers: string,
        body: Uint8Array,
      ) =>
        rec.guard(() => {
          rec.task(ids.taskId, TaskKind.networkCompletion);
          rec.emit("NetResponse", {
            req_id: ids.reqId,
            outcome,
            status,
            headers,
            body: inline(body),
          });
        });
      return p.then(
        (resp: Response) => {
          // The page's promise settles only once the body is logged, so the
          // NetResponse precedes every read the page makes of the response.
          let headers = "[]";
          let copy: Response | undefined;
          rec.guard(() => {
            headers = headersJson(Array.from(resp.headers));
            copy = resp.clone();
          });
          if (copy === undefined) return resp;
          return copy.arrayBuffer().then(
            (buf) => {
              complete(
                Outcome.response,
                resp.status,
                headers,
                new Uint8Array(buf),
              );
              return resp;
            },
            (err: unknown) => {
              complete(
                isAbort(err) ? Outcome.abort : Outcome.networkError,
                resp.status,
                headers,
                EMPTY,
              );
              return resp;
            },
          );
        },
        (err: unknown) => {
          complete(
            isAbort(err) ? Outcome.abort : Outcome.networkError,
            0,
            "[]",
            EMPTY,
          );
          throw err;
        },
      );
    },
  );
}

function isAbort(err: unknown): boolean {
  return (err as { name?: unknown })?.name === "AbortError";
}

interface XhrState {
  method: string;
  url: string;
  reqId?: bigint;
  taskId?: bigint;
  aborted: boolean;
  done: boolean;
}

function patchXhr(ctx: SeamContext): void {
  const { w, rec, orig } = ctx;
  const OrigXhr = orig.XMLHttpRequest;
  if (OrigXhr === undefined) return;
  const proto = OrigXhr.prototype;
  const origOpen = proto.open;
  const origSend = proto.send;
  const origAbort = proto.abort;
  const states = new WeakMap<XMLHttpRequest, XhrState>();

  const onReadyStateChange = function (this: XMLHttpRequest): void {
    const s = states.get(this);
    if (s === undefined || s.reqId === undefined || s.done) return;
    if (this.readyState !== 4) return;
    s.done = true;
    rec.guard(() => {
      const headers: [string, string][] = [];
      for (const line of this.getAllResponseHeaders().split("\r\n")) {
        const at = line.indexOf(": ");
        if (at > 0) headers.push([line.slice(0, at), line.slice(at + 2)]);
      }
      const outcome = s.aborted
        ? Outcome.abort
        : this.status === 0
          ? Outcome.networkError
          : Outcome.response;
      let body: Uint8Array = EMPTY;
      const type = this.responseType;
      if (outcome === Outcome.response) {
        if (type === "" || type === "text") {
          body = utf8Bytes(this.responseText);
        } else if (type === "arraybuffer") {
          body = this.response === null ? EMPTY : copyBytes(this.response);
        } else if (type === "json") {
          // The raw text is not exposed for a JSON response; its
          // re-serialisation parses back to the same value on replay.
          body = utf8Bytes(JSON.stringify(this.response));
        } else {
          ctx.refuseOnce(
            UNRECORDABLE_RESPONSE_BODY,
            `XHR responseType ${type}`,
          );
        }
      }
      rec.task(s.taskId!, TaskKind.networkCompletion);
      rec.emit("NetResponse", {
        req_id: s.reqId!,
        outcome,
        status: this.status,
        headers: headersJson(headers),
        body: inline(body),
      });
    });
  };

  // The constructor registers the shim's listener first, so its Task and
  // NetResponse precede every listener the page adds, whenever it adds it.
  const PatchedXhr = function XMLHttpRequest(this: unknown): XMLHttpRequest {
    if (new.target === undefined) {
      // Calling the constructor without `new` throws; keep that.
      return (OrigXhr as unknown as () => XMLHttpRequest)();
    }
    // Constructed for `new.target`, so a page subclass keeps its prototype.
    const x = Reflect.construct(OrigXhr, [], new.target) as XMLHttpRequest;
    rec.guard(() => {
      states.set(x, { method: "GET", url: "", aborted: false, done: false });
      orig.addEventListener.call(x, "readystatechange", onReadyStateChange);
    });
    return x;
  };
  asConstructor(PatchedXhr, OrigXhr);
  replaceValue(w, "XMLHttpRequest", PatchedXhr);

  replaceValue(
    proto,
    "open",
    function open(
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ): void {
      (origOpen as (...a: unknown[]) => void).call(this, method, url, ...rest);
      const s = states.get(this);
      if (s !== undefined) {
        rec.guard(() => {
          s.method = normaliseMethod(method);
          s.url = absoluteUrl(w, url instanceof URL ? url.href : url);
          s.reqId = undefined;
          s.aborted = false;
          s.done = false;
        });
      }
    },
  );

  replaceValue(
    proto,
    "send",
    function send(
      this: XMLHttpRequest,
      body?: Document | XMLHttpRequestBodyInit | null,
    ): void {
      const s = states.get(this);
      if (s !== undefined && rec.recording) {
        rec.guard(() => {
          let digest = bodyDigest(body);
          if (digest === null) {
            ctx.refuseOnce(
              UNRECORDABLE_REQUEST_BODY,
              `XHR body ${typeName(body)}`,
            );
            digest = "";
          }
          s.reqId = rec.nextReqId();
          s.taskId = rec.nextTaskId();
          rec.emit("NetRequest", {
            req_id: s.reqId,
            api: Api.xhr,
            method: s.method,
            url: s.url,
            body_digest: digest,
          });
          rec.emit("TaskReg", {
            task_id: s.taskId,
            kind: TaskKind.networkCompletion,
            delay_ms: 0,
          });
        });
      }
      return origSend.call(this, body);
    },
  );

  replaceValue(proto, "abort", function abort(this: XMLHttpRequest): void {
    const s = states.get(this);
    if (s !== undefined) s.aborted = true;
    return origAbort.call(this);
  });
}

function patchBeacon(ctx: SeamContext): void {
  const { w, rec, orig } = ctx;
  const origBeacon = orig.sendBeacon;
  if (origBeacon === undefined) return;
  replaceValue(
    w.Navigator.prototype,
    "sendBeacon",
    function sendBeacon(
      this: Navigator,
      url: string | URL,
      data?: BodyInit | null,
    ): boolean {
      if (!rec.recording) return origBeacon.call(this, url, data);
      const reqId = rec.guard(() => {
        let digest = bodyDigest(data);
        if (digest === null) {
          ctx.refuseOnce(
            UNRECORDABLE_REQUEST_BODY,
            `beacon body ${typeName(data)}`,
          );
          digest = "";
        }
        const id = rec.nextReqId();
        rec.emit("NetRequest", {
          req_id: id,
          api: Api.beacon,
          method: "POST",
          url: absoluteUrl(w, url instanceof URL ? url.href : url),
          body_digest: digest,
        });
        return id;
      });
      const queued = origBeacon.call(this, url, data);
      // A beacon has no response; its boolean result is the read, returned
      // synchronously, so it is logged at once as outcome 1 (queued) or 2.
      if (reqId !== undefined) {
        rec.guard(() =>
          rec.emit("NetResponse", {
            req_id: reqId,
            outcome: queued ? Outcome.response : Outcome.networkError,
            status: 0,
            headers: "[]",
            body: inline(EMPTY),
          }),
        );
      }
      return queued;
    },
  );
}

/** The bytes of a message's data, or `null` when they cannot be read now. */
function messageBytes(data: unknown): Uint8Array | null {
  if (typeof data === "string") return utf8Bytes(data);
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    return copyBytes(data as ArrayBuffer | ArrayBufferView);
  }
  return null;
}

/**
 * Register the shim's listeners on a streaming connection, first, so its
 * records precede the page's handlers. `open` logs the connection's
 * response (`NetResponse` with `openStatus`), an `error` before `open` a
 * network-error response, `close` a `WsMessage{dir: close}` carrying the
 * close code, reason and cleanliness as JSON, and every other event type a
 * `WsMessage{dir: in}` with its data.
 */
function listenStream(
  ctx: SeamContext,
  target: EventTarget,
  reqId: bigint,
  taskId: bigint,
  taskKind: number,
  types: readonly string[],
  openStatus: number,
): void {
  const { rec, orig } = ctx;
  let opened = false;
  const handler = (ev: Event) => {
    rec.guard(() => {
      if (!rec.recording) return;
      rec.task(taskId, taskKind);
      if (ev.type === "open") {
        opened = true;
        rec.emit("NetResponse", {
          req_id: reqId,
          outcome: Outcome.response,
          status: openStatus,
          headers: "[]",
          body: inline(EMPTY),
        });
      } else if (ev.type === "error") {
        if (!opened) {
          rec.emit("NetResponse", {
            req_id: reqId,
            outcome: Outcome.networkError,
            status: 0,
            headers: "[]",
            body: inline(EMPTY),
          });
        }
      } else if (ev.type === "close") {
        const c = ev as CloseEvent;
        rec.emit("WsMessage", {
          req_id: reqId,
          dir: Dir.close,
          data: inline(
            utf8Bytes(
              JSON.stringify({
                code: c.code,
                reason: c.reason,
                wasClean: c.wasClean,
              }),
            ),
          ),
        });
      } else {
        let bytes = messageBytes((ev as MessageEvent).data);
        if (bytes === null) {
          ctx.refuseOnce(
            UNRECORDABLE_MESSAGE,
            `${ev.type} data ${typeName((ev as MessageEvent).data)}`,
          );
          bytes = EMPTY;
        }
        rec.emit("WsMessage", {
          req_id: reqId,
          dir: Dir.in,
          data: inline(bytes),
        });
      }
    });
  };
  for (const t of types) orig.addEventListener.call(target, t, handler);
}

function patchWebSocket(ctx: SeamContext): void {
  const { w, rec, orig } = ctx;
  const OrigWs = orig.WebSocket;
  if (OrigWs === undefined) return;
  const tracked = new WeakMap<WebSocket, bigint>();
  const origSend = OrigWs.prototype.send;

  const PatchedWs = function WebSocket(
    this: unknown,
    url: string | URL,
    protocols?: string | string[],
  ): WebSocket {
    if (new.target === undefined) {
      return (OrigWs as unknown as (...a: unknown[]) => WebSocket)(
        url,
        protocols,
      );
    }
    const ws =
      protocols === undefined
        ? (Reflect.construct(OrigWs, [url], new.target) as WebSocket)
        : (Reflect.construct(
            OrigWs,
            [url, protocols],
            new.target,
          ) as WebSocket);
    if (rec.recording) {
      rec.guard(() => {
        const reqId = rec.nextReqId();
        const taskId = rec.nextTaskId();
        rec.emit("NetRequest", {
          req_id: reqId,
          api: Api.webSocket,
          method: "GET",
          url: ws.url,
          body_digest: "",
        });
        rec.emit("TaskReg", {
          task_id: taskId,
          kind: TaskKind.webSocket,
          delay_ms: 0,
        });
        tracked.set(ws, reqId);
        listenStream(
          ctx,
          ws,
          reqId,
          taskId,
          TaskKind.webSocket,
          ["open", "message", "error", "close"],
          101,
        );
      });
    }
    return ws;
  };
  asConstructor(PatchedWs, OrigWs);
  replaceValue(w, "WebSocket", PatchedWs);

  // Outbound messages, for sockets the page opened through the patched
  // constructor only: a socket made from the captured original (the `__ct`
  // runtime's) is not part of the page's boundary.
  replaceValue(
    OrigWs.prototype,
    "send",
    function send(
      this: WebSocket,
      data: string | ArrayBufferLike | Blob | ArrayBufferView,
    ): void {
      const reqId = tracked.get(this);
      if (reqId !== undefined && rec.recording) {
        rec.guard(() => {
          let bytes = messageBytes(data);
          if (bytes === null) {
            ctx.refuseOnce(
              UNRECORDABLE_MESSAGE,
              `WebSocket send ${typeName(data)}`,
            );
            bytes = EMPTY;
          }
          rec.emit("WsMessage", {
            req_id: reqId,
            dir: Dir.out,
            data: inline(bytes),
          });
        });
      }
      return origSend.call(this, data);
    },
  );
}

function patchEventSource(ctx: SeamContext): void {
  const { w, rec, orig } = ctx;
  const OrigEs = orig.EventSource;
  if (OrigEs === undefined) return;
  // Named events (`event: <name>` in the stream) reach only listeners for
  // that name, so the shim listens for each name the page listens for, and
  // registers its own listener just before the page's.
  const listening = new WeakMap<
    EventSource,
    { types: Set<string>; add: (t: string) => void }
  >();

  const PatchedEs = function EventSource(
    this: unknown,
    url: string | URL,
    init?: EventSourceInit,
  ): EventSource {
    if (new.target === undefined) {
      return (OrigEs as unknown as (...a: unknown[]) => EventSource)(url, init);
    }
    const es = Reflect.construct(
      OrigEs,
      [url, init],
      new.target,
    ) as EventSource;
    if (rec.recording) {
      rec.guard(() => {
        const reqId = rec.nextReqId();
        const taskId = rec.nextTaskId();
        rec.emit("NetRequest", {
          req_id: reqId,
          api: Api.eventSource,
          method: "GET",
          url: es.url,
          body_digest: "",
        });
        rec.emit("TaskReg", {
          task_id: taskId,
          kind: TaskKind.message,
          delay_ms: 0,
        });
        const types = new Set(["open", "message", "error"]);
        listenStream(ctx, es, reqId, taskId, TaskKind.message, [...types], 200);
        listening.set(es, {
          types,
          add: (t) => {
            types.add(t);
            listenStream(ctx, es, reqId, taskId, TaskKind.message, [t], 200);
          },
        });
      });
    }
    return es;
  };
  asConstructor(PatchedEs, OrigEs);
  replaceValue(w, "EventSource", PatchedEs);

  const origAdd = OrigEs.prototype.addEventListener;
  replaceValue(
    OrigEs.prototype,
    "addEventListener",
    function addEventListener(
      this: EventSource,
      type: string,
      ...rest: unknown[]
    ): void {
      const l = listening.get(this);
      if (l !== undefined && !l.types.has(String(type))) {
        rec.guard(() => l.add(String(type)));
      }
      return (origAdd as (...a: unknown[]) => void).call(this, type, ...rest);
    },
  );
}

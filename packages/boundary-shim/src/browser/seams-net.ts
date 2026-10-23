/**
 * Network seams (JS-Boundary-Recording.md §5.2 `NetRequest`, `NetResponse`,
 * `WsMessage`; §10.1): `fetch`, `XMLHttpRequest`, `navigator.sendBeacon`,
 * `WebSocket` and `EventSource`.
 *
 * A request writes `NetRequest` and a `TaskReg{kind: network completion}`
 * (or `WebSocket` / `message` for the streaming APIs) when the page makes
 * it. What comes back is recorded as the page can observe it, each part
 * before any of the page's code that consumes it runs: a `fetch` or XHR
 * response's head (`NetResponse{outcome 5}`) when it arrives, then its body
 * piece by piece as it reaches the page (`WsMessage{dir 1}`, ended by
 * `WsMessage{dir 4}`; stream-body.ts for `fetch`), and a socket's or event
 * stream's messages one by one. Bodies are inlined whatever their size, as
 * an uploaded batch carries them (§5.2); the assembler moves those over 1024
 * bytes into `jsbound.blb`.
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
  replaceAccessor,
  replaceValue,
  utf8Bytes,
} from "./context.js";
import { XHR_EVENT } from "@codetracer/boundary-format";

import { TaskKind } from "./recorder.js";
import { sha256Hex } from "./sha256.js";
import {
  Dir,
  Outcome,
  emitBodyEnd,
  failureOutcome,
  patchResponses,
} from "./stream-body.js";

/** `NetRequest.api` (§5.2). */
const Api = { fetch: 1, xhr: 2, beacon: 3, webSocket: 4, eventSource: 5 };

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
export function normaliseMethod(m: unknown): string {
  const s = m === undefined || m === null ? "GET" : String(m);
  const upper = s.toUpperCase();
  return STANDARD_METHODS.includes(upper) ? upper : s;
}

/** `url` resolved against the document, as the request will be made. */
export function absoluteUrl(w: SeamContext["w"], url: unknown): string {
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
export function bodyDigest(body: unknown): string | null {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return sha256Hex(body);
  if (body instanceof URLSearchParams) return sha256Hex(body.toString());
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    return sha256Hex(copyBytes(body as ArrayBuffer | ArrayBufferView));
  }
  return null;
}

export function typeName(v: unknown): string {
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
  const responses = patchResponses(ctx);

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
      return p.then(
        (resp: Response) => {
          // The head has arrived: the network task that resolves the
          // platform's promise. The page gets its response now; its body is
          // recorded piece by piece as the page reads it (stream-body.ts).
          let page = resp;
          rec.guard(() => {
            const headers = headersJson(Array.from(resp.headers));
            rec.task(ids.taskId, TaskKind.networkCompletion);
            let outcome = Outcome.response;
            if (resp.body !== null) {
              const rebuilt = responses?.rebuild(resp, ids.reqId, ids.taskId);
              if (rebuilt === undefined) {
                // The page reads the platform's body directly, unseen.
                ctx.refuseOnce(
                  UNRECORDABLE_RESPONSE_BODY,
                  `fetch response ${resp.type} ${resp.status}`,
                );
              } else {
                page = rebuilt;
                outcome = Outcome.head;
              }
            }
            rec.emit("NetResponse", {
              req_id: ids.reqId,
              outcome,
              status: resp.status,
              headers,
              body: inline(EMPTY),
            });
          });
          return page;
        },
        (err: unknown) => {
          rec.guard(() => {
            const outcome = failureOutcome(err);
            // An abort is the page's own call, made inside one of its tasks.
            if (outcome !== Outcome.abort) {
              rec.task(ids.taskId, TaskKind.networkCompletion);
            }
            rec.emit("NetResponse", {
              req_id: ids.reqId,
              outcome,
              status: 0,
              headers: "[]",
              body: inline(EMPTY),
            });
          });
          throw err;
        },
      );
    },
  );
}

/** `XMLHttpRequest.readyState` values (XHR standard). */
const ReadyState = { opened: 1, headersReceived: 2, loading: 3, done: 4 };

/**
 * The `XhrEvent.event` of each `ProgressEvent` type an XMLHttpRequest and
 * its upload object dispatch (§5.2; XHR standard, "Events summary",
 * https://xhr.spec.whatwg.org/#events), by type name.
 */
const XHR_EVENT_TYPES: Readonly<Record<string, number>> = XHR_EVENT.event;
/** The `ProgressEvent` types the shim listens for at the request itself. */
const REQUEST_EVENTS = ["loadstart", "abort", "load", "loadend"];

interface XhrState {
  method: string;
  url: string;
  /** `open(…, async = false)`: the platform runs it inside `send()`. */
  sync: boolean;
  reqId?: bigint;
  taskId?: bigint;
  /** The platform's send() flag, as far as the shim can tell. */
  sent: boolean;
  /** `abort()` was called: the events it fires run inside that call. */
  aborted: boolean;
  /** Inside the page's `send()` call (upload `loadstart` runs there). */
  sending: boolean;
  /** The head (`NetResponse{outcome 5}`) has been written. */
  head: boolean;
  /** UTF-16 length of the `responseText` already recorded. */
  seen: number;
  done: boolean;
  /**
   * DONE came with a status of 0 and no abort: the request failed, and the
   * event that follows (`error` or `timeout`) says how.
   */
  failing: boolean;
}

/**
 * XMLHttpRequest (§5.2, §10.1, §10.4). A request is logged when `send()`
 * will really send it. Its response is recorded as the page can observe it:
 * at HEADERS_RECEIVED the head (`NetResponse{outcome 5}`), at each LOADING
 * the bytes `responseText` grew by (`WsMessage{dir 1}`; empty for a
 * non-text `responseType`, whose body the page cannot see before DONE), at
 * DONE what is left and the end (`WsMessage{dir 4}`). A request that
 * completes without a head (a synchronous request, a failure before the
 * headers) is one `NetResponse` with its whole body, as before.
 *
 * How a request failed (outcome 2, network error, or 4, timeout) is not
 * observable at DONE, where the page sees only a status of 0; the platform
 * tells it by the event it fires next in the same task, `error` or
 * `timeout` (XHR standard, "request error steps"). The shim's listener for
 * those runs before the page's, so the failure is written there, before the
 * page can tell which it was; the `Task` is written at DONE.
 *
 * Each of these is a network task with a `Task`, except what the platform
 * dispatches inside a page call: a synchronous `send()`, and `abort()`.
 *
 * Every `ProgressEvent` the platform dispatches at the request, or at its
 * upload object once the shim listens there, is an `XhrEvent`: which
 * object, which type, and the `loaded`, `total` and `lengthComputable` the
 * page's listeners read, which depend on how the network delivered the
 * bytes. It is the last record the shim writes for the event, after those
 * that bring the response up to what the listeners can read, so replay
 * dispatches it with that state. A `Task` of the request followed by no
 * `XhrEvent` before the next `Task` is a `readystatechange`. Only trusted
 * events are recorded: one the page dispatches itself happens again on
 * replay.
 */
function patchXhr(ctx: SeamContext): void {
  const { w, rec, orig } = ctx;
  const OrigXhr = orig.XMLHttpRequest;
  if (OrigXhr === undefined) return;
  const proto = OrigXhr.prototype;
  const origOpen = proto.open;
  const origSend = proto.send;
  const origAbort = proto.abort;
  const states = new WeakMap<XMLHttpRequest, XhrState>();
  // Each request's upload object -> the request.
  const uploads = new WeakMap<XMLHttpRequestUpload, XMLHttpRequest>();

  const responseHeaders = (x: XMLHttpRequest): string => {
    const headers: [string, string][] = [];
    for (const line of x.getAllResponseHeaders().split("\r\n")) {
      const at = line.indexOf(": ");
      if (at > 0) headers.push([line.slice(0, at), line.slice(at + 2)]);
    }
    return headersJson(headers);
  };
  const isText = (x: XMLHttpRequest) =>
    x.responseType === "" || x.responseType === "text";
  /** What `responseText` grew by since it was last recorded. */
  const textDelta = (x: XMLHttpRequest, s: XhrState): Uint8Array => {
    const t = x.responseText;
    const d = t.slice(s.seen);
    s.seen = t.length;
    return utf8Bytes(d);
  };
  /** The whole body of a non-text response at DONE, or `null` (refused). */
  const wholeBody = (x: XMLHttpRequest): Uint8Array | null => {
    const type = x.responseType;
    if (type === "arraybuffer") {
      return x.response === null ? EMPTY : copyBytes(x.response);
    }
    if (type === "json") {
      // The raw text is not exposed for a JSON response; its
      // re-serialisation parses back to the same value on replay.
      return utf8Bytes(JSON.stringify(x.response));
    }
    ctx.refuseOnce(UNRECORDABLE_RESPONSE_BODY, `XHR responseType ${type}`);
    return null;
  };
  /** Write how request `s` failed: its whole response, or its body's end. */
  const failure = (s: XhrState, outcome: number) => {
    s.failing = false;
    if (s.head) {
      emitBodyEnd(rec, s.reqId!, outcome);
    } else {
      rec.emit("NetResponse", {
        req_id: s.reqId!,
        outcome,
        status: 0,
        headers: "[]",
        body: inline(EMPTY),
      });
    }
  };
  const head = (x: XMLHttpRequest, s: XhrState) => {
    s.head = true;
    rec.emit("NetResponse", {
      req_id: s.reqId!,
      outcome: Outcome.head,
      status: x.status,
      headers: responseHeaders(x),
      body: inline(EMPTY),
    });
  };
  const piece = (s: XhrState, bytes: Uint8Array) =>
    rec.emit("WsMessage", {
      req_id: s.reqId!,
      dir: Dir.in,
      data: inline(bytes),
    });

  /**
   * The `XhrEvent` of `ProgressEvent` `ev`, dispatched at request `s`
   * (`target` 1) or its upload object (2), with the values its listeners
   * read. A trusted `ProgressEvent`'s `loaded` and `total` are non-negative
   * integers (XHR standard, "fire a progress event"); anything else throws
   * here and is a recorder fault, never a wrong value.
   */
  const xhrEvent = (s: XhrState, ev: Event, target: number) => {
    const event = XHR_EVENT_TYPES[ev.type];
    if (event === undefined) return;
    const p = ev as ProgressEvent;
    rec.emit("XhrEvent", {
      req_id: s.reqId!,
      target,
      event,
      loaded: BigInt(p.loaded),
      total: BigInt(p.total),
      length_computable: p.lengthComputable ? 1 : 0,
    });
  };

  /** The `Task` of a network task of request `s`; none in a page call. */
  const task = (s: XhrState) => {
    if (!s.sync && !s.aborted) {
      rec.task(s.taskId!, TaskKind.networkCompletion);
    }
  };

  /** Request `s` reached DONE: its `Task`, and how it completed. */
  const finish = (x: XMLHttpRequest, s: XhrState) => {
    s.done = true;
    task(s);
    if (s.aborted) {
      failure(s, Outcome.abort);
      return;
    }
    if (x.status === 0) {
      s.failing = true; // written by onFailureEvent or onUploadEvent
      return;
    }
    const outcome = Outcome.response;
    if (!s.head) {
      const body = isText(x)
        ? utf8Bytes(x.responseText)
        : (wholeBody(x) ?? EMPTY);
      rec.emit("NetResponse", {
        req_id: s.reqId!,
        outcome,
        status: x.status,
        headers: responseHeaders(x),
        body: inline(body),
      });
      return;
    }
    const rest = isText(x) ? textDelta(x, s) : wholeBody(x);
    if (rest !== null && rest.length > 0) piece(s, rest);
    emitBodyEnd(rec, s.reqId!, outcome);
  };

  /** The state of request `x` while it is sent and not yet DONE. */
  const inFlight = (x: XMLHttpRequest): XhrState | undefined => {
    const s = states.get(x);
    return s === undefined || s.reqId === undefined || s.done ? undefined : s;
  };

  const onReadyStateChange = function (this: XMLHttpRequest, ev: Event): void {
    if (!ev.isTrusted) return;
    const s = inFlight(this);
    if (s === undefined) return;
    const state = this.readyState;
    if (state < ReadyState.headersReceived) return;
    rec.guard(() => {
      if (state === ReadyState.headersReceived) {
        task(s);
        head(this, s);
        return;
      }
      if (state === ReadyState.loading) {
        task(s);
        if (!s.head) head(this, s);
        piece(s, isText(this) ? textDelta(this, s) : EMPTY);
        return;
      }
      finish(this, s);
    });
  };

  /**
   * A `progress` event at the request. The platform rate-limits these to
   * one per 50 ms and dispatches a deferred one from a timer task of its
   * own, and Chromium dispatches the last one at DONE before DONE's
   * `readystatechange`, when the page can already read the whole body. So
   * each is a `Task` of its own, with what `responseText` grew by since it
   * was last recorded, and the one at DONE is where the request completes.
   * Its `XhrEvent` follows.
   */
  const onProgress = function (this: XMLHttpRequest, ev: Event): void {
    if (!ev.isTrusted) return;
    const s = inFlight(this);
    if (s === undefined || s.sync || s.aborted) return;
    rec.guard(() => {
      if (this.readyState === ReadyState.done) {
        finish(this, s);
      } else {
        task(s);
        if (!s.head) head(this, s);
        if (isText(this)) {
          const grown = textDelta(this, s);
          if (grown.length > 0) piece(s, grown);
        }
      }
      xhrEvent(s, ev, XHR_EVENT.target.request);
    });
  };

  /**
   * An event at a request's upload object. Those the platform dispatches
   * while it sends the body (`progress`, `load`, `loadend`) run in network
   * tasks of their own, a `Task` each; `loadstart` runs inside `send()` and
   * an abort's events inside `abort()`, page calls. A failure's `error` or
   * `timeout` reaches the upload object before the request (XHR standard,
   * "request error steps"), so the failure is written at the first of them.
   * Each one's `XhrEvent` follows.
   */
  const onUploadEvent = function (this: XMLHttpRequestUpload, ev: Event): void {
    if (!ev.isTrusted) return;
    const x = uploads.get(this);
    const s = x === undefined ? undefined : states.get(x);
    if (s === undefined || s.reqId === undefined || s.sync) return;
    rec.guard(() => {
      if (s.failing) {
        if (ev.type === "error" || ev.type === "timeout") {
          failure(
            s,
            ev.type === "timeout" ? Outcome.timeout : Outcome.networkError,
          );
        }
      } else if (!s.done && !s.aborted && !s.sending) {
        task(s);
      }
      xhrEvent(s, ev, XHR_EVENT.target.upload);
    });
  };

  /**
   * `error` or `timeout` at the request: how a request whose DONE showed
   * status 0 failed, unless its upload object already said so; then the
   * event's `XhrEvent`.
   */
  const onFailureEvent = function (this: XMLHttpRequest, ev: Event): void {
    if (!ev.isTrusted) return;
    const s = states.get(this);
    if (s === undefined || s.reqId === undefined) return;
    rec.guard(() => {
      if (s.failing) {
        failure(
          s,
          ev.type === "timeout" ? Outcome.timeout : Outcome.networkError,
        );
      }
      xhrEvent(s, ev, XHR_EVENT.target.request);
    });
  };

  /**
   * `loadstart`, `abort`, `load` and `loadend` at the request: no part of
   * the response comes with them (`loadstart` runs inside `send()`; the
   * rest in DONE's task, or inside `abort()` or a synchronous `send()`),
   * only their `XhrEvent`.
   */
  const onRequestEvent = function (this: XMLHttpRequest, ev: Event): void {
    if (!ev.isTrusted) return;
    const s = states.get(this);
    if (s === undefined || s.reqId === undefined) return;
    rec.guard(() => xhrEvent(s, ev, XHR_EVENT.target.request));
  };

  // The constructor registers the shim's listeners first, so its records
  // precede every listener the page adds, whenever it adds it. Listening at
  // the request itself changes nothing the platform does (unlike the upload
  // object, below).
  const PatchedXhr = function XMLHttpRequest(this: unknown): XMLHttpRequest {
    if (new.target === undefined) {
      // Calling the constructor without `new` throws; keep that.
      return (OrigXhr as unknown as () => XMLHttpRequest)();
    }
    // Constructed for `new.target`, so a page subclass keeps its prototype.
    const x = Reflect.construct(OrigXhr, [], new.target) as XMLHttpRequest;
    rec.guard(() => {
      states.set(x, newState("GET", "", false));
      orig.addEventListener.call(
        x,
        "readystatechange",
        onReadyStateChange as EventListener,
      );
      orig.addEventListener.call(x, "progress", onProgress as EventListener);
      uploads.set(x.upload, x);
      for (const t of ["error", "timeout"]) {
        orig.addEventListener.call(x, t, onFailureEvent as EventListener);
      }
      for (const t of REQUEST_EVENTS) {
        orig.addEventListener.call(x, t, onRequestEvent as EventListener);
      }
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
      const prev = states.get(this);
      if (prev !== undefined) {
        rec.guard(() => {
          // Reopened from its own DONE handler, before the failure's event:
          // the platform may not fire it now, and the log must still close
          // the request. A network error is what the page could tell.
          if (prev.failing) failure(prev, Outcome.networkError);
          // `open(method, url, async)`: an explicit falsy `async` (even
          // `undefined`) makes the request synchronous.
          states.set(
            this,
            newState(
              normaliseMethod(method),
              absoluteUrl(w, url instanceof URL ? url.href : url),
              rest.length > 0 && !rest[0],
            ),
          );
        });
      }
    },
  );

  replaceValue(proto, "send", function send(this: XMLHttpRequest): void {
    const s = states.get(this);
    // The platform refuses send() unless the request is OPENED and not
    // already sent, and throws before sending anything (XHR standard,
    // send() steps 1 and 2): such a call is not a request.
    if (
      s !== undefined &&
      rec.recording &&
      !s.sent &&
      this.readyState === ReadyState.opened
    ) {
      const body = arguments[0] as unknown;
      rec.guard(() => {
        // For GET and HEAD the platform ignores the body (step 3).
        let digest =
          s.method === "GET" || s.method === "HEAD" ? "" : bodyDigest(body);
        if (digest === null) {
          ctx.refuseOnce(
            UNRECORDABLE_REQUEST_BODY,
            `XHR body ${typeName(body)}`,
          );
          digest = "";
        }
        s.sent = true;
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
    if (s !== undefined) s.sending = true;
    try {
      return (origSend as (...a: unknown[]) => void).apply(
        this,
        Array.from(arguments),
      );
    } catch (e) {
      // A synchronous request that fails throws from send() and fires no
      // event at all (XHR standard, "request error steps" step 4).
      if (s !== undefined && s.sync && s.reqId !== undefined && !s.done) {
        s.done = true;
        rec.guard(() => failure(s, failureOutcome(e)));
      }
      throw e;
    } finally {
      if (s !== undefined) s.sending = false;
    }
  });

  replaceValue(proto, "abort", function abort(this: XMLHttpRequest): void {
    const s = states.get(this);
    if (s !== undefined) s.aborted = true;
    return origAbort.call(this);
  });

  patchUploadListeners(ctx, uploads, onUploadEvent);
}

/** Every event the platform fires at an XHR's upload object. */
const UPLOAD_EVENTS = [
  "loadstart",
  "progress",
  "abort",
  "error",
  "load",
  "timeout",
  "loadend",
];

/**
 * Listen at an XHR's upload object, first, once the page does.
 *
 * Not before: a listener on the upload object is what makes the platform
 * fire upload events at all, and it forces a CORS preflight for a
 * cross-origin request (XHR standard, `send()`, "upload listener flag";
 * https://xhr.spec.whatwg.org/#the-send()-method). So the shim adds its
 * listener only when the page adds one, just before the page's, through
 * `addEventListener` or an `on<event>` handler of the upload object, and
 * the request goes out exactly as it would without the shim. (A page that
 * adds an upload listener and removes it again before `send()` would now
 * have the flag set; the shim does not undo its own listener.)
 */
function patchUploadListeners(
  ctx: SeamContext,
  uploads: WeakMap<XMLHttpRequestUpload, XMLHttpRequest>,
  onUploadEvent: (this: XMLHttpRequestUpload, ev: Event) => void,
): void {
  const { w, rec, orig } = ctx;
  const Upload = w.XMLHttpRequestUpload;
  const Target = w.XMLHttpRequestEventTarget;
  if (Upload === undefined || Target === undefined) return;
  const watched = new WeakSet<XMLHttpRequestUpload>();
  const watch = (target: unknown, listener: unknown) => {
    if (listener === null || listener === undefined) return;
    const u = target as XMLHttpRequestUpload;
    if (watched.has(u) || !uploads.has(u)) return;
    rec.guard(() => {
      watched.add(u);
      for (const t of UPLOAD_EVENTS) {
        orig.addEventListener.call(u, t, onUploadEvent as EventListener);
      }
    });
  };

  const origAdd = orig.addEventListener;
  replaceValue(
    Upload.prototype,
    "addEventListener",
    function addEventListener(
      this: XMLHttpRequestUpload,
      type: string,
      listener: unknown,
      ...rest: unknown[]
    ): void {
      watch(this, listener);
      return (origAdd as (...a: unknown[]) => void).call(
        this,
        type,
        listener,
        ...rest,
      );
    },
  );
  for (const t of UPLOAD_EVENTS) {
    const name = `on${t}`;
    const d = Object.getOwnPropertyDescriptor(Target.prototype, name);
    if (d?.get === undefined || d.set === undefined) continue;
    const set = d.set;
    replaceAccessor(Target.prototype, name, d.get, function (v: unknown) {
      watch(this, v);
      set.call(this, v);
    });
  }
}

function newState(method: string, url: string, sync: boolean): XhrState {
  return {
    method,
    url,
    sync,
    sent: false,
    aborted: false,
    sending: false,
    head: false,
    seen: 0,
    done: false,
    failing: false,
  };
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
export function messageBytes(data: unknown): Uint8Array | null {
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

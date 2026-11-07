/**
 * Replay of XMLHttpRequest (CodeTracer's JS-Boundary-Recording
 * specification §5.2 `NetRequest`, `NetResponse`, `WsMessage`,
 * `XhrEvent`; §6; §10.1; §10.4).
 *
 * The page's request object is a real XMLHttpRequest, so `instanceof`,
 * `open()` (with its own `readystatechange` to OPENED), request headers and
 * `responseType` behave as the platform's; it is never sent. `send()` is
 * matched against the log's `NetRequest` and `TaskReg`, and the response is
 * delivered from the log task by task, as the record side wrote it:
 *
 * - a `Task` of the request followed by response records (the head, a
 *   piece, the end, or a whole response) moves the request to the state
 *   they bring it to; then either the event that brought them (an
 *   `XhrEvent`) is dispatched, or a `readystatechange`;
 * - DONE's `readystatechange` comes after a `progress` at DONE and before
 *   the request's `load`, `error`, `timeout` or `abort` (§6), whose
 *   `XhrEvent`s follow in the same task;
 * - a request that failed at DONE shows status 0: the `Task` opens DONE,
 *   its `readystatechange` listeners run, and how it failed is logged at the
 *   `error` or `timeout` event after them, so the replay looks ahead in the
 *   log for the request's next record to tell such a task apart;
 * - what the platform dispatches inside a page call (`send()`'s
 *   `loadstart`, a synchronous request, `abort()`) is delivered inside that
 *   call, with no `Task`.
 */

import type { RecordOf } from "@codetracer/boundary-format";
import { XHR_EVENT } from "@codetracer/boundary-format";

import { asConstructor, replaceAccessor, replaceValue } from "../context.js";
import { TaskKind } from "../recorder.js";
import { absoluteUrl, bodyDigest, normaliseMethod } from "../seams-net.js";
import { Dir, Outcome } from "../stream-body.js";
import { type ReplayContext, blobBytes } from "./context.js";
import { endOutcome } from "./net.js";

/** `XMLHttpRequest.readyState` values (XHR standard). */
const ReadyState = {
  unsent: 0,
  opened: 1,
  headersReceived: 2,
  loading: 3,
  done: 4,
};

/** `XhrEvent.event` → the `ProgressEvent` type it dispatches. */
const EVENT_TYPES = new Map<number, string>(
  Object.entries(XHR_EVENT.event).map(([name, n]) => [n, name]),
);

interface XState {
  method: string;
  url: string;
  sync: boolean;
  sent: boolean;
  reqId?: bigint;
  taskId?: bigint;
  readyState: number;
  status: number;
  /** `statusText` and `responseURL` as the log has them (§5.2). */
  statusText: string;
  responseURL: string;
  headers: [string, string][];
  text: string;
  bytes: Uint8Array[];
  decoder: TextDecoder;
  done: boolean;
}

type ResponseRecord = RecordOf<"NetResponse"> | RecordOf<"WsMessage">;

export function replayXhr(ctx: ReplayContext): void {
  const { w, replay, orig } = ctx;
  const OrigXhr = orig.XMLHttpRequest;
  if (OrigXhr === undefined) return;
  const proto = OrigXhr.prototype;
  const origOpen = proto.open;
  const origSend = proto.send;
  const origAbort = proto.abort;
  const origGetAll = proto.getAllResponseHeaders;
  const origGetHeader = proto.getResponseHeader;
  // Every event is the platform's on record: the page's listeners see it
  // as trusted (`trusted.ts`).
  const dispatch = {
    call: (t: EventTarget, ev: Event) => ctx.trusted.dispatch(t, ev),
  };
  const states = new WeakMap<XMLHttpRequest, XState>();

  /** The replay state of a request that has been sent. */
  const sent = (x: unknown): XState | undefined => {
    const s = states.get(x as XMLHttpRequest);
    return s?.sent === true ? s : undefined;
  };

  const fire = (x: XMLHttpRequest, ev: Event) => dispatch.call(x, ev);
  const readyStateChange = (x: XMLHttpRequest) =>
    fire(x, new w.Event("readystatechange"));

  /** The record at the cursor if it is one of `s`'s response records. */
  const responseNext = (s: XState): ResponseRecord | undefined => {
    const r = replay.peek().record;
    if (
      (r?.record === "NetResponse" || r?.record === "WsMessage") &&
      r.req_id === s.reqId
    ) {
      return r;
    }
    return undefined;
  };
  const eventNext = (s: XState): RecordOf<"XhrEvent"> | undefined => {
    const r = replay.peek().record;
    return r?.record === "XhrEvent" && r.req_id === s.reqId ? r : undefined;
  };

  /** Move `s` to the state record `r` brings it to. */
  const apply = (s: XState, r: ResponseRecord) => {
    if (r.record === "NetResponse") {
      if (r.outcome === Outcome.head || r.outcome === Outcome.response) {
        s.status = r.status;
        s.statusText = r.status_text;
        s.responseURL = r.url;
        s.headers = JSON.parse(r.headers) as [string, string][];
      }
      if (r.outcome === Outcome.head) {
        s.readyState = ReadyState.headersReceived;
        return;
      }
      if (r.outcome === Outcome.response) {
        addBody(s, blobBytes(replay, r.body));
      } else {
        failed(s);
      }
      finish(s);
      return;
    }
    if (r.dir === Dir.in) {
      addBody(s, blobBytes(replay, r.data));
      s.readyState = ReadyState.loading;
    } else if (r.dir === Dir.end) {
      if (endOutcome(ctx, r) !== Outcome.response) failed(s);
      finish(s);
    } else {
      replay.fail(
        "ArgumentMismatch",
        `an XHR response record has dir ${r.dir}`,
      );
    }
  };
  /** A failed request shows the network error's status, text and URL. */
  const failed = (s: XState) => {
    s.status = 0;
    s.statusText = "";
    s.responseURL = "";
  };
  const addBody = (s: XState, bytes: Uint8Array) => {
    s.bytes.push(bytes);
    s.text += s.decoder.decode(bytes, { stream: true });
  };
  const finish = (s: XState) => {
    s.text += s.decoder.decode();
    s.readyState = ReadyState.done;
    s.done = true;
    if (s.taskId !== undefined) replay.offTask(s.taskId);
  };

  /** Consume every response record of `s` at the cursor. */
  const consumeResponse = (s: XState): boolean => {
    let any = false;
    for (
      let r = responseNext(s);
      r !== undefined && !s.done;
      r = responseNext(s)
    ) {
      replay.next(r.record, { req_id: s.reqId! });
      apply(s, r);
      any = true;
    }
    return any;
  };

  /** Dispatch the `XhrEvent` at the cursor. */
  const dispatchEvent = (x: XMLHttpRequest, s: XState) => {
    const e = replay.next("XhrEvent", { req_id: s.reqId! });
    const type = EVENT_TYPES.get(e.event);
    if (type === undefined) {
      replay.fail("ArgumentMismatch", `XhrEvent.event ${e.event} is unknown`);
    }
    const target = e.target === XHR_EVENT.target.upload ? x.upload : x;
    dispatch.call(
      target,
      new w.ProgressEvent(type!, {
        loaded: Number(e.loaded),
        total: Number(e.total),
        lengthComputable: e.length_computable === 1,
      }),
    );
  };
  const drainEvents = (x: XMLHttpRequest, s: XState) => {
    while (eventNext(s) !== undefined) dispatchEvent(x, s);
  };

  /**
   * Whether the request's next record, wherever it is in the log, is a
   * failure (outcome 2 or 4): the task at the cursor is then DONE's, with
   * status 0, and the failure is logged after its listeners ran.
   */
  const failsNext = (s: XState): boolean => {
    for (let i = 0; ; i++) {
      const r = replay.peekAt(i).record;
      if (r === undefined) return false;
      if (
        (r.record === "NetResponse" ||
          r.record === "WsMessage" ||
          r.record === "XhrEvent") &&
        r.req_id === s.reqId
      ) {
        if (r.record === "NetResponse") {
          return (
            r.outcome === Outcome.networkError || r.outcome === Outcome.timeout
          );
        }
        if (r.record === "WsMessage" && r.dir === Dir.end) {
          const o = endOutcome(ctx, r);
          return o === Outcome.networkError || o === Outcome.timeout;
        }
        return false;
      }
    }
  };

  const onTask = (x: XMLHttpRequest, s: XState) => {
    if (responseNext(s) === undefined && eventNext(s) === undefined) {
      if (failsNext(s)) {
        s.readyState = ReadyState.done;
        failed(s);
        readyStateChange(x);
        const r = responseNext(s);
        if (r === undefined) {
          replay.fail(
            "MissingRead",
            "an XMLHttpRequest failed at DONE, but its failure is not logged after DONE's listeners",
          );
        }
        replay.next(r!.record, { req_id: s.reqId! });
        apply(s, r!);
        drainEvents(x, s);
        return;
      }
      // A readystatechange that brought nothing new.
      readyStateChange(x);
      return;
    }
    const changed = consumeResponse(s);
    const e = eventNext(s);
    if (
      e !== undefined &&
      e.target === XHR_EVENT.target.request &&
      e.event === XHR_EVENT.event.progress
    ) {
      dispatchEvent(x, s);
      if (s.done) {
        readyStateChange(x);
        drainEvents(x, s);
      }
      return;
    }
    if (changed) readyStateChange(x);
    drainEvents(x, s);
  };

  const PatchedXhr = function XMLHttpRequest(this: unknown): XMLHttpRequest {
    if (new.target === undefined) {
      return (OrigXhr as unknown as () => XMLHttpRequest)();
    }
    return Reflect.construct(OrigXhr, [], new.target) as XMLHttpRequest;
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
      states.set(this, {
        method: normaliseMethod(method),
        url: absoluteUrl(w, url instanceof URL ? url.href : url),
        sync: rest.length > 0 && !rest[0],
        sent: false,
        readyState: ReadyState.opened,
        status: 0,
        statusText: "",
        responseURL: "",
        headers: [],
        text: "",
        bytes: [],
        decoder: new TextDecoder(),
        done: false,
      });
    },
  );

  replaceValue(proto, "send", function send(this: XMLHttpRequest): void {
    const s = states.get(this);
    if (s === undefined) {
      // Not opened: the platform throws, as on record.
      return (origSend as (...a: unknown[]) => void).apply(
        this,
        Array.from(arguments),
      );
    }
    if (s.sent) {
      // Sent already (XHR standard, send() steps 1 and 2). The platform's
      // object was never sent, so it would send now: throw as it would.
      throw new w.DOMException(
        "Failed to execute 'send' on 'XMLHttpRequest': The object's state must be OPENED.",
        "InvalidStateError",
      );
    }
    const body = arguments[0] as unknown;
    const digest =
      s.method === "GET" || s.method === "HEAD"
        ? ""
        : (bodyDigest(body, ctx.holes) ?? "");
    s.sent = true;
    s.reqId = ctx.nextReqId();
    s.taskId = ctx.nextTaskId();
    replay.next("NetRequest", {
      req_id: s.reqId,
      api: 2,
      method: s.method,
      url: s.url,
      body_digest: digest,
    });
    replay.registerTask(s.taskId, TaskKind.networkCompletion, 0);
    // `loadstart` (and an upload `loadstart`) run inside send().
    drainEvents(this, s);
    if (s.sync) {
      if (!consumeResponse(s)) {
        replay.fail(
          "MissingRead",
          "a synchronous XMLHttpRequest has no response in the log",
        );
      }
      if (s.status === 0) {
        throw new w.DOMException(
          "Failed to execute 'send' on 'XMLHttpRequest'",
          "NetworkError",
        );
      }
      readyStateChange(this);
      drainEvents(this, s);
      return;
    }
    const x = this;
    replay.onTask(s.taskId, () => onTask(x, s));
  });

  replaceValue(proto, "abort", function abort(this: XMLHttpRequest): void {
    const s = sent(this);
    if (s === undefined || s.done) {
      if (s !== undefined) s.readyState = ReadyState.unsent;
      return origAbort.call(this);
    }
    // Inside abort(): DONE with the abort logged first (the record side
    // writes it from DONE's readystatechange), then the events.
    s.readyState = ReadyState.done;
    failed(s);
    const r = responseNext(s);
    if (r !== undefined) {
      replay.next(r.record, { req_id: s.reqId! });
      apply(s, r);
    } else {
      finish(s);
    }
    readyStateChange(this);
    drainEvents(this, s);
    s.readyState = ReadyState.unsent;
  });

  const getter = (
    name: string,
    value: (s: XState, x: XMLHttpRequest) => unknown,
  ) => {
    const d = Object.getOwnPropertyDescriptor(proto, name);
    if (d?.get === undefined) return;
    const get = d.get;
    replaceAccessor(
      proto,
      name,
      function (this: unknown) {
        const s = sent(this);
        return s === undefined
          ? get.call(this)
          : value(s, this as XMLHttpRequest);
      },
      d.set,
    );
  };
  const isText = (x: XMLHttpRequest) =>
    x.responseType === "" || x.responseType === "text";
  getter("readyState", (s) => s.readyState);
  getter("status", (s) =>
    s.readyState >= ReadyState.headersReceived ? s.status : 0,
  );
  // Logged with the head (§5.2): the reason phrase (empty over HTTP/2) and
  // the final URL after any redirect.
  getter("statusText", (s) =>
    s.readyState >= ReadyState.headersReceived ? s.statusText : "",
  );
  getter("responseURL", (s) =>
    s.readyState >= ReadyState.headersReceived ? s.responseURL : "",
  );
  getter("responseText", (s, x) => {
    if (!isText(x)) {
      throw new w.DOMException(
        "The value is only accessible if the object's 'responseType' is '' or 'text'.",
        "InvalidStateError",
      );
    }
    return s.text;
  });
  getter("response", (s, x) => {
    if (isText(x)) return s.text;
    if (!s.done || s.status === 0) return null;
    if (x.responseType === "json") {
      try {
        return JSON.parse(s.text) as unknown;
      } catch {
        return null;
      }
    }
    if (x.responseType === "arraybuffer") {
      let n = 0;
      for (const b of s.bytes) n += b.length;
      const out = new Uint8Array(n);
      let at = 0;
      for (const b of s.bytes) {
        out.set(b, at);
        at += b.length;
      }
      return out.buffer;
    }
    return null;
  });

  replaceValue(
    proto,
    "getAllResponseHeaders",
    function getAllResponseHeaders(this: XMLHttpRequest): string {
      const s = sent(this);
      if (s === undefined) return origGetAll.call(this);
      if (s.readyState < ReadyState.headersReceived) return "";
      return s.headers.map(([n, v]) => `${n}: ${v}\r\n`).join("");
    },
  );
  replaceValue(
    proto,
    "getResponseHeader",
    function getResponseHeader(
      this: XMLHttpRequest,
      name: string,
    ): string | null {
      const s = sent(this);
      if (s === undefined) return origGetHeader.call(this, name);
      if (s.readyState < ReadyState.headersReceived) return null;
      const wanted = String(name).toLowerCase();
      const values = s.headers
        .filter(([n]) => n.toLowerCase() === wanted)
        .map(([, v]) => v);
      return values.length === 0 ? null : values.join(", ");
    },
  );
}

/**
 * A fetch response's body, delivered to the page as it streams and recorded
 * piece by piece as each piece reaches the page (JS-Boundary-Recording.md
 * §5.2 `NetResponse` outcome 5 and `WsMessage` dir 1 and 4, §6, §10.1,
 * §10.4).
 *
 * The platform resolves `fetch` when the response's head (status and
 * headers) arrives; its body is a stream the page reads at its own pace,
 * possibly forever (server-sent events over `fetch`, long polling, token
 * streaming). The page is therefore given its response at once, with a body
 * that is the shim's own `ReadableStream` over the platform's: every read the
 * page makes pulls exactly one read from the platform's body, the piece is
 * recorded, and then it is handed to the page. So:
 *
 *  - the page sees each piece as soon as it would without the shim, and its
 *    continuation follows the piece's record;
 *  - the shim reads nothing the page does not ask for (an unread body is
 *    left to the platform's backpressure, as it would be), and a page that
 *    cancels its body cancels the platform's, so the request stops;
 *  - a piece that arrives while the page waits for it comes in a network
 *    task of its own and is preceded by a `Task` with the request's id; a
 *    piece that was already there when the page asked is read inside the
 *    page's current task and has none (§6).
 *
 * A constructed `Response` lacks what only the platform can set on one
 * (`url`, `redirected`, `type`, and a `statusText` the constructor might
 * refuse) and has mutable headers. The `Response` accessors are patched to
 * answer those from the platform's response, `clone()` carries them to the
 * clone, and the `Headers` mutators throw on a rebuilt response's headers
 * exactly as the platform's immutable headers do (by calling them on those).
 *
 * Reading a whole body (`json()`, `text()`, …) resolves in a task of the
 * platform's own once the body is read (Fetch, "fully read body": "queue a
 * fetch task"), between which and the body's end the browser may run any
 * other task (an input). That task is the page's too, since its
 * continuation runs in it, so it is recorded: a `Task` with the request's
 * id when such a call settles, before the page's continuation runs
 * ({@link BODY_CONSUMERS}; §6, as amended 2026-10-23).
 */

import {
  type SeamContext,
  inline,
  replaceAccessor,
  replaceValue,
  utf8Bytes,
} from "./context.js";
import { RESPONSE_TYPE, WS_FRAME } from "@codetracer/boundary-format";

import { HEADERS_MUTATORS, RESPONSE_GETTERS } from "./originals.js";
import { type Recorder, TaskKind } from "./recorder.js";
import {
  BODY_READS,
  FILE_CONTENT,
  isPageResponse,
  isUserContent,
  markPageResponse,
  recordPlatformTask,
} from "./seams-platform.js";

/**
 * The methods that read a whole body and settle in a task of their own
 * (Fetch, "consume body"), as `Response.prototype` has them.
 */
export const BODY_CONSUMERS: readonly string[] = BODY_READS;

/** `NetResponse.outcome` (§5.2). */
export const Outcome = {
  response: 1,
  networkError: 2,
  abort: 3,
  timeout: 4,
  /** The response's head; the body follows as `WsMessage` records. */
  head: 5,
};

/** `WsMessage.dir` (§5.2). */
export const Dir = {
  in: 1,
  out: 2,
  close: 3,
  /** The end of a streamed response body: `{"outcome": n}`. */
  end: 4,
};

/**
 * The outcome an error ending a request or its body stands for: an abort
 * (`AbortError`), a timeout (`TimeoutError`, as `AbortSignal.timeout`
 * raises), or a network error (anything else, a `TypeError` in Chromium).
 */
export function failureOutcome(err: unknown): number {
  const name = (err as { name?: unknown } | null)?.name;
  if (name === "AbortError") return Outcome.abort;
  if (name === "TimeoutError") return Outcome.timeout;
  return Outcome.networkError;
}

/** Write the end of request `reqId`'s streamed body. */
export function emitBodyEnd(
  rec: Recorder,
  reqId: bigint,
  outcome: number,
): void {
  rec.emit("WsMessage", {
    req_id: reqId,
    dir: Dir.end,
    ...NOT_A_MESSAGE,
    data: inline(utf8Bytes(JSON.stringify({ outcome }))),
  });
}

/**
 * The `WsMessage` fields of a record that is not a message (§5.2): a piece or
 * the end of a streamed body, a close.
 */
export const NOT_A_MESSAGE = {
  frame: WS_FRAME.none,
  event: "",
  last_event_id: "",
} as const;

/**
 * The `NetResponse` fields only a `fetch` or XMLHttpRequest response has
 * (§5.2), for a record that is neither: a failure, a beacon, a socket's or an
 * event stream's open.
 */
export const NO_RESPONSE_META = {
  status_text: "",
  url: "",
  redirected: 0,
  response_type: RESPONSE_TYPE.none,
} as const;

/** The `NetResponse` fields of what a page can read of a response. */
export interface NetResponseMeta {
  status_text: string;
  url: string;
  redirected: number;
  response_type: number;
}

/**
 * The `NetResponse` fields of a `fetch` response as the page can read them:
 * its `statusText`, its final `url` (after any redirect), `redirected` and
 * `type` (§5.2, §10.4).
 */
export function fetchResponseMeta(r: {
  statusText: string;
  url: string;
  redirected: boolean;
  type: string;
}): NetResponseMeta {
  const type = (RESPONSE_TYPE as Record<string, number>)[r.type];
  if (type === undefined || type === RESPONSE_TYPE.none) {
    // A type the Fetch standard does not define: a recorder fault, never a
    // value replay would get wrong.
    throw new Error(`unknown Response.type ${JSON.stringify(r.type)}`);
  }
  return {
    status_text: r.statusText,
    url: r.url,
    redirected: r.redirected ? 1 : 0,
    response_type: type,
  };
}

/** What the platform's response says that a constructed one cannot. */
interface ResponseMeta {
  url: string;
  redirected: boolean;
  type: ResponseType;
  statusText: string;
  /** The platform's headers object, immutable. */
  headers: Headers;
}

export interface StreamedResponses {
  /**
   * A response for the page that delivers `resp`'s body as it streams,
   * recording it as request `reqId` with task `taskId`; `undefined` when
   * `resp` has no body or cannot be rebuilt, in which case `resp` is left
   * untouched (its body neither read nor locked).
   */
  rebuild(resp: Response, reqId: bigint, taskId: bigint): Response | undefined;
}

/**
 * Patch what a rebuilt response needs and return the rebuilder, or
 * `undefined` when this platform lacks any part of it.
 */
export function patchResponses(
  ctx: SeamContext,
): StreamedResponses | undefined {
  const { w, rec, orig } = ctx;
  const OrigResponse = orig.Response;
  const OrigStream = orig.ReadableStream;
  const origClone = orig.responseClone;
  if (
    OrigResponse === undefined ||
    OrigStream === undefined ||
    origClone === undefined ||
    orig.responseGetters.size !== RESPONSE_GETTERS.length ||
    orig.headersMutators.size !== HEADERS_MUTATORS.length
  ) {
    return undefined;
  }
  const OrigPromise = orig.Promise;
  const then = orig.promiseThen;
  const queueMicrotask = orig.queueMicrotask;

  const meta = new WeakMap<object, ResponseMeta>();
  // A rebuilt response (and its clones) -> the task id of its request.
  const tasks = new WeakMap<object, bigint>();
  // A rebuilt response's headers object -> the platform's immutable one.
  const frozen = new WeakMap<object, Headers>();

  for (const [name, g] of orig.responseGetters) {
    const get = g.descriptor.get!;
    replaceAccessor(
      g.owner,
      name,
      function (this: unknown) {
        const m = meta.get(this as object);
        return m === undefined
          ? get.call(this)
          : m[name as keyof Omit<ResponseMeta, "headers">];
      },
      g.descriptor.set,
    );
  }
  replaceValue(
    OrigResponse.prototype,
    "clone",
    function clone(this: Response): Response {
      const c = origClone.call(this);
      const m = meta.get(this);
      if (m !== undefined) {
        meta.set(c, m);
        frozen.set(c.headers, m.headers);
      }
      const t = tasks.get(this);
      if (t !== undefined) tasks.set(c, t);
      if (isPageResponse(this)) markPageResponse(c);
      return c;
    },
  );
  for (const name of BODY_CONSUMERS) {
    const read = (OrigResponse.prototype as unknown as Record<string, unknown>)[
      name
    ];
    if (typeof read !== "function") continue;
    replaceValue(OrigResponse.prototype, name, function (this: Response) {
      if (isUserContent(this)) {
        ctx.refuseOnce(FILE_CONTENT, `Response.${name} of a user's file`);
      }
      const settled = (read as (...a: unknown[]) => Promise<unknown>).apply(
        this,
        Array.from(arguments),
      );
      const taskId = tasks.get(this);
      if (taskId === undefined) {
        // A response the page holds that no `fetch` streamed (one it made,
        // or a null-body response passed through as it came): its read
        // settles in a platform task of its own (§6, Task kind 13). Any other
        // (the upload transport's own) is not the page's.
        return isPageResponse(this)
          ? recordPlatformTask(ctx, settled)
          : settled;
      }
      // The page's continuation follows the record of the task it runs in.
      const task = () =>
        rec.guard(() => rec.task(taskId, TaskKind.networkCompletion));
      return new OrigPromise((resolve, reject) => {
        (then as Promise<unknown>["then"]).call(
          settled,
          (v) => {
            task();
            resolve(v);
          },
          (e: unknown) => {
            task();
            reject(e);
          },
        );
      });
    });
  }
  for (const [name, f] of orig.headersMutators) {
    const patched = function (this: unknown): unknown {
      const platform = frozen.get(this as object);
      return f.apply(platform ?? this, Array.from(arguments));
    };
    Object.defineProperty(patched, "name", { value: name });
    replaceValue(w.Headers.prototype, name, patched);
  }

  return {
    rebuild(resp, reqId, taskId) {
      const body = resp.body;
      if (body === null || resp.status < 200 || resp.status > 599) {
        return undefined;
      }
      // The platform's body is a byte stream in current engines; the page's
      // must be one exactly when it is, so a BYOB reader works or fails as
      // it would.
      let bytes: boolean;
      try {
        body.getReader({ mode: "byob" }).releaseLock();
        bytes = true;
      } catch {
        bytes = false;
      }
      // The platform's body is locked to this reader once the page's
      // response exists (below), and read only when the page reads.
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let cancelled = false;
      /** The body's end (or failure) has been recorded and delivered. */
      let ended = false;
      const readerOf = () => (reader ??= body.getReader());

      /** Record a piece (or the end) unless the page cancelled. */
      const record = (newTask: boolean, write: () => void) => {
        if (cancelled) return;
        rec.guard(() => {
          if (newTask) rec.task(taskId, TaskKind.networkCompletion);
          write();
        });
      };

      /**
       * One read of the platform's body for one pull of the page's. Whether
       * the read was already settled when it was made (the piece, the end or
       * the error was there) is told by microtask order: a settled read's
       * reaction is queued at once, ahead of the marker queued after it.
       */
      const pull = (
        controller: ReadableStreamController<Uint8Array>,
      ): Promise<void> =>
        new OrigPromise<void>((resolve) => {
          let later = false;
          const r = readerOf();
          (then as Promise<ReadableStreamReadResult<Uint8Array>>["then"]).call(
            r.read(),
            (res) => {
              const queued = !later;
              if (!res.done && res.value.byteLength === 0) {
                // Nothing to deliver: read on, as the platform's reader
                // would never have shown the page an empty piece.
                resolve(pull(controller));
                return;
              }
              if (res.done) {
                ended = true;
                record(!queued, () =>
                  emitBodyEnd(rec, reqId, Outcome.response),
                );
                try {
                  controller.close();
                  (
                    controller as ReadableByteStreamController
                  ).byobRequest?.respond(0);
                } catch {
                  // The page cancelled meanwhile: nothing to close.
                }
              } else {
                record(!queued, () =>
                  rec.emit("WsMessage", {
                    req_id: reqId,
                    dir: Dir.in,
                    ...NOT_A_MESSAGE,
                    data: inline(res.value),
                  }),
                );
                try {
                  controller.enqueue(res.value as Uint8Array<ArrayBuffer>);
                } catch {
                  // The page cancelled meanwhile.
                }
              }
              resolve();
            },
            (err: unknown) => {
              const queued = !later;
              if (ended) {
                // Already delivered by the reader's closed promise below.
                resolve();
                return;
              }
              ended = true;
              const outcome = failureOutcome(err);
              // An abort is the page's own call (its AbortController),
              // made inside one of its tasks, not a task of its own.
              record(!queued && outcome !== Outcome.abort, () =>
                emitBodyEnd(rec, reqId, outcome),
              );
              try {
                controller.error(err);
              } catch {
                // Already closed or errored.
              }
              resolve();
            },
          );
          queueMicrotask.call(w, () => {
            later = true;
          });
        });

      let pageController: ReadableStreamController<Uint8Array> | undefined;
      const source = {
        type: bytes ? ("bytes" as const) : undefined,
        start(controller: ReadableStreamController<Uint8Array>) {
          pageController = controller;
        },
        pull,
        cancel(reason: unknown): Promise<void> {
          cancelled = true;
          return readerOf().cancel(reason);
        },
      };
      // highWaterMark 0: pull only when the page reads.
      const stream = new OrigStream(source as UnderlyingDefaultSource, {
        highWaterMark: 0,
      });
      let page: Response;
      try {
        page = new OrigResponse(stream, {
          status: resp.status,
          statusText: resp.statusText,
          headers: resp.headers,
        });
      } catch {
        try {
          // A reason phrase the constructor refuses: the accessor answers
          // it from the platform's response anyway.
          page = new OrigResponse(stream, {
            status: resp.status,
            headers: resp.headers,
          });
        } catch {
          return undefined;
        }
      }
      meta.set(page, {
        url: resp.url,
        redirected: resp.redirected,
        type: resp.type,
        statusText: resp.statusText,
        headers: resp.headers,
      });
      frozen.set(page.headers, resp.headers);
      tasks.set(page, taskId);

      // A failure (an abort, a network error) errors the platform's body at
      // once, discarding what it had queued, whether or not anyone reads:
      // the page's reader.closed rejects then, and a read made later fails
      // (Streams standard, ReadableStreamError). The page's stream follows
      // at the same moment, through the platform reader's closed promise,
      // whose rejection is queued before that of a pending read.
      (then as Promise<undefined>["then"]).call(
        readerOf().closed,
        undefined,
        (err: unknown) => {
          if (ended || cancelled) return;
          ended = true;
          const outcome = failureOutcome(err);
          // An abort is the page's own call (its AbortController), made
          // inside one of its tasks; a network error arrives in a network
          // task of its own.
          record(outcome !== Outcome.abort, () =>
            emitBodyEnd(rec, reqId, outcome),
          );
          try {
            pageController?.error(err);
          } catch {
            // Already closed or errored.
          }
        },
      );
      return page;
    },
  };
}

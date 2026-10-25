/**
 * Message tasks and storage events (JS-Boundary-Recording.md §5.2 `Task`
 * kinds 6 and 9, `Input`; §6; §7.5; §10.1).
 *
 * **Messages the page posts to itself.** `window.postMessage` on the page's
 * own window and `MessagePort.postMessage` on a port of a `MessageChannel`
 * the page made each queue a task on the receiving side (HTML, "posted
 * message task source"), which the browser runs whenever it chooses among
 * the page's other tasks. The delivery, when the platform dispatches the
 * `message` event, writes `Task{kind 6}` before any listener of the page
 * runs (the shim listens first). The data is the page's own and is replayed
 * from the page's own post. A port post writes `TaskReg{kind 6}` when it is
 * made, and its delivery is matched to the oldest post not yet delivered to
 * that port (HTML, "port message queue": in the order posted); a port moved
 * by a port post's transfer list is followed to the port the receiver gets.
 * A window post is told at its delivery, by its `source` being the page's
 * window, and its task id is minted there, with no `TaskReg`: wrapping
 * `window.postMessage` would change the `source` and `origin` of a
 * message a frame posts to the page (below). A port moved through a window
 * post is refused (`unrecordable-message`): with no transfer list to look
 * at, the shim cannot tell whose peer the port it arrives as is.
 *
 * **Messages from elsewhere.** A message event at the window or at one of
 * those ports that the page did not post (from another document, a
 * browser extension, a port moved to another document) carries data and an
 * origin the log does not hold, so its first delivery is refused
 * (`foreign-message`, §7.5): the session is non-replayable from there.
 *
 * **Storage events.** A `storage` event reaches the page when another
 * document changed `localStorage` or `sessionStorage` (HTML, "The storage
 * event"): a browser-dispatched task, like an input. It writes `Task{kind 9}`
 * (the id minted at dispatch, no `TaskReg`) and an `Input` with its type
 * `storage`, target `win` and the event's `key`, `oldValue`, `newValue`, `url`
 * and `storageArea` (`localStorage` or `sessionStorage`) as its `props`;
 * replay dispatches the event from them.
 */

import { type SeamContext, asConstructor, replaceValue } from "./context.js";
import { TaskKind } from "./recorder.js";
import { UNRECORDABLE_MESSAGE } from "./seams-net.js";

/** `Refusal.feature`: a message the page did not post (§7.5). */
export const FOREIGN_MESSAGE = "foreign-message";

/** The props of a storage event's `Input` (§10.4). */
export interface StorageEventProps {
  key: string | null;
  oldValue: string | null;
  newValue: string | null;
  url: string;
  storageArea: "localStorage" | "sessionStorage" | null;
}

/**
 * Whether a post to the page's own window with `targetOrigin` reaches it
 * (HTML, "window post message steps": `*` always, `/` for the page's own
 * origin, otherwise the origin of the URL given). A post the platform
 * drops reaches nobody and is no task.
 */
export function reachesOwnWindow(
  w: SeamContext["w"],
  options: unknown,
): boolean {
  const target =
    typeof options === "object" && options !== null
      ? ((options as { targetOrigin?: unknown }).targetOrigin ?? "/")
      : options;
  const t = target === undefined ? "/" : String(target);
  if (t === "*") return true;
  const own = w.location.origin;
  if (t === "/") return own !== "null";
  try {
    return new URL(t).origin === own && own !== "null";
  } catch {
    return false; // the platform throws a SyntaxError first
  }
}

/**
 * The transfer list of a `MessagePort.postMessage` call (`(msg, transfer)`
 * or `(msg, options)`).
 */
export function transferOf(args: readonly unknown[]): unknown[] {
  const opts = args[1];
  if (typeof opts === "object" && opts !== null && !Array.isArray(opts)) {
    const t = (opts as { transfer?: unknown }).transfer;
    return Array.isArray(t) ? t : [];
  }
  return Array.isArray(opts) ? opts : [];
}

/** Patch every seam this module owns, and listen at the window first. */
export function patchMessageSeams(ctx: SeamContext): void {
  const { w, rec, orig } = ctx;
  /** A post not yet delivered: its task, and the page's ports it moved. */
  interface Post {
    taskId: bigint;
    moved: MessagePort[];
  }
  // The posts not yet delivered, per receiver (the window, or a port).
  const queues = new WeakMap<object, Post[]>();
  // Each of the page's ports -> its entangled port.
  const peers = new WeakMap<MessagePort, MessagePort>();
  const queueOf = (receiver: object): Post[] => {
    let q = queues.get(receiver);
    if (q === undefined) {
      q = [];
      queues.set(receiver, q);
    }
    return q;
  };

  /** Write the post's `TaskReg` and queue it at `receiver`. */
  const post = (receiver: object, transfer: unknown[]) => {
    const taskId = rec.nextTaskId();
    rec.emit("TaskReg", {
      task_id: taskId,
      kind: TaskKind.message,
      delay_ms: 0,
    });
    const moved = transfer.filter((t): t is MessagePort =>
      peers.has(t as MessagePort),
    );
    queueOf(receiver).push({ taskId, moved });
  };

  /** A delivery at `receiver`: its `Task`, or a refusal when nobody posted it. */
  const deliver = (receiver: object, ev: MessageEvent, from: string) => {
    const p = queues.get(receiver)?.shift();
    if (p === undefined) {
      ctx.refuseOnce(
        FOREIGN_MESSAGE,
        `a message at ${from} from ${ev.origin || "an unknown origin"}`,
      );
      return;
    }
    rec.task(p.taskId, TaskKind.message);
    // The ports the post moved arrive as new objects, in transfer order;
    // their peers now talk to those.
    p.moved.forEach((old, i) => {
      const fresh = ev.ports[i];
      const peer = peers.get(old);
      if (fresh === undefined || peer === undefined) return;
      peers.set(fresh, peer);
      peers.set(peer, fresh);
      const q = queues.get(old);
      if (q !== undefined) queues.set(fresh, q);
      listenAtPort(fresh);
    });
  };

  const listenAtPort = (port: MessagePort) => {
    // A listener added with addEventListener does not start the port (HTML,
    // "MessagePort"), so the page's own start() or onmessage still decides
    // when messages flow.
    orig.addEventListener.call(port, "message", (ev: Event) => {
      if (!ev.isTrusted || !rec.recording) return;
      rec.guard(() => deliver(port, ev as MessageEvent, "a MessagePort"));
    });
  };

  // `window.postMessage` is not wrapped: the platform takes a message's
  // `source` and `origin` from the script that called it (HTML, "window
  // post message steps": the incumbent settings object), and a wrapper in
  // this realm would become that script for a frame calling `parent.
  // postMessage`. So a message the page posted to itself is told at its
  // delivery, by its `source` being this window, and its task id is minted
  // then, as an input's is (no `TaskReg`).
  orig.addEventListener.call(
    w,
    "message",
    (ev: Event) => {
      if (!ev.isTrusted || !rec.recording) return;
      const m = ev as MessageEvent;
      rec.guard(() => {
        if (m.source !== w) {
          ctx.refuseOnce(
            FOREIGN_MESSAGE,
            `a message at the window from ${m.origin || "an unknown origin"}`,
          );
          return;
        }
        if (m.ports.length > 0) {
          // The ports it carries arrive as new objects whose peers the
          // shim cannot tell (it saw no transfer list), so their messages
          // could not be followed.
          ctx.refuseOnce(
            UNRECORDABLE_MESSAGE,
            "a MessagePort moved through window.postMessage",
          );
        }
        rec.task(rec.nextTaskId(), TaskKind.message);
      });
    },
    { capture: true },
  );

  const OrigChannel = (
    w as unknown as { MessageChannel?: typeof MessageChannel }
  ).MessageChannel;
  const Port = (w as unknown as { MessagePort?: typeof MessagePort })
    .MessagePort;
  if (OrigChannel === undefined || Port === undefined) return;
  const Patched = function MessageChannel(this: unknown): MessageChannel {
    if (new.target === undefined) {
      return (OrigChannel as unknown as () => MessageChannel)();
    }
    const c = Reflect.construct(OrigChannel, [], new.target) as MessageChannel;
    if (rec.recording) {
      rec.guard(() => {
        peers.set(c.port1, c.port2);
        peers.set(c.port2, c.port1);
        listenAtPort(c.port1);
        listenAtPort(c.port2);
      });
    }
    return c;
  };
  asConstructor(Patched, OrigChannel);
  replaceValue(w, "MessageChannel", Patched);
  const origPortPost = Port.prototype.postMessage;
  replaceValue(
    Port.prototype,
    "postMessage",
    function postMessage(this: MessagePort, ...args: unknown[]) {
      const r = (origPortPost as (...a: unknown[]) => void).apply(this, args);
      const peer = peers.get(this);
      if (peer !== undefined && rec.recording) {
        rec.guard(() => post(peer, transferOf(args)));
      }
      return r;
    },
  );
}

/**
 * Listen for the window's `storage` events, first (§10.1): each is a task
 * the browser dispatched, `Task{kind 9}` and its `Input`.
 */
export function listenForStorageEvents(
  ctx: SeamContext,
  areaName: (s: Storage | null) => StorageEventProps["storageArea"],
): void {
  const { w, rec, orig } = ctx;
  orig.addEventListener.call(
    w,
    "storage",
    (ev: Event) => {
      if (!ev.isTrusted || !rec.recording) return;
      const e = ev as StorageEvent;
      rec.guard(() => {
        rec.macrotask();
        const taskId = rec.nextTaskId();
        rec.emit("Task", { task_id: taskId, kind: TaskKind.storageEvent });
        const props: StorageEventProps = {
          key: e.key,
          oldValue: e.oldValue,
          newValue: e.newValue,
          url: e.url,
          storageArea: areaName(storageAreaOf(ctx, e)),
        };
        rec.emit("Input", {
          task_id: taskId,
          type: "storage",
          target: "win",
          props: JSON.stringify(props),
          label: "",
        });
      });
    },
    { capture: true },
  );
}

/** The real storage object a storage event names (its getter is patched to answer the proxy). */
function storageAreaOf(ctx: SeamContext, e: StorageEvent): Storage | null {
  const g = ctx.orig.storageEventArea;
  return g === undefined ? null : (g.descriptor.get!.call(e) as Storage | null);
}

/**
 * Replay of message tasks and storage events (CodeTracer's
 * JS-Boundary-Recording specification §5.2 `Task` kinds 6 and 9, `Input`;
 * §6; §10.1; §10.5).
 *
 * **Messages the page posts to itself** (`window.postMessage` to its own
 * window, `MessagePort.postMessage` on a port of a `MessageChannel` it
 * made). The post goes to the platform as on record, so its checks, its
 * exceptions, its structured clone and its transfers are the platform's; a
 * port post is matched against the log's `TaskReg{kind 6}`, and a window
 * post's `Task{kind 6}`, which has none (its id was minted at its delivery),
 * is claimed when it comes due. The platform's delivery is held: a listener registered before any page code stops the
 * real `message` event before any listener of the page sees it, and an event
 * with its data, origin, source and ports is dispatched as the platform's
 * (`trusted.ts`) when the scheduler releases the post's `Task` (waiting for
 * it if it has not arrived yet). Posts to one receiver arrive in the order
 * made, so a delivery is the oldest held one. A port a post moved is
 * followed to the port the receiver gets, as on record (seams-message.ts).
 *
 * **Storage events.** The replay has no other document, so the platform
 * never fires one; the log's `Task{kind 9}` and its `Input` are claimed here
 * and a `StorageEvent` built from the `Input`'s props is dispatched at the
 * window, its `storageArea` the page's storage object.
 */

import { asConstructor, replaceValue } from "../context.js";
import { TaskKind } from "../recorder.js";
import {
  type StorageEventProps,
  reachesOwnWindow,
  transferOf,
} from "../seams-message.js";
import type { ReplayContext } from "./context.js";

/** Replace every seam this module owns. */
export function replayMessageSeams(ctx: ReplayContext): void {
  const { w, replay, orig } = ctx;
  /** A post not yet delivered: its task, and the page's ports it moved. */
  interface Post {
    taskId: bigint;
    moved: MessagePort[];
  }
  /** What a receiver holds: the deliveries that arrived and wait for a task. */
  interface Inbox {
    arrived: MessageEvent[];
    /** A released task waiting for its delivery to arrive. */
    waiting?: () => void;
  }
  const inboxes = new WeakMap<object, Inbox>();
  const peers = new WeakMap<MessagePort, MessagePort>();
  const inboxOf = (receiver: object): Inbox => {
    let b = inboxes.get(receiver);
    if (b === undefined) {
      b = { arrived: [] };
      inboxes.set(receiver, b);
    }
    return b;
  };

  /** Hand the page the oldest delivery at `receiver`, as the platform's. */
  const release = (receiver: EventTarget, p: Post): void | Promise<void> => {
    const box = inboxOf(receiver);
    const go = () => {
      const ev = box.arrived.shift()!;
      p.moved.forEach((old, i) => {
        const fresh = ev.ports[i];
        const peer = peers.get(old);
        if (fresh === undefined || peer === undefined) return;
        peers.set(fresh, peer);
        peers.set(peer, fresh);
        const b = inboxes.get(old);
        if (b !== undefined) inboxes.set(fresh, b);
        holdAt(fresh);
      });
      // A new event with the platform's data, origin, source and ports (the
      // same objects): the held one may still be being dispatched when its
      // delivery arrives after the task was released, and an event cannot
      // be dispatched twice at once (DOM, "dispatchEvent").
      ctx.trusted.dispatch(
        receiver,
        new w.MessageEvent("message", {
          data: ev.data as unknown,
          origin: ev.origin,
          lastEventId: ev.lastEventId,
          source: ev.source,
          ports: Array.from(ev.ports),
        }),
      );
    };
    if (box.arrived.length > 0) {
      go();
      return;
    }
    return new orig.Promise<void>((resolve) => {
      box.waiting = () => {
        box.waiting = undefined;
        go();
        resolve();
      };
    });
  };

  /** Match a post to `receiver` against the log, and release it at its task. */
  const post = (receiver: EventTarget, transfer: unknown[]) => {
    const id = ctx.nextTaskId();
    replay.registerTask(id, TaskKind.message, 0);
    const p: Post = {
      taskId: id,
      moved: transfer.filter((t): t is MessagePort =>
        peers.has(t as MessagePort),
      ),
    };
    replay.onTask(id, () => {
      replay.offTask(id);
      return release(receiver, p);
    });
  };

  /** Stop the platform's delivery at `receiver` and hold it for its task. */
  const hold = (receiver: object, ev: Event) => {
    if (!ev.isTrusted) return; // the page's own dispatch, as on record
    ev.stopImmediatePropagation();
    const box = inboxOf(receiver);
    box.arrived.push(ev as MessageEvent);
    box.waiting?.();
  };
  const holdAt = (port: MessagePort) =>
    orig.addEventListener.call(port, "message", (ev: Event) => hold(port, ev));

  // A message the page posts to its own window is a task the recorder minted
  // an id for at its delivery (seams-message.ts): the log's `Task{kind 6}`
  // with no `TaskReg`, claimed here. The posts are counted so that a
  // delivery the log has and the replay page never posted is a divergence
  // at once rather than a wait. (Counting wraps `window.postMessage`, which
  // makes a frame's `parent.postMessage` look like the page's own; on
  // record such a message was refused, and the replay ends at that refusal.)
  let windowPosts = 0;
  orig.addEventListener.call(
    w,
    "message",
    (ev: Event) => {
      if ((ev as MessageEvent).source !== w || !ev.isTrusted) return;
      windowPosts = Math.max(0, windowPosts - 1);
      hold(w, ev);
    },
    { capture: true },
  );
  const origPost = w.postMessage;
  replaceValue(
    w,
    "postMessage",
    function postMessage(this: unknown, ...args: unknown[]) {
      const r = (origPost as (...a: unknown[]) => void).apply(this, args);
      if ((this === w || this === undefined) && reachesOwnWindow(w, args[1])) {
        windowPosts++;
      }
      return r;
    },
  );
  replay.onUnregisteredTask(TaskKind.message, (task) => {
    ctx.claimTaskId(task.task_id);
    if (inboxOf(w).arrived.length === 0 && windowPosts === 0) {
      replay.fail(
        "MissingRead",
        "the log delivers a message the page posted to its own window, and the replay page has posted none that is not delivered",
      );
    }
    return release(w, { taskId: task.task_id, moved: [] });
  });

  const OrigChannel = (
    w as unknown as { MessageChannel?: typeof MessageChannel }
  ).MessageChannel;
  const Port = (w as unknown as { MessagePort?: typeof MessagePort })
    .MessagePort;
  if (OrigChannel !== undefined && Port !== undefined) {
    const Patched = function MessageChannel(this: unknown): MessageChannel {
      if (new.target === undefined) {
        return (OrigChannel as unknown as () => MessageChannel)();
      }
      const c = Reflect.construct(
        OrigChannel,
        [],
        new.target,
      ) as MessageChannel;
      peers.set(c.port1, c.port2);
      peers.set(c.port2, c.port1);
      holdAt(c.port1);
      holdAt(c.port2);
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
        if (peer !== undefined) post(peer, transferOf(args));
        return r;
      },
    );
  }

  replayStorageEvents(ctx);
}

/** A storage event from another document (§10.1): `Task{kind 9}` and its `Input`. */
function replayStorageEvents(ctx: ReplayContext): void {
  const { w, replay, orig } = ctx;
  const OrigEvent = orig.StorageEvent;
  replay.onUnregisteredTask(TaskKind.storageEvent, (task) => {
    ctx.claimTaskId(task.task_id);
    const r = replay.next("Input", { task_id: task.task_id, type: "storage" });
    const props = JSON.parse(r.props) as StorageEventProps;
    let area: Storage | null = null;
    if (props.storageArea !== null) {
      const g = orig.storageAreas.get(props.storageArea);
      area = (g?.descriptor.get!.call(w) as Storage | undefined) ?? null;
    }
    if (OrigEvent === undefined) {
      replay.fail("NonReplayable", "this browser has no StorageEvent");
    }
    ctx.trusted.dispatch(
      w,
      new OrigEvent!("storage", {
        key: props.key,
        oldValue: props.oldValue,
        newValue: props.newValue,
        url: props.url,
        storageArea: area,
      }),
    );
  });
}

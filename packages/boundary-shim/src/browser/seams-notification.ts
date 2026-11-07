/**
 * Notifications a page shows (CodeTracer's JS-Boundary-Recording
 * specification §9.3, §10.2, §10.4; the Notifications API,
 * https://notifications.spec.whatwg.org/).
 *
 * A notification the page makes with `new Notification(title, options)` is
 * shown by the visitor's system, which then reports on it with events at the
 * object: `show` once it is displayed, `click` when the visitor activates it,
 * `close` when it goes away (the visitor dismissed it, the system did, or the
 * page's `close()` took effect), and `error` when it cannot be shown (the
 * permission is not granted). Each is a task the browser queues ("fire an
 * event named … on notification"), so each is input: the visitor and their
 * system decide whether and when it happens. A notification is no node, so
 * the window's listeners never see its events: the shim listens on each one
 * as the constructor makes it, before the page can, and records each trusted
 * event as input at target `notification:<n>`, the n-th notification the
 * page made (counting from 1; the page's code makes them in the same order
 * on replay), as `mql:<n>` names a media query list.
 *
 * A notification's `timestamp` defaults to the visitor's clock at its
 * construction, so each read of it is logged (`PlatformValue{src 8}`, query
 * `Notification.timestamp["notification:<n>"]`).
 *
 * The constructor is replaced after the environment seams patched the
 * interface object's statics (`Notification.permission`, `maxActions`,
 * `requestPermission()`), which the replacement inherits.
 */

import { PLATFORM_VALUE_SRC } from "@codetracer/boundary-format";

import {
  type SeamContext,
  asConstructor,
  replaceAccessor,
  replaceValue,
} from "./context.js";
import { recordInput } from "./seams-dom.js";
import { stateJson, stateQuery } from "./seams-environment.js";

/** The events the browser dispatches at a notification. */
export const NOTIFICATION_EVENT_TYPES: readonly string[] = [
  "show",
  "click",
  "close",
  "error",
];

/** The target of the n-th notification the page made (§9.3). */
export function notificationTarget(n: number): string {
  return `notification:${n}`;
}

/** The query of a read of a notification's `timestamp` (src 8). */
export function notificationTimestampQuery(target: string): string {
  return stateQuery("Notification.timestamp", [target]);
}

/**
 * The Notification constructor and its instances' `timestamp`. `onMade`
 * runs for each notification the page makes, with its target; the record and
 * replay sides listen on it there. Returns the target of a notification, or
 * `""` for one the page did not make through the constructor (one a service
 * worker registration's `getNotifications()` handed it).
 */
export function wrapNotificationConstructor(
  w: Window & typeof globalThis,
  onMade: (n: Notification, target: string) => void,
): ((n: unknown) => string) | undefined {
  const Orig = (w as unknown as { Notification?: typeof Notification })
    .Notification;
  if (typeof Orig !== "function") return undefined;
  const targets = new WeakMap<object, string>();
  let made = 0;
  const Patched = function Notification(
    this: unknown,
    ...args: unknown[]
  ): Notification {
    // Called without `new`: the platform's TypeError.
    if (new.target === undefined) {
      return (Orig as unknown as (...a: unknown[]) => Notification)(...args);
    }
    // The platform's argument checks run (and throw) before a target is
    // numbered, as on replay.
    const n = Reflect.construct(Orig, args, new.target) as Notification;
    const target = notificationTarget(++made);
    targets.set(n, target);
    onMade(n, target);
    return n;
  };
  asConstructor(Patched, Orig);
  replaceValue(w, "Notification", Patched);
  return (n) => (typeof n === "object" && n !== null && targets.get(n)) || "";
}

/** Record the page's notifications' events and timestamps (§10.2, §10.4). */
export function patchNotifications(ctx: SeamContext): void {
  const { w, rec, orig } = ctx;
  const Orig = (w as unknown as { Notification?: typeof Notification })
    .Notification;
  const targetOfNotification = wrapNotificationConstructor(w, (n, target) => {
    for (const type of NOTIFICATION_EVENT_TYPES) {
      orig.addEventListener.call(n, type, (ev: Event) => {
        if (!ev.isTrusted || !rec.recording) return;
        rec.guard(() => recordInput(ctx, ev, target));
      });
    }
  });
  if (targetOfNotification === undefined || Orig === undefined) return;
  const d = Object.getOwnPropertyDescriptor(Orig.prototype, "timestamp");
  if (d?.get === undefined) return;
  const get = d.get;
  replaceAccessor(
    Orig.prototype,
    "timestamp",
    function (this: unknown) {
      const v = get.call(this) as unknown;
      rec.guard(() =>
        rec.emit("PlatformValue", {
          src: PLATFORM_VALUE_SRC.platformState,
          task_id: 0n,
          query: notificationTimestampQuery(targetOfNotification(this)),
          value: stateJson(v),
        }),
      );
      return v;
    },
    d.set,
  );
}

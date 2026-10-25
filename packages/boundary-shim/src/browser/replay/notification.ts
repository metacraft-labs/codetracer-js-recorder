/**
 * Replay of the page's notifications (seams-notification.ts; CodeTracer's
 * JS-Boundary-Recording specification §9.3, §10.3, §10.4).
 *
 * The page's notifications are made through the platform's constructor (its
 * argument checks and attributes are the platform's), numbered as on record
 * (`notification:<n>`) for the injector, and the replay browser's own events
 * at them (its system shows, closes or refuses them) never reach the page:
 * the visitor's are injected from the log. Each read of a notification's
 * `timestamp` is answered from the log.
 */

import { PLATFORM_VALUE_SRC } from "@codetracer/boundary-format";

import { replaceAccessor } from "../context.js";
import { jsStackDepth } from "../seams-dom.js";
import { stateValue } from "../seams-environment.js";
import {
  NOTIFICATION_EVENT_TYPES,
  notificationTimestampQuery,
  wrapNotificationConstructor,
} from "../seams-notification.js";
import type { ReplayContext } from "./context.js";

/** Replace the constructor and `timestamp`; call after the environment seams. */
export function replayNotifications(ctx: ReplayContext): void {
  const { w, replay, orig, injection, notifications } = ctx;
  const Orig = (w as unknown as { Notification?: typeof Notification })
    .Notification;
  const targetOfNotification = wrapNotificationConstructor(w, (n, target) => {
    notifications.set(target, n);
    for (const type of NOTIFICATION_EVENT_TYPES) {
      orig.addEventListener.call(n, type, (ev: Event) => {
        // An injected event passes no window listener: its depth is
        // measured here, first on the notification
        // (ReplayContext.injection).
        if (ev === injection.event) {
          injection.depth = jsStackDepth();
          return;
        }
        if (ev.isTrusted) {
          ev.stopImmediatePropagation();
          // A `click`'s default (focusing the page) is the visitor's.
          if (ev.cancelable) ev.preventDefault();
        }
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
      get.call(this); // the platform's receiver check, as on record
      return stateValue(
        replay.next("PlatformValue", {
          src: PLATFORM_VALUE_SRC.platformState,
          task_id: 0n,
          query: notificationTimestampQuery(targetOfNotification(this)),
        }).value,
      );
    },
    d.set,
  );
}

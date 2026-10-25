/**
 * Replay of media elements (CodeTracer's JS-Boundary-Recording
 * specification §5.2 `PlatformValue` src 7, §6, §10.5; the record side is
 * `../seams-media.ts`).
 *
 * The replay browser's media pipeline runs on its own clock: its events are
 * held back and the logged ones dispatched in their place (the runner's
 * runtime does that, as for every resource element's event), so every
 * state the page reads is answered from the log as well. `play()` still
 * reaches the platform (its effect on the element is the platform's
 * business), but the promise the page holds settles when the scheduler
 * releases the platform task's `Task`, as the log says it settled.
 */

import { PLATFORM_VALUE_SRC } from "@codetracer/boundary-format";

import { replaceAccessor, replaceValue } from "../context.js";
import { TaskKind } from "../recorder.js";
import { MEDIA_STATE, mediaQuery } from "../seams-media.js";
import { wrapMethod } from "../seams-platform.js";
import type { ReplayContext } from "./context.js";

type Proto = Record<string, unknown>;

function protoOf(w: ReplayContext["w"], name: string): Proto | undefined {
  return (w as unknown as Record<string, { prototype?: Proto } | undefined>)[
    name
  ]?.prototype;
}

/** A number from its JSON (`seams-media.ts` `mediaJson`). */
function numberOf(v: unknown): number {
  return typeof v === "number" ? v : Number(v);
}

/**
 * A `TimeRanges` holding the logged ranges: an object of that interface
 * whose `length`, `start(i)` and `end(i)` answer as the platform's do
 * (an index out of range throws `IndexSizeError`, HTML "TimeRanges").
 */
function timeRangesOf(ctx: ReplayContext, ranges: unknown): object {
  const { w } = ctx;
  const list = (Array.isArray(ranges) ? ranges : []) as unknown[][];
  const proto = protoOf(w, "TimeRanges") ?? Object.prototype;
  const r = Object.create(proto) as object;
  const at = (i: unknown, k: 0 | 1): number => {
    const n = Number(i);
    if (!Number.isInteger(n) || n < 0 || n >= list.length) {
      throw new w.DOMException(
        `The index provided (${String(i)}) is greater than or equal to the maximum bound (${list.length}).`,
        "IndexSizeError",
      );
    }
    return numberOf(list[n][k]);
  };
  Object.defineProperties(r, {
    length: { value: list.length, enumerable: true },
    start: { value: (i: unknown) => at(i, 0) },
    end: { value: (i: unknown) => at(i, 1) },
  });
  return r;
}

/** A logged `MediaError` (`{code, message}`), or `null`. */
function mediaErrorOf(ctx: ReplayContext, v: unknown): object | null {
  if (v === null || typeof v !== "object") return null;
  const e = Object.create(
    protoOf(ctx.w, "MediaError") ?? Object.prototype,
  ) as object;
  const j = v as { code?: unknown; message?: unknown };
  Object.defineProperties(e, {
    code: { value: j.code, enumerable: true },
    message: { value: String(j.message ?? ""), enumerable: true },
  });
  return e;
}

/** A media state read's logged value, as the page's type. */
function stateOf(ctx: ReplayContext, name: string, json: string): unknown {
  const v = JSON.parse(json) as unknown;
  switch (name) {
    case "buffered":
    case "played":
    case "seekable":
      return timeRangesOf(ctx, v);
    case "error":
      return mediaErrorOf(ctx, v);
    case "currentSrc":
      return String(v);
    case "ended":
    case "muted":
    case "paused":
    case "seeking":
      return v === true;
    default:
      return numberOf(v);
  }
}

/** Replace every seam this module owns. */
export function replayMediaSeams(ctx: ReplayContext): void {
  const { w, replay, orig } = ctx;
  const logged = (query: string, taskId = 0n) =>
    replay.next("PlatformValue", {
      src: PLATFORM_VALUE_SRC.media,
      task_id: taskId,
      query,
    }).value;
  for (const [ctor, names] of MEDIA_STATE) {
    const proto = protoOf(w, ctor);
    if (proto === undefined) continue;
    for (const name of names) {
      const d = Object.getOwnPropertyDescriptor(proto, name);
      if (d?.get === undefined) continue;
      const get = d.get;
      replaceAccessor(
        proto,
        name,
        function (this: unknown) {
          // The platform's getter checks the receiver (and throws for one
          // that is not a media element, as on record).
          get.call(this);
          return stateOf(ctx, name, logged(mediaQuery(name, this)));
        },
        d.set,
      );
    }
  }
  wrapMethod(
    protoOf(w, "HTMLVideoElement"),
    "getVideoPlaybackQuality",
    (original) =>
      function (this: unknown, ...args: unknown[]) {
        original.apply(this, args);
        const j = JSON.parse(
          logged(mediaQuery("getVideoPlaybackQuality", this)),
        ) as Record<string, unknown>;
        const q = Object.create(
          protoOf(w, "VideoPlaybackQuality") ?? Object.prototype,
        ) as object;
        Object.defineProperties(q, {
          creationTime: { value: numberOf(j.creationTime), enumerable: true },
          totalVideoFrames: { value: j.totalVideoFrames, enumerable: true },
          droppedVideoFrames: { value: j.droppedVideoFrames, enumerable: true },
          corruptedVideoFrames: {
            value: j.corruptedVideoFrames,
            enumerable: true,
          },
        });
        return q;
      },
  );
  wrapMethod(
    protoOf(w, "HTMLVideoElement"),
    "requestVideoFrameCallback",
    (original) =>
      function (this: unknown, ...args: unknown[]) {
        // Refused on record (`unrecordable-platform-task`): the replay ends
        // here, before the replay browser could run the callback.
        if (replay.peek().kind === "Refusal") replay.next("Refusal");
        return original.apply(this, args);
      },
  );
  const media = protoOf(w, "HTMLMediaElement");
  const origPlay = media?.play;
  if (media === undefined || typeof origPlay !== "function") return;
  replaceValue(media, "play", function play(this: unknown) {
    const platform = (origPlay as () => Promise<void>).call(this);
    // The replay browser's own outcome is not the visitor's.
    (orig.promiseThen as Promise<void>["then"]).call(
      platform,
      () => undefined,
      () => undefined,
    );
    const query = mediaQuery("play", this);
    const id = ctx.nextTaskId();
    replay.registerTask(id, TaskKind.platform, 0);
    return new orig.Promise<void>((resolve, reject) => {
      replay.onTask(id, () => {
        replay.offTask(id);
        const outcome = JSON.parse(logged(query, id)) as {
          resolved?: boolean;
          rejected?: { name?: string; message?: string };
        };
        if (outcome.rejected === undefined) {
          resolve();
          return;
        }
        reject(
          new w.DOMException(
            String(outcome.rejected.message ?? ""),
            String(outcome.rejected.name ?? "Error"),
          ),
        );
      });
    });
  });
}

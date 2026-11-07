/**
 * Media elements (CodeTracer's JS-Boundary-Recording specification §5.2
 * `PlatformValue` src 7, `DocTask` kind 5, §6, §10.1).
 *
 * A media element's state advances with the network and the decoder: how
 * much is buffered, where playback is, whether it is paused or waiting, how
 * long the media is once its metadata arrived. Its events are logged with
 * the other resource events (`resource-events.ts`, `DocTask` 5); replay
 * dispatches them from the log, since the replay browser's media pipeline
 * cannot be held to the visitor's. So everything the page reads of that
 * state must come from the log too: each read of {@link MEDIA_STATE} is a
 * `PlatformValue` of src 7, with query `<property>["<target>"]` (the
 * element's structural target, §10.2) and the value as {@link mediaJson}
 * writes it.
 *
 * `play()` settles its promise in a task of its own (HTML, "resolve pending
 * play promises" and "reject pending play promises" queue a media element
 * task), with an outcome that depends on the browser's autoplay policy and
 * the media: a platform task (`TaskReg`/`Task` kind 13, §6) whose
 * `PlatformValue` (query `play["<target>"]`) says whether it resolved or how
 * it was rejected.
 *
 * `requestVideoFrameCallback` runs its callback in a task of the rendering
 * steps with frame metadata the shim cannot order exactly, so its first use
 * is refused (`unrecordable-platform-task`, §7.5).
 */

import { PLATFORM_VALUE_SRC } from "@codetracer/boundary-format";

import { type SeamContext, replaceAccessor, replaceValue } from "./context.js";
import { recordPlatformOutcome } from "./seams-environment.js";
import { UNRECORDABLE_PLATFORM_TASK, wrapMethod } from "./seams-platform.js";
import { targetOf } from "./targets.js";

/**
 * The media element state the page reads that the log answers (HTML,
 * "HTMLMediaElement" and "HTMLVideoElement"), by the interface that defines
 * each. `volume`, `muted` and `playbackRate` are there because a user changes
 * them through the element's own controls, which replay cannot reproduce.
 */
export const MEDIA_STATE: readonly (readonly [string, readonly string[]])[] = [
  [
    "HTMLMediaElement",
    [
      "buffered",
      "currentSrc",
      "currentTime",
      "duration",
      "ended",
      "error",
      "muted",
      "networkState",
      "paused",
      "playbackRate",
      "played",
      "readyState",
      "seekable",
      "seeking",
      "volume",
    ],
  ],
  ["HTMLVideoElement", ["videoHeight", "videoWidth"]],
];

/** The query of a media state read or a `play()` of `el` (§10.4). */
export function mediaQuery(name: string, el: unknown): string {
  return `${name}${JSON.stringify([targetOf(el)])}`;
}

/** A number as JSON, the non-finite ones as their names. */
function numberJson(v: number): unknown {
  return Number.isFinite(v) ? v : String(v);
}

/**
 * The JSON of a media state value (§10.4): a number (`NaN`, `Infinity` and
 * `-Infinity` as those strings), a boolean or a string as itself; a
 * `TimeRanges` as `[[start, end], …]`; a `MediaError` as `{code, message}`,
 * or `null`; a `VideoPlaybackQuality` as its four attributes.
 */
export function mediaJson(v: unknown): string {
  if (typeof v === "number") return JSON.stringify(numberJson(v));
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  const ranges = v as TimeRanges;
  if (typeof ranges.length === "number" && typeof ranges.start === "function") {
    const out: unknown[] = [];
    for (let i = 0; i < ranges.length; i++) {
      out.push([numberJson(ranges.start(i)), numberJson(ranges.end(i))]);
    }
    return JSON.stringify(out);
  }
  const error = v as MediaError;
  if (typeof error.code === "number") {
    return JSON.stringify({ code: error.code, message: error.message });
  }
  const q = v as VideoPlaybackQuality;
  return JSON.stringify({
    creationTime: numberJson(q.creationTime),
    totalVideoFrames: q.totalVideoFrames,
    droppedVideoFrames: q.droppedVideoFrames,
    corruptedVideoFrames: q.corruptedVideoFrames,
  });
}

type Proto = Record<string, unknown>;

function protoOf(w: SeamContext["w"], name: string): Proto | undefined {
  return (w as unknown as Record<string, { prototype?: Proto } | undefined>)[
    name
  ]?.prototype;
}

/** Patch every seam this module owns. */
export function patchMediaSeams(ctx: SeamContext): void {
  const { w, rec } = ctx;
  const value = (query: string, json: string, taskId = 0n) =>
    rec.emit("PlatformValue", {
      src: PLATFORM_VALUE_SRC.media,
      task_id: taskId,
      query,
      value: json,
    });
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
          const v = get.call(this) as unknown;
          rec.guard(() => value(mediaQuery(name, this), mediaJson(v)));
          return v;
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
        const q = original.apply(this, args);
        rec.guard(() =>
          value(mediaQuery("getVideoPlaybackQuality", this), mediaJson(q)),
        );
        return q;
      },
  );
  wrapMethod(
    protoOf(w, "HTMLVideoElement"),
    "requestVideoFrameCallback",
    (original) =>
      function (this: unknown, ...args: unknown[]) {
        const handle = original.apply(this, args);
        ctx.refuseOnce(
          UNRECORDABLE_PLATFORM_TASK,
          "HTMLVideoElement.requestVideoFrameCallback",
        );
        return handle;
      },
  );
  const media = protoOf(w, "HTMLMediaElement");
  const origPlay = media?.play;
  if (media === undefined || typeof origPlay !== "function") return;
  replaceValue(media, "play", function play(this: unknown) {
    const settled = (origPlay as () => Promise<void>).call(this);
    return recordPlatformOutcome(
      ctx,
      PLATFORM_VALUE_SRC.media,
      mediaQuery("play", this),
      settled,
      () => true,
    );
  });
}

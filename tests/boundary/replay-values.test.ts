/**
 * Values a page reads that the boundary log holds so that replay gives the
 * page exactly the recorded ones, or ends the replay with a typed refusal
 * where the shim cannot record them (CodeTracer's JS-Boundary-Recording
 * specification §1 and JBR-AREQ3: a replay never yields a silently wrong
 * trace; §5.2; §6; §7.5; §10.5).
 *
 * Each case records `fixtures/values.html?case=<name>` (or a case of
 * `streams.html`) for real, in headless Chromium, against the real fixture
 * server (`harness.ts`, which also serves a redirect, server-sent events and
 * a WebSocket endpoint), with the generic shim installed by the shipped
 * deploy route (`bundle-manifest`, then `boundary-shim --build-hash`). The
 * page writes what it read into the document, so the session's final
 * checkpoint compares it: a replay that gives the page another value ends in
 * `CheckpointMismatch`. The runner (`replaySession`) replays the shim's log
 * against the same build.
 *
 * Each case asserts, in order: that the log holds the value (the vacuity
 * guard: the record side wrote it); that the replay reaches `End` with every
 * checkpoint compared, or ends with the expected typed divergence; and a
 * negative control, the same log with the value changed (for most, to what
 * the replay answered before the log held it), which must diverge where the
 * value reaches the document, so the replay is shown to answer from the log.
 *
 * No mocks: the browser, the server and the runner are real.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type BoundaryRecord,
  type RecordOf,
  PLATFORM_VALUE_SRC,
  WS_FRAME,
} from "../../packages/boundary-format/src/index.js";
import {
  seqAt,
  withRecordReplaced,
  withRecordsSwapped,
} from "../../packages/boundary-replay/src/index.js";
import {
  type Context,
  type Page,
  type RecordReplay,
  expectDiverged,
  expectReplayed,
  indexWhere,
  isReady,
  lastCheckpoint,
  replaced,
  startRecordReplay,
  until,
  utf8,
  withInputsBeforeEnd,
} from "./record-replay.js";

const TIMEOUT = 120_000;

let rr: RecordReplay;

beforeAll(async () => {
  rr = await startRecordReplay();
}, TIMEOUT);

afterAll(async () => {
  await rr?.close();
});

const record = (
  pagePath: string,
  drive?: (page: Page, context: Context) => Promise<void>,
) => rr.record(pagePath, drive);
const replay: RecordReplay["replay"] = (records, options) =>
  rr.replay(records, options);
const tmp = (prefix: string) => rr.tmp(prefix);

describe("replay gives a page the values it read", () => {
  it(
    "replay_gives_a_fetch_response_its_logged_url_redirected_status_text_and_type",
    async () => {
      const rs = await record("values.html?case=fetch-meta");
      const at = indexWhere(rs, "NetResponse", (r) => r.outcome === 5);
      const head = rs[at] as RecordOf<"NetResponse">;
      expect(head.url).toBe(`${rr.server.origin}/api/data?redirected=1`);
      expect([head.redirected, head.status_text, head.response_type]).toEqual([
        1,
        "OK",
        1,
      ]);
      expectReplayed(await replay(rs), rs);
      // What replay answered before the log held them: the request's URL,
      // not redirected, an empty status text.
      const before = replaced<"NetResponse">(rs, at, {
        url: `${rr.server.origin}/api/redirect`,
        redirected: 0,
        status_text: "",
      });
      expectDiverged(
        await replay(before),
        "CheckpointMismatch",
        lastCheckpoint(rs),
      );
    },
    TIMEOUT,
  );

  it(
    "streams_fetch_shape_and_xhr_synthetic_replay_to_end",
    async () => {
      for (const c of ["fetch-shape", "xhr-synthetic"]) {
        const rs = await record(`streams.html?case=${c}`);
        expectReplayed(await replay(rs), rs);
      }
    },
    TIMEOUT,
  );

  it(
    "replay_gives_an_xhr_its_logged_response_url_and_status_text_and_trusted_events",
    async () => {
      const rs = await record("values.html?case=xhr-meta");
      const at = indexWhere(rs, "NetResponse", (r) => r.outcome === 5);
      const head = rs[at] as RecordOf<"NetResponse">;
      expect([head.url, head.status_text]).toEqual([
        `${rr.server.origin}/api/data?redirected=1`,
        "OK",
      ]);
      expectReplayed(await replay(rs), rs);
      const before = replaced<"NetResponse">(rs, at, {
        url: `${rr.server.origin}/api/redirect`,
        status_text: "",
      });
      expectDiverged(
        await replay(before),
        "CheckpointMismatch",
        lastCheckpoint(rs),
      );
    },
    TIMEOUT,
  );

  it(
    "replay_gives_a_websocket_its_logged_protocol_and_message_frame_types",
    async () => {
      const rs = await record("values.html?case=ws-frames");
      const open = indexWhere(rs, "NetResponse", (r) => r.status === 101);
      expect(JSON.parse((rs[open] as RecordOf<"NetResponse">).headers)).toEqual(
        [
          ["sec-websocket-protocol", "chat"],
          ["sec-websocket-extensions", ""],
        ],
      );
      const binary = indexWhere(
        rs,
        "WsMessage",
        (m) => m.dir === 1 && m.frame === WS_FRAME.binary,
      );
      expect(utf8((rs[binary] as RecordOf<"WsMessage">).data)).toBe("bin");
      expect(
        rs.filter((r) => r.record === "WsMessage" && r.dir === 1).length,
      ).toBe(2);
      expectReplayed(await replay(rs), rs);
      // Before: a binary message whose bytes are UTF-8 was delivered as text.
      const asText = replaced<"WsMessage">(rs, binary, {
        frame: WS_FRAME.text,
      });
      expectDiverged(
        await replay(asText),
        "CheckpointMismatch",
        lastCheckpoint(rs),
      );
    },
    TIMEOUT,
  );

  it(
    "replay_dispatches_an_event_stream_message_with_its_logged_type_and_id",
    async () => {
      const rs = await record("values.html?case=sse-named");
      const msgs = rs.filter(
        (r): r is RecordOf<"WsMessage"> =>
          r.record === "WsMessage" && r.dir === 1,
      );
      expect(msgs.map((m) => `${m.event}#${m.last_event_id}`)).toEqual([
        "tick#1",
        "tick#2",
        "tick#3",
      ]);
      expectReplayed(await replay(rs), rs);
      const at = indexWhere(rs, "WsMessage", (m) => m.dir === 1);
      const otherId = replaced<"WsMessage">(rs, at, { last_event_id: "9" });
      expectDiverged(
        await replay(otherId),
        "CheckpointMismatch",
        lastCheckpoint(rs),
      );
    },
    TIMEOUT,
  );

  it(
    "replay_gives_an_idle_deadline_its_logged_time_remaining_and_did_timeout",
    async () => {
      const rs = await record("values.html?case=idle");
      const remaining = indexWhere(rs, "Clock", (c) => c.src === 6);
      indexWhere(
        rs,
        "PlatformValue",
        (v) => v.src === PLATFORM_VALUE_SRC.idleDeadline,
      );
      expectReplayed(await replay(rs), rs);
      // Before: timeRemaining() answered 0. The edit must change the value:
      // a loaded recording's deadline can itself have run out (0), and is
      // then edited to 12.5 ms.
      const recorded = (rs[remaining] as RecordOf<"Clock">).bits;
      const edited = new DataView(new ArrayBuffer(8));
      edited.setFloat64(0, 12.5);
      const zero = replaced<"Clock">(rs, remaining, {
        bits: recorded === 0n ? edited.getBigUint64(0) : 0n,
      });
      expectDiverged(
        await replay(zero),
        "CheckpointMismatch",
        lastCheckpoint(rs),
      );
    },
    TIMEOUT,
  );

  it(
    "replay_gives_observers_their_logged_entries_and_checks_mutation_records",
    async () => {
      const rs = await record("values.html?case=observers");
      const io = indexWhere(
        rs,
        "PlatformValue",
        (v) => v.src === PLATFORM_VALUE_SRC.intersectionObserver,
      );
      indexWhere(
        rs,
        "PlatformValue",
        (v) => v.src === PLATFORM_VALUE_SRC.resizeObserver,
      );
      const mo = indexWhere(
        rs,
        "PlatformValue",
        (v) => v.src === PLATFORM_VALUE_SRC.mutationObserver,
      );
      expectReplayed(await replay(rs), rs);
      // The replay browser's own entries would equal the recorded ones here
      // (same viewport): an edited entry shows the page gets the log's.
      const ioValue = JSON.parse(
        (rs[io] as RecordOf<"PlatformValue">).value,
      ) as Record<string, unknown>[];
      ioValue[0].intersectionRatio = 0.25;
      const edited = replaced<"PlatformValue">(rs, io, {
        value: JSON.stringify(ioValue),
      });
      expectDiverged(
        await replay(edited),
        "CheckpointMismatch",
        lastCheckpoint(rs),
      );
      // Mutation records are compared with the replay's own.
      const moEdited = replaced<"PlatformValue">(rs, mo, { value: "[]" });
      expectDiverged(await replay(moEdited), "ArgumentMismatch", seqAt(rs, mo));
    },
    TIMEOUT,
  );

  it(
    "replay_gives_a_file_input_the_logged_files_and_refuses_their_contents",
    async () => {
      // A file on disk: Playwright then sets it through the browser itself
      // (CDP `DOM.setFileInputFiles`), which dispatches the trusted `input`
      // and `change` a user's choice does; given bytes, it dispatches events
      // of its own, untrusted, which the shim rightly leaves to the page.
      const file = path.join(tmp("ct-values-file-"), "a.txt");
      fs.writeFileSync(file, "hey");
      const choose = async (page: Page) => {
        await until(page, isReady, "the file input");
        await page.setInputFiles("#file", file);
      };
      const rs = await record("values.html?case=files", choose);
      const at = indexWhere(rs, "DomEffect", (e) => e.effect === 6);
      const files = JSON.parse((rs[at] as RecordOf<"DomEffect">).value) as {
        name: string;
        size: number;
        lastModified: number;
      }[];
      expect(files.map((f) => `${f.name}:${f.size}`)).toEqual(["a.txt:3"]);
      expect(files[0].lastModified).toBeGreaterThan(0);
      expectReplayed(await replay(rs), rs);
      // Every files effect (the input's and the change's) renamed.
      const renamed = JSON.stringify(
        files.map((f) => ({ ...f, name: "b.txt" })),
      );
      const edited = rs.map((r) =>
        r.record === "DomEffect" && r.effect === 6
          ? { ...r, value: renamed }
          : r,
      );
      expectDiverged(
        await replay(edited),
        "CheckpointMismatch",
        lastCheckpoint(rs),
      );

      // Reading the contents is refused before it runs, and the replay ends
      // there rather than give the page other bytes.
      const read = await record("values.html?case=files&read=1", choose);
      const refusal = indexWhere(
        read,
        "Refusal",
        (r) => r.feature === "file-content",
      );
      expectDiverged(await replay(read), "NonReplayable", seqAt(read, refusal));

      // So is an object URL for one, through which the page could read the
      // contents out of the shim's sight.
      const url = await record("values.html?case=files&read=url", choose);
      const urlRefusal = indexWhere(
        url,
        "Refusal",
        (r) => r.feature === "file-content",
      );
      expect((url[urlRefusal] as RecordOf<"Refusal">).detail).toContain(
        "createObjectURL",
      );
      expectDiverged(
        await replay(url),
        "NonReplayable",
        seqAt(url, urlRefusal),
      );
    },
    TIMEOUT,
  );

  it(
    "replay_gives_a_file_input_a_large_file_without_allocating_its_size",
    async () => {
      // A user may choose a file of gigabytes (a video for an upload form);
      // the page reads its size, and replay must hand it a file of that size
      // without holding that many bytes. The file is sparse on disk, and the
      // record side reads only its metadata.
      const file = path.join(tmp("ct-values-big-"), "big.bin");
      const size = 3 * 1024 ** 3 + 5;
      fs.closeSync(fs.openSync(file, "w"));
      fs.truncateSync(file, size);
      const rs = await record("values.html?case=files", async (page) => {
        await until(page, isReady, "the file input");
        await page.setInputFiles("#file", file);
      });
      const at = indexWhere(rs, "DomEffect", (e) => e.effect === 6);
      const files = JSON.parse((rs[at] as RecordOf<"DomEffect">).value) as {
        size: number;
      }[];
      expect(files.map((f) => f.size)).toEqual([size]);
      expectReplayed(await replay(rs), rs);
    },
    TIMEOUT,
  );

  it(
    "replay_ends_at_the_platform_tasks_and_messages_the_shim_refuses",
    async () => {
      // Each seam the shim cannot order exactly writes its Refusal when the
      // page uses it (the page keeps working), and the replay ends there as
      // NonReplayable instead of replaying it in the replay browser's order.
      const cases: [string, string, string][] = [
        ["stream", "unrecordable-platform-task", "Blob.stream"],
        ["reader", "unrecordable-platform-task", "FileReader.readAsText"],
        ["subtle", "unrecordable-platform-task", "crypto.subtle.generateKey"],
        ["port", "unrecordable-message", "window.postMessage"],
        ["canvas", "canvas-readback", "CanvasRenderingContext2D.getImageData"],
        ["clipboard", "clipboard-content", "navigator.clipboard.readText"],
        ["caches", "cache-storage", "caches.open"],
        [
          "permissions",
          "unrecordable-platform-task",
          "navigator.permissions.query",
        ],
        ["fonts-event", "unrecordable-platform-task", "document.fonts loading"],
        ["battery", "unrecordable-platform-task", "navigator.getBattery"],
        [
          "geolocation",
          "geolocation",
          "navigator.geolocation.getCurrentPosition",
        ],
        ["user-media", "media-capture", "navigator.mediaDevices.getUserMedia"],
        [
          "display-media",
          "media-capture",
          "navigator.mediaDevices.getDisplayMedia",
        ],
        [
          "watch-position",
          "geolocation",
          "navigator.geolocation.watchPosition",
        ],
      ];
      for (const [use, feature, detail] of cases) {
        const rs = await record(`values.html?case=refused&use=${use}`);
        const refusals = rs.filter(
          (r): r is RecordOf<"Refusal"> => r.record === "Refusal",
        );
        expect(
          refusals.map((r) => r.feature),
          use,
        ).toEqual([feature]);
        expect(refusals[0].detail, use).toContain(detail);
        expectDiverged(
          await replay(rs),
          "NonReplayable",
          seqAt(
            rs,
            rs.findIndex((r) => r.record === "Refusal"),
          ),
        );
      }
    },
    TIMEOUT,
  );

  it(
    "the_shim_listens_for_devicechange_at_the_media_devices_before_the_page",
    async () => {
      // A `devicechange` reaching a listener of the page is refused by the
      // mechanism the font set's `loading` exercises above (the
      // `fonts-event` case: the shim's own listener at the object, added
      // before any page code, refuses a trusted event when the page listens
      // there). Headless Chromium never dispatches `devicechange`: measured
      // with Playwright 1.56.1's Chromium 141, neither getUserMedia()
      // succeeding with --use-fake-device-for-media-stream (with and without
      // --use-fake-ui-for-media-stream) nor granting and clearing the camera
      // and microphone permissions (context.grantPermissions,
      // clearPermissions, CDP Browser.setPermission) fired one, and CDP has
      // no command that changes the media devices. So this checks the part
      // that is particular to it, that the shim listens there: the media
      // devices object carries the shim's `devicechange` listener (and the
      // font set its `loading` one, the control) while the page added none.
      let listeners: { type: string }[] = [];
      let control: { type: string }[] = [];
      await rr.recordPage("values.html?case=lifecycle", async (page) => {
        const p = page as unknown as {
          context(): {
            newCDPSession(p: unknown): Promise<{
              send(m: string, a?: object): Promise<unknown>;
            }>;
          };
        };
        const cdp = await p.context().newCDPSession(page);
        const of = async (expression: string) => {
          const { result } = (await cdp.send("Runtime.evaluate", {
            expression,
          })) as { result: { objectId: string } };
          const got = (await cdp.send("DOMDebugger.getEventListeners", {
            objectId: result.objectId,
          })) as { listeners: { type: string }[] };
          return got.listeners;
        };
        listeners = await of("navigator.mediaDevices");
        control = await of("document.fonts");
      });
      expect(control.map((l) => l.type)).toContain("loading");
      expect(listeners.map((l) => l.type)).toEqual(["devicechange"]);
    },
    TIMEOUT,
  );

  it(
    "replay_gives_a_page_the_logged_platform_state",
    async () => {
      // Recorded from a page reached with a referrer, as a visitor's is.
      const referrer = "https://search.example/?q=boundary";
      const rs = await record("values.html?case=url", async (page) => {
        await page.goto(`${rr.server.origin}/values.html?case=state`, {
          referer: referrer,
        });
      });
      const states = rs
        .map((r, i) => [r, i] as const)
        .filter(
          ([r]) =>
            r.record === "PlatformValue" &&
            r.src === PLATFORM_VALUE_SRC.platformState,
        ) as (readonly [RecordOf<"PlatformValue">, number])[];
      const queries = states.map(([r]) => r.query);
      // Vacuity guard: every read the page made is in the log.
      for (const q of [
        "document.referrer",
        "navigator.onLine",
        "navigator.connection.effectiveType",
        "navigator.userAgent",
        "navigator.webdriver",
        "navigator.languages",
        "navigator.hardwareConcurrency",
        "screen.width",
        "screen.orientation.type",
        "performance.memory.jsHeapSizeLimit",
        "performance.eventCounts.size",
        'performance.eventCounts.get["click"]',
        "performance.eventCounts.keys",
        "performance.eventCounts.forEach",
        "document.fonts.status",
        'document.fonts.check["12px serif"," "]',
        'measureText["13px sans-serif","boundary"]',
        "WebSocket.bufferedAmount[1]",
      ]) {
        expect(queries, q).toContain(q);
      }
      const at = (q: string) => states.find(([r]) => r.query === q)!;
      expect(JSON.parse(at("document.referrer")[0].value)).toBe(referrer);
      expect(
        Number(JSON.parse(at("WebSocket.bufferedAmount[1]")[0].value)),
      ).toBeGreaterThan(0);
      expectReplayed(await replay(rs), rs);
      // Each value, changed in the log, reaches the page as changed: the
      // page wrote every one into the document, so the final checkpoint
      // differs.
      for (const [r, i] of states) {
        expectDiverged(
          await replay(
            replaced<"PlatformValue">(rs, i, { value: perturb(r.value) }),
          ),
          "CheckpointMismatch",
          lastCheckpoint(rs),
        );
      }
    },
    TIMEOUT * 4,
  );

  it(
    "replay_settles_platform_promises_with_their_logged_outcomes_in_logged_order",
    async () => {
      const rs = await record("values.html?case=promises");
      const outcomes = rs
        .map((r, i) => [r, i] as const)
        .filter(
          ([r]) =>
            r.record === "PlatformValue" &&
            r.src === PLATFORM_VALUE_SRC.platformOutcome,
        ) as (readonly [RecordOf<"PlatformValue">, number])[];
      // Vacuity guard: every promise's outcome is in the log, after its Task.
      expect(outcomes.map(([r]) => r.query).sort()).toEqual(
        [
          'FontFace.load["ct-missing"]',
          'HTMLImageElement.decode["path:~img"]',
          "createImageBitmap",
          "document.fonts.load",
          "document.fonts.ready",
          "navigator.clipboard.writeText",
          "navigator.storage.estimate",
          "navigator.storage.persisted",
          "navigator.userAgentData.getHighEntropyValues",
        ].sort(),
      );
      for (const [r, i] of outcomes) {
        const task = rs[i - 1];
        expect(
          task.record === "Task" && task.task_id === r.task_id,
          r.query,
        ).toBe(true);
      }
      // Both kinds of outcome are exercised.
      expect(outcomes.some(([r]) => r.value.startsWith('{"rejected"'))).toBe(
        true,
      );
      expect(outcomes.some(([r]) => r.value.startsWith('{"resolved"'))).toBe(
        true,
      );
      expectReplayed(await replay(rs), rs);
      for (const [r, i] of outcomes) {
        const changed = replaced<"PlatformValue">(rs, i, {
          // The faces `document.fonts.load` resolved with are places in the
          // set; changed, it rejects instead (a face the set does not have
          // is checked below).
          value:
            r.query === "document.fonts.load"
              ? JSON.stringify({
                  rejected: {
                    name: "AbortError",
                    message: "",
                    type: "DOMException",
                  },
                })
              : perturbOutcome(r.value),
        });
        // A bitmap is the replay browser's own, checked against the log
        // where the log has its outcome; every other outcome is the log's
        // and reaches the document.
        if (r.query === "createImageBitmap") {
          expectDiverged(
            await replay(changed),
            "ArgumentMismatch",
            seqAt(rs, i),
          );
        } else {
          expectDiverged(
            await replay(changed),
            "CheckpointMismatch",
            lastCheckpoint(rs),
          );
        }
      }
      // A face the replayed set does not have is a typed divergence where
      // the page would get it.
      const fontsLoad = outcomes.find(
        ([r]) => r.query === "document.fonts.load",
      )!;
      expectDiverged(
        await replay(
          replaced<"PlatformValue">(rs, fontsLoad[1], {
            value: JSON.stringify({ resolved: [7] }),
          }),
        ),
        "ArgumentMismatch",
        seqAt(rs, fontsLoad[1]),
      );
      // Two platform tasks released in the other order: the first released
      // task reads its outcome where the log has the other's, and the task
      // ids differ there.
      const tasks = rs
        .map((r, i) => [r, i] as const)
        .filter(([r]) => r.record === "Task" && r.kind === 13);
      expectDiverged(
        await replay(withRecordsSwapped(rs, tasks[0][1], tasks[1][1])),
        "ArgumentMismatch",
        seqAt(rs, tasks[0][1] + 1),
      );
    },
    TIMEOUT * 4,
  );

  it(
    "replay_dispatches_online_and_offline_from_the_log",
    async () => {
      const rs = await record(
        "values.html?case=online",
        async (page, context) => {
          await until(page, isReady, "the online case to listen");
          await context.setOffline(true);
          await new Promise((r) => setTimeout(r, 200));
          await context.setOffline(false);
        },
      );
      const inputs = rs.filter(
        (r): r is RecordOf<"Input"> =>
          r.record === "Input" && (r.type === "online" || r.type === "offline"),
      );
      expect(inputs.map((r) => `${r.type}@${r.target}`)).toEqual([
        "offline@win",
        "online@win",
      ]);
      const onLine = indexWhere(
        rs,
        "PlatformValue",
        (r) => r.query === "navigator.onLine",
      );
      expect(rs[onLine]).toMatchObject({ value: "false" });
      expectReplayed(await replay(rs), rs);
      expectDiverged(
        await replay(replaced<"PlatformValue">(rs, onLine, { value: "true" })),
        "CheckpointMismatch",
        lastCheckpoint(rs),
      );
    },
    TIMEOUT,
  );

  it(
    "replay_dispatches_resize_and_media_query_changes_and_answers_the_viewport",
    async () => {
      const { records: rs, slots } = await rr.recordPage(
        "values.html?case=viewport",
        async (page) => {
          await until(page, isReady, "the viewport case to listen");
          await (
            page as unknown as {
              setViewportSize(s: {
                width: number;
                height: number;
              }): Promise<void>;
            }
          ).setViewportSize({ width: 400, height: 300 });
        },
      );
      // (The pointer, now over another element, also writes its pointer and
      // mouse events.)
      const inputs = rs.filter(
        (r): r is RecordOf<"Input"> =>
          r.record === "Input" && (r.type === "resize" || r.type === "change"),
      );
      // The window's resize, the visual viewport's, and both lists of the
      // query that flipped (the third list's did not), each at its target.
      expect(inputs.map((r) => `${r.type}@${r.target}`).sort()).toEqual(
        [
          "change@mql:1",
          "change@mql:2",
          "resize@visualViewport",
          "resize@win",
        ].sort(),
      );
      const change = inputs.find((r) => r.target === "mql:1")!;
      expect(JSON.parse(change.props)).toEqual({
        matches: true,
        media: "(max-width: 500px)",
      });
      const seen = slots.find((s) => s.startsWith("seen="))!;
      expect(seen).toContain("resize:400x300:true:true");
      expect(seen).toContain("narrow:true:(max-width: 500px):true");
      expect(seen).toContain("narrow2:true:true");
      // Every read of the window's geometry and of a list's `matches` is in
      // the log.
      const layout = rs
        .map((r, i) => [r, i] as const)
        .filter(([r]) => r.record === "LayoutRead") as (readonly [
        RecordOf<"LayoutRead">,
        number,
      ])[];
      const props = new Set(layout.map(([r]) => r.prop));
      for (const p of [
        "innerWidth",
        "innerHeight",
        "outerWidth",
        "devicePixelRatio",
        "scrollY",
        "matchMedia:(max-width: 500px)",
        "matchMedia:(min-width: 5000px)",
      ]) {
        expect(props, p).toContain(p);
      }
      expect(layout.every(([r]) => r.target === "win")).toBe(true);
      expectReplayed(await replay(rs), rs);
      // Each read, changed in the log, reaches the page as changed.
      for (const [r, i] of layout) {
        expectDiverged(
          await replay(
            replaced<"LayoutRead">(rs, i, { value: perturb(r.value) }),
          ),
          "CheckpointMismatch",
          lastCheckpoint(rs),
        );
      }
      // A change injected at another list reaches that list's listeners,
      // not the first list's, whose read of `matches` is then never made.
      const at = rs.indexOf(change);
      expect(rs[at + 1]).toMatchObject({
        record: "LayoutRead",
        prop: "matchMedia:(max-width: 500px)",
      });
      expectDiverged(
        await replay(replaced<"Input">(rs, at, { target: "mql:3" })),
        "MissingRead",
        seqAt(rs, at + 1),
      );
      // A list the page never made is a typed divergence.
      expectDiverged(
        await replay(replaced<"Input">(rs, at, { target: "mql:9" })),
        "InjectionFailed",
        seqAt(rs, at),
      );
    },
    TIMEOUT * 4,
  );

  it(
    "replay_dispatches_visibility_lifecycle_and_language_events_from_the_log",
    async () => {
      // `pageshow` runs in the document's load, on record and on replay.
      const { records: rs, slots } = await rr.recordPage(
        "values.html?case=lifecycle",
      );
      expect(slots).toContain("pageshow=false:true");
      expect(slots).toContain("state=visible,false,false");
      // Headless Chromium never hides, freezes or resumes a page, nor
      // changes its languages (measured with Playwright 1.56.1's Chromium:
      // CDP Page.setWebLifecycleState, Target.activateTarget,
      // Browser.setWindowBounds minimized, Emulation.setUserAgentOverride's
      // acceptLanguage and Emulation.setLocaleOverride each left the page
      // visible and fired nothing), so the inputs and the reads their
      // listeners make are written into the recording, as the shim writes
      // them. Each listener reads only the state its event reports, so the
      // replay must dispatch each event at its target for its reads to
      // happen, read by read.
      const visibility = {
        type: "visibilitychange",
        target: "doc",
        reads: [
          ["document.visibilityState", '"hidden"'],
          ["document.hidden", "true"],
        ] as [string, string][],
      };
      const lifecycle = [
        visibility,
        {
          type: "freeze",
          target: "doc",
          reads: [["document.visibilityState", '"hidden"']] as [
            string,
            string,
          ][],
        },
        {
          type: "resume",
          target: "doc",
          reads: [["document.wasDiscarded", "false"]] as [string, string][],
        },
        {
          type: "languagechange",
          target: "win",
          reads: [["navigator.language", '"de-DE"']] as [string, string][],
        },
      ];
      const written = withInputsBeforeEnd(rs, lifecycle);
      expectReplayed(await replay(written), written);
      // The written read of `query`: the first after the written input.
      const writtenRead = (log: BoundaryRecord[], query: string) => {
        const input = log.map((r) => r.record).lastIndexOf("Input");
        return log.findIndex(
          (r, i) =>
            i > input && r.record === "PlatformValue" && r.query === query,
        );
      };
      // Visible: the listener does not read `hidden`, which the log has.
      const visible = withInputsBeforeEnd(rs, [
        {
          ...visibility,
          reads: [
            ["document.visibilityState", '"visible"'],
            ["document.hidden", "true"],
          ],
        },
      ]);
      expectDiverged(
        await replay(visible),
        "MissingRead",
        seqAt(visible, writtenRead(visible, "document.hidden")),
      );
      // Each event at the wrong target reaches no listener: its first read
      // is never made.
      for (const [input, wrong] of [
        [lifecycle[0], "win"],
        [lifecycle[1], "win"],
        [lifecycle[2], "win"],
        [lifecycle[3], "doc"],
      ] as const) {
        const misplaced = withInputsBeforeEnd(rs, [
          { ...input, target: wrong },
        ]);
        expectDiverged(
          await replay(misplaced),
          "MissingRead",
          seqAt(misplaced, writtenRead(misplaced, input.reads[0][0])),
        );
      }
    },
    TIMEOUT * 2,
  );

  it(
    "a_focus_the_page_moves_itself_is_its_own_and_replays_inside_its_task",
    async () => {
      const { records: rs, slots } = await rr.recordPage(
        "values.html?case=script-focus",
      );
      expect(slots).toContain("seen=before focus:true:true after:true");
      // Not input: the page's own call dispatched them, in its task.
      expect(
        rs.filter((r) => r.record === "Input" && /^focus|^blur/.test(r.type)),
      ).toEqual([]);
      // The listener's read is in the timer's task, where replay's page
      // code makes it again.
      const timer = indexWhere(rs, "Task", (r) => r.kind === 1);
      const clock = indexWhere(rs, "Clock", () => true, 0);
      expect(clock).toBeGreaterThan(timer);
      expectReplayed(await replay(rs), rs);
    },
    TIMEOUT,
  );

  it(
    "events_the_page_listener_of_an_injected_click_causes_reach_it_inside_the_click",
    async () => {
      const { records: rs, slots } = await rr.recordPage(
        "values.html?case=click-focus",
        async (page) => {
          await until(page, isReady, "the click-focus case to listen");
          await page.click("#go");
        },
      );
      expect(slots).toContain(
        "seen=click focus:true:true change:true:true after:true",
      );
      // The user's click is input (and the focus its mousedown gives the
      // button); the field's focus and the checkbox's change the page's
      // listener caused are not.
      const inputs = rs
        .filter((r): r is RecordOf<"Input"> => r.record === "Input")
        .map((r) => `${r.type}@${r.target}`);
      expect(inputs).toContain("click@path:#go");
      expect(inputs.filter((i) => /@path:#(field|box2)$/.test(i))).toEqual([]);
      expectReplayed(await replay(rs), rs);
    },
    TIMEOUT,
  );

  it(
    "a_focus_the_page_moves_in_a_listener_of_a_list_or_the_visual_viewport_reaches_it",
    async () => {
      // The injected `change` at a list and `resize` at the visual viewport
      // never pass the window, where replay measures the depth of an
      // injected event's listeners; the page's own `focus()` in their
      // listeners must still reach the page, as on record.
      const { records: rs, slots } = await rr.recordPage(
        "values.html?case=viewport-focus",
        async (page) => {
          await until(page, isReady, "the viewport-focus case to listen");
          await (
            page as unknown as {
              setViewportSize(s: {
                width: number;
                height: number;
              }): Promise<void>;
            }
          ).setViewportSize({ width: 400, height: 300 });
        },
      );
      const seen = slots.find((s) => s.startsWith("seen="))!;
      expect(seen).toContain("change focus:byList:true:true");
      expect(seen).toContain("vv focus:byViewport:true:true");
      const inputs = rs
        .filter((r): r is RecordOf<"Input"> => r.record === "Input")
        .map((r) => `${r.type}@${r.target}`);
      // The list's and the viewport's events are input; the focus the
      // page's listeners moved is not.
      expect(inputs).toContain("change@mql:1");
      expect(inputs).toContain("resize@visualViewport");
      expect(inputs.filter((i) => /@path:#by(List|Viewport)$/.test(i))).toEqual(
        [],
      );
      expectReplayed(await replay(rs), rs);
    },
    TIMEOUT,
  );

  it(
    "replay_dispatches_a_notifications_events_at_it_and_answers_its_timestamp",
    async () => {
      // Refused by the visitor's system: a real `error` at each.
      const { records: rs, slots } = await rr.recordPage(
        "values.html?case=notification",
      );
      expect(slots).toContain("errors=first:true second:true:denied");
      const inputs = rs
        .filter((r): r is RecordOf<"Input"> => r.record === "Input")
        .filter((r) => r.target.startsWith("notification:"))
        .map((r) => `${r.type}@${r.target}`);
      expect(inputs.sort()).toEqual([
        "error@notification:1",
        "error@notification:2",
      ]);
      // The second notification's timestamp is the page's own, logged under
      // its own target.
      expect(
        rs.some(
          (r) =>
            r.record === "PlatformValue" &&
            r.query === 'Notification.timestamp["notification:2"]' &&
            r.value === "7",
        ),
      ).toBe(true);
      expectReplayed(await replay(rs), rs);
      // The visitor's clock and actions, changed in the log, reach the page
      // as changed.
      for (const query of [
        'Notification.timestamp["notification:1"]',
        "Notification.maxActions",
      ]) {
        const at = indexWhere(rs, "PlatformValue", (r) => r.query === query);
        expectDiverged(
          await replay(
            replaced<"PlatformValue">(rs, at, {
              value: perturb((rs[at] as RecordOf<"PlatformValue">).value),
            }),
          ),
          "CheckpointMismatch",
          lastCheckpoint(rs),
        );
      }
      // A notification the page never made is a typed divergence.
      const first = indexWhere(
        rs,
        "Input",
        (r) => r.target === "notification:1",
      );
      expectDiverged(
        await replay(
          replaced<"Input">(rs, first, { target: "notification:9" }),
        ),
        "InjectionFailed",
        seqAt(rs, first),
      );
      // The visitor's system showing and closing the first, and the visitor
      // clicking it, written into the recording: replay dispatches each at
      // the first notification, whose listener makes the event's read.
      const events = [
        {
          type: "show",
          target: "notification:1",
          reads: [["Notification.permission", '"granted"']] as [
            string,
            string,
          ][],
        },
        {
          type: "click",
          target: "notification:1",
          reads: [['Notification.timestamp["notification:1"]', "123"]] as [
            string,
            string,
          ][],
        },
        {
          type: "close",
          target: "notification:1",
          reads: [["Notification.maxActions", "2"]] as [string, string][],
        },
      ];
      const written = withInputsBeforeEnd(rs, events);
      expectReplayed(await replay(written), written);
      // Each at the second notification reaches no listener of its: its
      // read is never made.
      for (const event of events) {
        const misplaced = withInputsBeforeEnd(rs, [
          { ...event, target: "notification:2" },
        ]);
        const input = misplaced.map((r) => r.record).lastIndexOf("Input");
        expectDiverged(
          await replay(misplaced),
          "MissingRead",
          seqAt(misplaced, input + 1),
        );
      }
    },
    TIMEOUT * 2,
  );

  it(
    "input_is_told_from_the_page_events_when_the_page_replaced_the_global_error",
    async () => {
      const { records: rs, slots } = await rr.recordPage(
        "values.html?case=error-replaced",
        async (page) => {
          await until(page, isReady, "the error-replaced case to listen");
          await page.click("#err");
        },
      );
      expect(slots).toContain("clicked=true");
      const inputs = rs
        .filter((r): r is RecordOf<"Input"> => r.record === "Input")
        .map((r) => `${r.type}@${r.target}`);
      expect(inputs).toContain("click@path:#err");
      expect(inputs).not.toContain("focus@path:#errfield");
      expectReplayed(await replay(rs), rs);
    },
    TIMEOUT,
  );

  it(
    "a_click_the_browser_forwards_from_a_label_reaches_the_page_once_on_replay",
    async () => {
      const { records: rs, slots } = await rr.recordPage(
        "values.html?case=label-click",
        async (page) => {
          await until(page, isReady, "the label-click case to listen");
          await page.click("#lab", { position: { x: 2, y: 2 } } as never);
        },
      );
      expect(slots).toContain("clicks=1");
      expect(slots).toContain("box=1:true");
      const inputs = rs
        .filter((r): r is RecordOf<"Input"> => r.record === "Input")
        .map((r) => `${r.type}@${r.target}`);
      expect(inputs).toContain("click@path:#lab");
      expect(inputs).toContain("click@path:#labbox");
      expectReplayed(await replay(rs), rs);
    },
    TIMEOUT,
  );

  it(
    "a_focus_the_user_gave_reaches_the_page_once_on_replay",
    async () => {
      const { records: rs, slots } = await rr.recordPage(
        "values.html?case=user-focus",
        async (page) => {
          await until(page, isReady, "the user-focus case to listen");
          await page.click("#typed");
        },
      );
      expect(slots).toContain("focused=1");
      const at = indexWhere(
        rs,
        "Input",
        (r) => r.type === "focus" && r.target === "path:#typed",
      );
      // Its focus effect precedes it: replay applies it (`focus()`, whose
      // own trusted `focus` is replay's and reaches no listener), then
      // injects the recorded event.
      expect(rs[at - 2]).toMatchObject({ record: "DomEffect", effect: 5 });
      expectReplayed(await replay(rs), rs);
    },
    TIMEOUT,
  );

  it(
    "a_media_elements_own_resize_is_a_resource_event_not_input",
    async () => {
      const rs = await record("values.html?case=media-resize");
      // Vacuity guard: the video's resize reached the page, as a resource
      // event of the document.
      expect(
        rs.some(
          (r) =>
            r.record === "DocTask" &&
            r.kind === 5 &&
            r.event === "resize" &&
            r.target === "path:#vid",
        ),
      ).toBe(true);
      // Only the window's `resize` is input.
      expect(
        rs.filter((r) => r.record === "Input" && r.type === "resize"),
      ).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    "replay_dispatches_a_beforeunload_the_user_started",
    async () => {
      const { records: rs, slots } = await rr.recordPage(
        "values.html?case=beforeunload",
        async (page) => {
          await until(page, isReady, "the beforeunload case to listen");
          const p = page as unknown as {
            mouse: { click(x: number, y: number): Promise<void> };
            on(e: "dialog", f: (d: { dismiss(): Promise<void> }) => void): void;
            close(o: { runBeforeUnload: boolean }): Promise<void>;
          };
          // The page may ask to stay only after the user interacted with
          // it (HTML, "sticky activation"); the dialog is dismissed, so the
          // page stays.
          await p.mouse.click(2, 2);
          p.on("dialog", (d) => void d.dismiss());
          await p.close({ runBeforeUnload: true });
        },
      );
      expect(slots).toContain("beforeunload=true:true:true");
      const at = indexWhere(rs, "Input", (r) => r.type === "beforeunload");
      expect((rs[at] as RecordOf<"Input">).target).toBe("win");
      expectReplayed(await replay(rs), rs);
      // Another event in its place reaches no beforeunload listener.
      expectDiverged(
        await replay(replaced<"Input">(rs, at, { type: "languagechange" })),
        "MissingRead",
        seqAt(rs, at + 1),
      );
    },
    TIMEOUT,
  );

  it(
    "replay_dispatches_the_window_focus_and_blur_and_answers_has_focus",
    async () => {
      const { records: rs, slots } = await rr.recordPage(
        "values.html?case=focus",
        async (page) => {
          await until(page, isReady, "the focus case to listen");
          // Native clicks: into the frame (fixed at 0,300 200x100), then
          // back on the page.
          const mouse = (
            page as unknown as {
              mouse: { click(x: number, y: number): Promise<void> };
            }
          ).mouse;
          await mouse.click(50, 350);
          await mouse.click(2, 2);
        },
      );
      const inputs = rs.filter(
        (r): r is RecordOf<"Input"> =>
          r.record === "Input" && (r.type === "blur" || r.type === "focus"),
      );
      expect(inputs.map((r) => `${r.type}@${r.target}`)).toEqual([
        "blur@win",
        "focus@win",
      ]);
      expect(slots).toContain("seen=blur:true focus:true");
      const reads = rs
        .map((r, i) => [r, i] as const)
        .filter(
          ([r]) =>
            r.record === "PlatformValue" && r.query === "document.hasFocus",
        );
      expect(reads.length).toBe(3);
      expectReplayed(await replay(rs), rs);
      for (const [r, i] of reads) {
        expectDiverged(
          await replay(
            replaced<"PlatformValue">(rs, i, {
              value: perturb((r as RecordOf<"PlatformValue">).value),
            }),
          ),
          "CheckpointMismatch",
          lastCheckpoint(rs),
        );
      }
    },
    TIMEOUT * 2,
  );

  it(
    "replay_gives_a_page_the_logged_permission_device_and_focus_state",
    async () => {
      const { records: rs, slots } = await rr.recordPage(
        "values.html?case=device",
      );
      const values = rs
        .map((r, i) => [r, i] as const)
        .filter(
          ([r]) =>
            r.record === "PlatformValue" &&
            (r.src === PLATFORM_VALUE_SRC.platformState ||
              r.src === PLATFORM_VALUE_SRC.platformOutcome),
        ) as (readonly [RecordOf<"PlatformValue">, number])[];
      // Vacuity guard: every read and promise is in the log.
      expect(values.map(([r]) => r.query).sort()).toEqual(
        [
          "Notification.permission",
          "document.hasFocus",
          "document.visibilityState",
          "document.hidden",
          "document.wasDiscarded",
          "navigator.userActivation.isActive",
          "navigator.userActivation.hasBeenActive",
          "visualViewport.scale",
          "visualViewport.offsetTop",
          "document.hasStorageAccess",
          "document.requestStorageAccess",
          "navigator.mediaDevices.enumerateDevices",
          "Notification.requestPermission",
        ].sort(),
      );
      // The legacy callback runs before the promise's continuation.
      const order = slots.find((s) => s.startsWith("order="))!;
      expect(order.indexOf("callback:")).toBeLessThan(
        order.indexOf("permission:"),
      );
      expectReplayed(await replay(rs), rs);
      // Each value, changed in the log, reaches the page as changed: where
      // it writes it into the document, or, for the devices, at the storage
      // read it names them in (the next test).
      const devicesRead = indexWhere(rs, "StorageRead", (r) =>
        r.key.startsWith("devices:"),
      );
      for (const [r, i] of values) {
        const changed =
          r.src === PLATFORM_VALUE_SRC.platformOutcome
            ? perturbOutcome(r.value)
            : perturb(r.value);
        const devices =
          r.query === "navigator.mediaDevices.enumerateDevices" &&
          changed.startsWith('{"resolved"');
        expectDiverged(
          await replay(replaced<"PlatformValue">(rs, i, { value: changed })),
          devices ? "ArgumentMismatch" : "CheckpointMismatch",
          devices ? seqAt(rs, devicesRead) : lastCheckpoint(rs),
        );
      }
    },
    TIMEOUT * 4,
  );

  it(
    "replay_gives_a_page_the_logged_devices_as_objects_of_their_interface",
    async () => {
      // Headless Chromium lists no devices, so the visitor's are written
      // into the log: one input device with capabilities, one output.
      const rs = await record("values.html?case=device");
      const at = indexWhere(
        rs,
        "PlatformValue",
        (r) => r.query === "navigator.mediaDevices.enumerateDevices",
      );
      const read = indexWhere(rs, "StorageRead", (r) =>
        r.key.startsWith("devices:"),
      );
      expect((rs[read] as RecordOf<"StorageRead">).key).toBe("devices:");
      // The page reads storage under a key naming what it saw of each
      // device (kind, label, id, group, whether it is a MediaDeviceInfo and
      // an InputDeviceInfo, toJSON()'s label, getCapabilities()'s width),
      // which the log has as the recording's: the replay diverges there,
      // and its key is what the replayed page saw.
      for (const [device, saw] of [
        [
          {
            deviceId: "cam-1",
            kind: "videoinput",
            label: "Camera",
            groupId: "g1",
            capabilities: { width: { min: 1, max: 1920 } },
          },
          "devices:videoinput/Camera/cam-1/g1/true/true/Camera/1920",
        ],
        [
          {
            deviceId: "spk",
            kind: "audiooutput",
            label: "Speakers",
            groupId: "g2",
          },
          "devices:audiooutput/Speakers/spk/g2/true/false/Speakers/-",
        ],
      ] as const) {
        const report = await rr.replay(
          replaced<"PlatformValue">(rs, at, {
            value: JSON.stringify({ resolved: [device] }),
          }),
        );
        expectDiverged(report, "ArgumentMismatch", seqAt(rs, read));
        expect(report.divergence?.actual).toContain(`key="${saw}"`);
      }
    },
    TIMEOUT,
  );

  it(
    "replay_keeps_the_identity_of_the_font_promises_a_page_reads_again",
    async () => {
      // `document.fonts.ready === document.fonts.ready` and the same for a
      // face's `loaded`, as the platform answers, on record and on replay.
      const { records: rs, slots } = await rr.recordPage(
        "values.html?case=fonts-identity",
      );
      expect(slots).toContain("same=true,true,false");
      expect(slots).toContain("loaded=NetworkError:true");
      expect(slots).toContain("after=true");
      const identities = (query: string) =>
        rs
          .map((r, i) => [r, i] as const)
          .filter(
            ([r]) =>
              r.record === "PlatformValue" &&
              r.src === PLATFORM_VALUE_SRC.platformState &&
              r.query === query,
          ) as (readonly [RecordOf<"PlatformValue">, number])[];
      const ready = identities("document.fonts.ready");
      const loaded = identities('FontFace.loaded["ct-identity"]');
      // Each read is logged: the first hands a new promise (its platform
      // task's TaskReg follows), the next ones the promise of that task.
      // (The ids are whatever the session had minted by then: the browser
      // may dispatch input, such as the pointer entering, before the case.)
      for (const reads of [ready, loaded]) {
        const task = rs[reads[0][1] + 1] as RecordOf<"TaskReg">;
        expect([task.record, task.kind]).toEqual(["TaskReg", 13]);
        const id = task.task_id.toString();
        expect(reads.map(([r]) => r.value)).toEqual(["null", id, id]);
      }
      expectReplayed(await replay(rs), rs);
      // A read the log says handed a new promise: the replay registers a
      // platform task (its TaskReg) where the log has the next read.
      expectDiverged(
        await replay(
          replaced<"PlatformValue">(rs, ready[1][1], { value: "null" }),
        ),
        "ExtraRead",
        seqAt(rs, ready[1][1] + 1),
      );
      // A read of a promise the replay never handed is a typed divergence
      // where the page reads it.
      expectDiverged(
        await replay(
          replaced<"PlatformValue">(rs, ready[1][1], { value: "999999" }),
        ),
        "ArgumentMismatch",
        seqAt(rs, ready[1][1]),
      );
    },
    TIMEOUT,
  );

  it(
    "replay_loads_the_page_at_its_logged_query_and_fragment",
    async () => {
      const rs = await record("values.html?case=url&x=7#frag");
      const env = rs[1] as RecordOf<"Env">;
      expect(env.url).toBe(`${rr.server.origin}/values.html?case=url&x=7#frag`);
      expectReplayed(await replay(rs), rs);
      const other = withRecordReplaced(rs, 1, {
        ...env,
        url: env.url.replace("x=7", "x=8"),
      });
      expectDiverged(
        await replay(other),
        "CheckpointMismatch",
        lastCheckpoint(rs),
      );
    },
    TIMEOUT,
  );

  it(
    "replay_releases_platform_tasks_in_their_logged_order",
    async () => {
      const rs = await record("values.html?case=platform");
      const regs = rs.filter((r) => r.record === "TaskReg" && r.kind === 13);
      const tasks = rs
        .map((r, i) => [r, i] as const)
        .filter(([r]) => r.record === "Task" && r.kind === 13);
      expect(regs.length).toBe(4);
      expect(tasks.length).toBe(4);
      expectReplayed(await replay(rs), rs);
      // Two platform tasks released in the other order: the page's
      // continuations run in that order, and the order it shows differs.
      const swapped = withRecordsSwapped(rs, tasks[0][1], tasks[1][1]);
      expectDiverged(
        await replay(swapped),
        "CheckpointMismatch",
        lastCheckpoint(rs),
      );
    },
    TIMEOUT,
  );

  it(
    "replay_answers_the_performance_timeline_from_the_log",
    async () => {
      const rs = await record("values.html?case=perf");
      const resources = indexWhere(
        rs,
        "PlatformValue",
        (v) =>
          v.src === PLATFORM_VALUE_SRC.performance &&
          v.query === 'getEntriesByType["resource"]',
      );
      indexWhere(rs, "Clock", (c) => c.src === 7);
      indexWhere(
        rs,
        "PlatformValue",
        (v) => v.src === PLATFORM_VALUE_SRC.performanceObserver,
      );
      const list = JSON.parse(
        (rs[resources] as RecordOf<"PlatformValue">).value,
      ) as { name: string }[];
      expect(list.some((e) => e.name.endsWith("/values.js"))).toBe(true);
      expectReplayed(await replay(rs), rs);
      // Before: the replay browser's own timeline, which also lists the
      // runner's requests. An edited one shows the page gets the log's.
      expectDiverged(
        await replay(replaced<"PlatformValue">(rs, resources, { value: "[]" })),
        "CheckpointMismatch",
        lastCheckpoint(rs),
      );
    },
    TIMEOUT,
  );

  it(
    "replay_delivers_messages_the_page_posts_to_itself_in_logged_order",
    async () => {
      const rs = await record("values.html?case=messages");
      // The port posts are registered when made; the window posts are
      // tasks minted at their delivery (no TaskReg).
      expect(
        rs.filter((r) => r.record === "TaskReg" && r.kind === 6).length,
      ).toBe(2);
      const tasks = rs
        .map((r, i) => [r, i] as const)
        .filter(([r]) => r.record === "Task" && r.kind === 6);
      expect(tasks.length).toBe(4);
      expectReplayed(await replay(rs), rs);
      const swapped = withRecordsSwapped(rs, tasks[0][1], tasks[1][1]);
      expectDiverged(
        await replay(swapped),
        "CheckpointMismatch",
        lastCheckpoint(rs),
      );

      // A message from another document is refused where it arrives.
      const foreign = await record("values.html?case=message-foreign");
      const refusal = indexWhere(
        foreign,
        "Refusal",
        (r) => r.feature === "foreign-message",
      );
      expectDiverged(
        await replay(foreign),
        "NonReplayable",
        seqAt(foreign, refusal),
      );
    },
    TIMEOUT,
  );

  it(
    "replay_dispatches_a_storage_event_from_another_document",
    async () => {
      const rs = await record(
        "values.html?case=storage-event",
        async (page, context) => {
          await until(page, isReady, "the storage listener");
          const other = await context.newPage();
          await other.goto(`${rr.server.origin}/values.html?case=url`);
          await other.evaluate(() => localStorage.setItem("k", "v"));
        },
      );
      const task = indexWhere(rs, "Task", (t) => t.kind === 9);
      const input = rs[task + 1] as RecordOf<"Input">;
      expect(input.record).toBe("Input");
      expect(input.type).toBe("storage");
      expect(JSON.parse(input.props)).toMatchObject({
        key: "k",
        newValue: "v",
        storageArea: "localStorage",
      });
      expectReplayed(await replay(rs), rs);
      const other = replaced<"Input">(rs, task + 1, {
        props: input.props.replace('"newValue":"v"', '"newValue":"w"'),
      });
      expectDiverged(
        await replay(other),
        "CheckpointMismatch",
        lastCheckpoint(rs),
      );
    },
    TIMEOUT,
  );

  it(
    "replay_gives_window_handlers_set_by_markup_the_trusted_view",
    async () => {
      // `<body onmessage>`, `<body onpopstate>` and `<body onhashchange>`
      // are the window's handlers, compiled by the platform from the
      // attributes (values-markup.html). Each sees the replayed event as
      // trusted, as on record, at its place among the window's listeners, and
      // the replay reaches End.
      const cases: [string, string][] = [
        ["markup", "markup=true"],
        // Run once: the replay browser's own popstate is held back.
        ["markup-popstate", "popstate=true:null:1"],
        ["markup-hashchange", "hashchange=true:#moved"],
      ];
      for (const [c, saw] of cases) {
        const { records, slots } = await rr.recordPage(
          `values-markup.html?case=${c}`,
        );
        // Vacuity guard: on record the handler ran, and saw a trusted event.
        expect(slots, c).toContain(saw);
        expectReplayed(await replay(records), records);
      }
    },
    TIMEOUT,
  );

  it(
    "replay_gives_a_window_handler_set_through_body_the_trusted_view",
    async () => {
      // `document.body.onmessage = f` sets the window's handler from script
      // (HTML, WindowEventHandlers); it is not markup, so the replay gives
      // it the trusted view and reaches End.
      const rs = await record("values.html?case=body-handler");
      expect(rs.filter((r) => r.record === "Task" && r.kind === 6).length).toBe(
        1,
      );
      expectReplayed(await replay(rs), rs);
    },
    TIMEOUT,
  );

  it(
    "a_script_that_wrote_no_record_replays_from_its_loading_position",
    async () => {
      // The `url` case run while values.js runs, at the end of the body: the
      // script inserts three result slots and makes no boundary read, so its
      // execution is a DocTask 4 written when it settled, after the Loading
      // of that moment, which counts the slots it inserted.
      const rs = await record("values.html?case=url&at=loading");
      const task = indexWhere(
        rs,
        "DocTask",
        (d) => d.kind === 4 && d.src.endsWith("/values.js"),
      );
      const loading = rs[task - 1] as RecordOf<"Loading">;
      expect(loading.record).toBe("Loading");
      expect(loading.phase).toBe(1);
      // Vacuity guard: no record of the script's own between them.
      expect(
        rs.slice(0, task).some((r) => r.record === "DocTask" && r.kind === 1),
      ).toBe(false);
      expectReplayed(await replay(rs), rs);
      // A position the script does not bring the document to is refused at
      // the Loading, never replayed elsewhere.
      const off = replaced<"Loading">(rs, task - 1, {
        elements: loading.elements + 1,
      });
      expectDiverged(
        await replay(off),
        "TaskOrderMismatch",
        seqAt(rs, task - 1),
      );
    },
    TIMEOUT,
  );

  it(
    "a_mutation_observer_callback_while_loading_replays_at_its_position",
    async () => {
      // The `observers` case run while the document loads: the
      // MutationObserver's callback is a microtask of the platform's, right
      // after the script that changed the list, so its records follow the
      // Loading of that moment and no Task.
      const rs = await record("values.html?case=observers&at=loading");
      const mo = indexWhere(
        rs,
        "PlatformValue",
        (v) =>
          v.src === PLATFORM_VALUE_SRC.mutationObserver &&
          v.query === "callback",
      );
      expect(rs[mo - 1].record).toBe("Loading");
      expect((rs[mo - 1] as RecordOf<"Loading">).phase).toBe(1);
      const id = (rs[mo] as RecordOf<"PlatformValue">).task_id;
      expect(
        rs.some((r) => r.record === "Task" && r.task_id === id),
        "a MutationObserver callback has no Task",
      ).toBe(false);
      expectReplayed(await replay(rs), rs);
      // The records are still the replay's own, compared with the log's.
      expectDiverged(
        await replay(replaced<"PlatformValue">(rs, mo, { value: "[]" })),
        "ArgumentMismatch",
        seqAt(rs, mo),
      );
    },
    TIMEOUT,
  );

  it(
    "values_cases_replay_to_end_when_run_while_the_document_loads",
    async () => {
      // The cases above start at `load`; run while the document loads, their
      // records interleave with the document's own tasks, and still replay
      // to End.
      const cases = [
        "url",
        "observers",
        "fetch-meta",
        "xhr-meta",
        "ws-frames",
        "sse-named",
        "idle",
        "platform",
        "perf",
        "messages",
        "body-handler",
        "promises",
      ];
      for (const c of cases) {
        const rs = await record(`values.html?case=${c}&at=loading`);
        // Vacuity guard: the session has records written while it parsed,
        // and the case's own records before the document's load.
        const load = indexWhere(rs, "DocTask", (d) => d.kind === 3);
        expect(
          rs
            .slice(0, load)
            .some((r) => r.record === "Loading" && r.phase === 1),
          c,
        ).toBe(true);
        const r = await replay(rs);
        expect(
          `${c}: ${r.divergence?.kind ?? r.error ?? "replayed"}`,
          r.divergence?.detail,
        ).toBe(`${c}: replayed`);
        expectReplayed(r, rs);
      }
    },
    TIMEOUT * 2,
  );
});

/**
 * A different value of a logged platform state's JSON (`stateJson`): a
 * number plus one, a string with a suffix, a boolean negated, an array with
 * one more entry, an object whose first scalar is changed.
 */
function perturb(json: string): string {
  const v = JSON.parse(json) as unknown;
  const change = (x: unknown): unknown => {
    if (typeof x === "number") return x + 1;
    if (typeof x === "string") return `${x}-changed`;
    if (typeof x === "boolean") return !x;
    if (x === null) return 1;
    if (Array.isArray(x)) {
      return x.length > 0 && Array.isArray(x[0])
        ? [...x, ["changed", 1]]
        : [...x, "changed"];
    }
    const o = { ...(x as Record<string, unknown>) };
    const k = Object.keys(o).find((key) =>
      ["number", "string", "boolean"].includes(typeof o[key]),
    );
    if (k === undefined) return { ...o, changed: 1 };
    o[k] = change(o[k]);
    return o;
  };
  return JSON.stringify(change(v));
}

/**
 * A different logged outcome (`outcomeJson`): a resolution with another
 * value (or, for one with nothing to change, a rejection), a rejection with
 * another name.
 */
function perturbOutcome(json: string): string {
  const o = JSON.parse(json) as {
    resolved?: unknown;
    rejected?: { name: string; message: string; type: string };
  };
  if (o.rejected !== undefined) {
    return JSON.stringify({ rejected: { ...o.rejected, name: "AbortError" } });
  }
  if (o.resolved === true || o.resolved === null) {
    return JSON.stringify({
      rejected: { name: "AbortError", message: "", type: "DOMException" },
    });
  }
  return JSON.stringify({
    resolved: JSON.parse(perturb(JSON.stringify(o.resolved))),
  });
}

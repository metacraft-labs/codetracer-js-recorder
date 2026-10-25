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

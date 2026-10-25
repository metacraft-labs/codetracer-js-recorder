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

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type BoundaryRecord,
  type RecordOf,
  PLATFORM_VALUE_SRC,
  WS_FRAME,
  decodeLog,
} from "../../packages/boundary-format/src/index.js";
import {
  type Browser,
  type ReplayReport,
  loadPlaywright,
  logBytes,
  replaySession,
  seqAt,
  withRecordReplaced,
  withRecordsSwapped,
} from "../../packages/boundary-replay/src/index.js";
import { FIXTURES, type FixtureServer, startFixtureServer } from "./harness.js";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const RECORDER_CLI = path.join(REPO_ROOT, "packages/cli/dist/index.js");
const TIMEOUT = 120_000;

/** The slice of Playwright's page these tests drive. */
interface Page {
  goto(url: string): Promise<unknown>;
  evaluate<T>(fn: () => T): Promise<T>;
  setInputFiles(selector: string, files: string): Promise<void>;
}
interface Context {
  newPage(): Promise<Page>;
  close(): Promise<void>;
}

let browser: Browser;
let build: string;
let server: FixtureServer;
const tmpDirs: string[] = [];

function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

beforeAll(async () => {
  browser = await loadPlaywright().chromium.launch({ headless: true });
  build = path.join(tmp("ct-values-build-"), "site");
  fs.mkdirSync(build);
  for (const f of fs.readdirSync(FIXTURES)) {
    fs.copyFileSync(path.join(FIXTURES, f), path.join(build, f));
  }
  const hash = execFileSync(
    process.execPath,
    [RECORDER_CLI, "bundle-manifest", build],
    { encoding: "utf-8" },
  ).trim();
  execFileSync(
    process.execPath,
    [RECORDER_CLI, "boundary-shim", build, "--build-hash", hash],
    { stdio: "pipe" },
  );
  server = await startFixtureServer(build);
}, TIMEOUT);

afterAll(async () => {
  await server?.close();
  await browser?.close();
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

/** Poll `probe` from Node (an in-page poll would be recorded as the page's). */
async function until(page: Page, probe: () => boolean, what: string) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (await page.evaluate(probe)) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const isDone = () => document.body?.getAttribute("data-done") === "1";
const isReady = () => document.body?.getAttribute("data-ready") === "1";

/**
 * Record `page` (a path under the fixture server) until it is done; `drive`
 * acts on it first (user input, a second page). Returns the decoded log.
 */
async function record(
  pagePath: string,
  drive?: (page: Page, context: Context) => Promise<void>,
): Promise<BoundaryRecord[]> {
  const context = (await browser.newContext()) as unknown as Context;
  try {
    const page = await context.newPage();
    await page.goto(`${server.origin}/${pagePath}`);
    if (drive !== undefined) await drive(page, context);
    await until(page, isDone, `${pagePath} to finish`);
    const bytes = await page.evaluate(() => {
      const shim = (globalThis as unknown as Record<string, unknown>)
        .__ctBoundaryShim as { stop(): void; log(): Uint8Array };
      shim.stop();
      return Array.from(shim.log());
    });
    return decodeLog(Uint8Array.from(bytes), { inlineBodies: "batch" }).records;
  } finally {
    await context.close();
  }
}

/** Replay `records` against the build (verification only, no trace). */
async function replay(records: BoundaryRecord[]): Promise<ReplayReport> {
  const file = path.join(tmp("ct-values-log-"), "jsbound.log");
  fs.writeFileSync(file, logBytes(records));
  return replaySession({ log: file, build, browser, timeoutMs: 60_000 });
}

/** The replay reached `End` and compared every checkpoint of the log. */
function expectReplayed(r: ReplayReport, records: BoundaryRecord[]): void {
  expect(r.error, r.error).toBeUndefined();
  expect(
    r.divergence,
    `${r.divergence?.kind} at ${r.divergence?.seq}: ${r.divergence?.detail}`,
  ).toBeUndefined();
  expect(r.status).toBe("replayed");
  const checkpoints = records.filter((x) => x.record === "Checkpoint").length;
  // Vacuity guard: there is a checkpoint after the page wrote its values.
  expect(checkpoints).toBeGreaterThanOrEqual(1);
  expect(r.checkpoints).toBe(checkpoints);
}

/** The replay diverged with `kind` at `seq`. */
function expectDiverged(r: ReplayReport, kind: string, seq?: string): void {
  expect(r.status, r.error).toBe("diverged");
  expect(
    `${r.divergence?.kind} at ${r.divergence?.seq}`,
    r.divergence?.detail,
  ).toBe(`${kind} at ${seq ?? r.divergence?.seq}`);
}

/** The seq of the last checkpoint (where the page's values are compared). */
function lastCheckpoint(records: BoundaryRecord[]): string {
  const i = records.map((r) => r.record).lastIndexOf("Checkpoint");
  return seqAt(records, i);
}

function indexWhere<K extends BoundaryRecord["record"]>(
  records: BoundaryRecord[],
  kind: K,
  pred: (r: RecordOf<K>) => boolean = () => true,
  nth = 0,
): number {
  let seen = 0;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.record === kind && pred(r as RecordOf<K>) && seen++ === nth) return i;
  }
  throw new Error(`no ${kind} record matches`);
}

function replaced<K extends BoundaryRecord["record"]>(
  records: BoundaryRecord[],
  at: number,
  change: Partial<RecordOf<K>>,
): BoundaryRecord[] {
  return withRecordReplaced(records, at, {
    ...(records[at] as RecordOf<K>),
    ...change,
  } as BoundaryRecord);
}

const utf8 = (b: { kind: string; bytes?: Uint8Array }) =>
  new TextDecoder().decode(b.bytes);

describe("replay gives a page the values it read", () => {
  it(
    "replay_gives_a_fetch_response_its_logged_url_redirected_status_text_and_type",
    async () => {
      const rs = await record("values.html?case=fetch-meta");
      const at = indexWhere(rs, "NetResponse", (r) => r.outcome === 5);
      const head = rs[at] as RecordOf<"NetResponse">;
      expect(head.url).toBe(`${server.origin}/api/data?redirected=1`);
      expect([head.redirected, head.status_text, head.response_type]).toEqual([
        1,
        "OK",
        1,
      ]);
      expectReplayed(await replay(rs), rs);
      // What replay answered before the log held them: the request's URL,
      // not redirected, an empty status text.
      const before = replaced<"NetResponse">(rs, at, {
        url: `${server.origin}/api/redirect`,
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
        `${server.origin}/api/data?redirected=1`,
        "OK",
      ]);
      expectReplayed(await replay(rs), rs);
      const before = replaced<"NetResponse">(rs, at, {
        url: `${server.origin}/api/redirect`,
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
      // Before: timeRemaining() answered 0.
      const zero = replaced<"Clock">(rs, remaining, { bits: 0n });
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
    "replay_loads_the_page_at_its_logged_query_and_fragment",
    async () => {
      const rs = await record("values.html?case=url&x=7#frag");
      const env = rs[1] as RecordOf<"Env">;
      expect(env.url).toBe(`${server.origin}/values.html?case=url&x=7#frag`);
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
          await other.goto(`${server.origin}/values.html?case=url`);
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
    "replay_refuses_a_window_handler_set_by_markup",
    async () => {
      const rs = await record("values-markup.html?case=markup");
      const r = await replay(rs);
      expectDiverged(r, "NonReplayable");
      expect(r.divergence?.detail).toContain("set by markup");
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
});

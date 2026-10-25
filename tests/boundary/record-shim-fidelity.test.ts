/**
 * The generic boundary shim in record mode, on the page behaviours its first
 * version got wrong (CodeTracer's JS-Boundary-Recording specification, §5.2,
 * §6, §7.5, §10.1, §10.4): a streamed response body, XMLHttpRequest failures
 * and `send()` calls the platform refuses, Web Storage read the property
 * way, `Event.timeStamp`, and timer handlers that are not functions.
 *
 * Real headless Chromium, fixture pages served by a real local HTTP server
 * (`harness.ts`, which also streams responses and answers slowly), the shim
 * installed by the shipped CLI step, every log decoded by the strict
 * `@codetracer/boundary-format` decoder.
 *
 * No mocks. Where a test compares the page's behaviour with and without the
 * shim, the plain arm is the same fixture copy served without the
 * bootstrap: the comparison is against the platform itself. The counting
 * layer (`fixtures/counting-layer.js`, see record-shim.test.ts) is a
 * page-side instrument, installed beneath the shim, not a stand-in.
 */

import * as fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type BoundaryRecord,
  type DecodedLog,
  decodeLog,
} from "../../packages/boundary-format/src/index.js";
import { sha256Hex } from "../../packages/boundary-shim/src/browser/sha256.js";
import {
  type Browser,
  type BrowserContext,
  type FixtureServer,
  type Page,
  copyFixtures,
  loadPlaywright,
  readLog,
  recordsOf,
  shimmedFixtures,
  sleep,
  startFixtureServer,
  stopAndDecode,
  waitForDone,
} from "./harness.js";

const TIMEOUT = 60_000;

let browser: Browser;
/** The fixture pages with the shim installed by the CLI step. */
let shimDir: string;
/** The same fixture pages without it. */
let plainDir: string;
const servers: FixtureServer[] = [];
const tmpDirs: string[] = [];

beforeAll(async () => {
  browser = await loadPlaywright().chromium.launch({ headless: true });
  shimDir = shimmedFixtures();
  plainDir = copyFixtures();
  tmpDirs.push(shimDir, plainDir);
}, TIMEOUT);

afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
  await browser?.close();
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

async function serve(root: string): Promise<FixtureServer> {
  const s = await startFixtureServer(root);
  servers.push(s);
  return s;
}

interface Opened {
  server: FixtureServer;
  context: BrowserContext;
  page: Page;
  pageErrors: Error[];
}

/** `path` of `root` served on its own server, in a fresh context, until done. */
async function open(
  root: string,
  path: string,
  initScripts: string[] = [],
): Promise<Opened> {
  const server = await serve(root);
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors: Error[] = [];
  page.on("pageerror", (e) => pageErrors.push(e));
  for (const s of initScripts) {
    await page.addInitScript({ path: `${root}/${s}` });
  }
  await page.goto(`${server.origin}/${path}`);
  await waitForDone(page);
  return { server, context, page, pageErrors };
}

async function slots(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const out: Record<string, string> = {};
    for (const li of Array.from(document.querySelectorAll("#out li"))) {
      out[li.id] = li.textContent ?? "";
    }
    return out;
  });
}

async function errorCounters(
  page: Page,
): Promise<{ error: number; rejection: number }> {
  return page.evaluate(
    () =>
      (
        globalThis as unknown as {
          __errors: { error: number; rejection: number };
        }
      ).__errors,
  );
}

const utf8 = new TextDecoder();

/** The bytes a `blobref` carries (the shim writes every body inline). */
function blobText(b: { kind: string; bytes?: Uint8Array }): string {
  if (b.kind !== "inline" || b.bytes === undefined) {
    throw new Error(`expected an inline body, got ${b.kind}`);
  }
  return utf8.decode(b.bytes);
}

/** The request whose URL ends with `suffix`, and the task it registered. */
function request(
  log: DecodedLog,
  suffix: string,
): { reqId: bigint; taskId: bigint; at: number } {
  const req = recordsOf(log, "NetRequest", (r) => r.url.endsWith(suffix));
  expect(req.length, `NetRequest for ${suffix}`).toBe(1);
  const at = log.records.indexOf(req[0]);
  const reg = log.records[at + 1];
  expect(reg).toMatchObject({ record: "TaskReg" });
  return {
    reqId: req[0].req_id,
    taskId: (reg as Extract<BoundaryRecord, { record: "TaskReg" }>).task_id,
    at,
  };
}

/** Index of each record of `log` for `reqId` that `pick` selects. */
function indicesOf(
  log: DecodedLog,
  pick: (r: BoundaryRecord) => boolean,
): number[] {
  return log.records.flatMap((r, i) => (pick(r) ? [i] : []));
}

function isChunk(reqId: bigint) {
  return (r: BoundaryRecord) =>
    r.record === "WsMessage" && r.req_id === reqId && r.dir === 1;
}
function isBodyEnd(reqId: bigint) {
  return (r: BoundaryRecord) =>
    r.record === "WsMessage" && r.req_id === reqId && r.dir === 4;
}

/** Is there a `Clock{src 1}` (the page's `Date.now()`) in `log[from, to)`? */
function clockBetween(log: DecodedLog, from: number, to: number): boolean {
  return log.records
    .slice(from, to)
    .some((r) => r.record === "Clock" && r.src === 1);
}

function clockValue(bits: bigint): number {
  const v = new DataView(new ArrayBuffer(8));
  v.setBigUint64(0, bits, true);
  return v.getFloat64(0, true);
}

describe("record-side generic boundary shim: fidelity fixes", () => {
  it(
    "jsbound_shim_streams_a_fetch_body_as_it_arrives",
    async () => {
      // A body that never ends. Without the fix the page's fetch never
      // resolves and waitForDone times out.
      const forever = await open(shimDir, "streams.html?case=fetch-forever");
      const s = await slots(forever.page);
      expect(forever.pageErrors).toEqual([]);
      // The page's three reads. The server writes a line every 100 ms, and
      // each read gets what the network has delivered by then: one line,
      // or, when the renderer was not scheduled for longer than that, the
      // lines that arrived meanwhile in one piece. Either way the pieces
      // are the server's lines in order, and the log must hold exactly
      // these pieces.
      const pieces = s["r-chunks"].slice("chunks=".length).split("|");
      expect(pieces).toHaveLength(3);
      expect(pieces.join("")).toMatch(/^c0\n(c\d+\n)*$/);
      expect(
        pieces
          .join("")
          .split("\n")
          .slice(0, -1)
          .map((l, k) => l === `c${k}`),
      ).not.toContain(false);
      expect(s["r-ended"]).toBe("ended=no");
      // The page's cancel reached the server: the stream it never finished
      // was closed by the client.
      for (let i = 0; i < 100 && forever.server.streamEnds.length === 0; i++) {
        await sleep(20);
      }
      expect(forever.server.streamEnds).toMatchObject([
        { url: "/api/stream?n=forever&interval=100", finished: false },
      ]);
      expect(forever.server.streamEnds[0].written).toBeLessThan(10);

      const log = await stopAndDecode(forever.page);
      expect(log.termination).toBe("Complete");
      const { reqId, taskId, at } = request(
        log,
        "/api/stream?n=forever&interval=100",
      );
      // The head: Task, then NetResponse{outcome 5} with no body.
      const head = recordsOf(log, "NetResponse", (r) => r.req_id === reqId);
      expect(head).toHaveLength(1);
      expect(head[0]).toMatchObject({ outcome: 5, status: 200 });
      expect(blobText(head[0].body)).toBe("");
      const headAt = log.records.indexOf(head[0]);
      expect(headAt).toBeGreaterThan(at);
      expect(log.records[headAt - 1]).toMatchObject({
        record: "Task",
        task_id: taskId,
        kind: 4,
      });
      // The pieces, in the order the page got them, after the head.
      const chunks = indicesOf(log, isChunk(reqId));
      expect(
        chunks.map((i) =>
          blobText(
            (log.records[i] as Extract<BoundaryRecord, { record: "WsMessage" }>)
              .data,
          ),
        ),
      ).toEqual(pieces);
      expect(chunks[0]).toBeGreaterThan(headAt);
      // The lines were written 100 ms apart, so each later piece reached the
      // page in a network task of its own: a Task with the request's id
      // precedes it.
      for (const i of chunks.slice(1)) {
        expect(log.records[i - 1]).toMatchObject({
          record: "Task",
          task_id: taskId,
          kind: 4,
        });
      }
      // Each piece's record precedes the page's read in its continuation.
      chunks.forEach((i, k) => {
        const next = chunks[k + 1] ?? log.records.length;
        expect(clockBetween(log, i, next), `Date.now after chunk ${k}`).toBe(
          true,
        );
      });
      expect(clockBetween(log, headAt, chunks[0])).toBe(false);
      // The page cancelled: no end of body is recorded.
      expect(indicesOf(log, isBodyEnd(reqId))).toEqual([]);

      // A finite body read whole: its pieces, then the end, then the page's
      // continuation.
      const text = await open(shimDir, "streams.html?case=fetch-text");
      expect(text.pageErrors).toEqual([]);
      expect((await slots(text.page))["r-text"]).toBe(
        `text=${JSON.stringify("c0\nc1\nc2\n")}`,
      );
      const tlog = await stopAndDecode(text.page);
      const t = request(tlog, "/api/stream?n=3&interval=50");
      expect(
        recordsOf(tlog, "NetResponse", (r) => r.req_id === t.reqId),
      ).toMatchObject([{ outcome: 5, status: 200 }]);
      const tchunks = indicesOf(tlog, isChunk(t.reqId));
      expect(
        tchunks
          .map((i) =>
            blobText(
              (
                tlog.records[i] as Extract<
                  BoundaryRecord,
                  { record: "WsMessage" }
                >
              ).data,
            ),
          )
          .join(""),
      ).toBe("c0\nc1\nc2\n");
      const end = indicesOf(tlog, isBodyEnd(t.reqId));
      expect(end).toHaveLength(1);
      expect(
        blobText(
          (
            tlog.records[end[0]] as Extract<
              BoundaryRecord,
              { record: "WsMessage" }
            >
          ).data,
        ),
      ).toBe('{"outcome":1}');
      expect(end[0]).toBeGreaterThan(tchunks[tchunks.length - 1]);
      expect(clockBetween(tlog, tchunks[0], end[0])).toBe(false);
      expect(clockBetween(tlog, end[0], tlog.records.length)).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "jsbound_shim_records_a_buffered_body_in_the_task_that_reads_it",
    async () => {
      // The body of /api/data has arrived long before the page reads it, in
      // a timer task 300 ms later: its bytes reach the page in that task, so
      // they are recorded there, with no network Task of their own.
      const o = await open(shimDir, "streams.html?case=fetch-buffered");
      expect(o.pageErrors).toEqual([]);
      expect((await slots(o.page))["r-json"]).toBe("json=42");
      const log = await stopAndDecode(o.page);
      const { reqId, taskId } = request(log, "/api/data");
      const chunks = indicesOf(log, isChunk(reqId));
      const end = indicesOf(log, isBodyEnd(reqId));
      expect(chunks.length).toBeGreaterThan(0);
      expect(end).toHaveLength(1);
      // The timer's task is the last Task before the body's records, and no
      // Task of the request comes after its head.
      const timer = recordsOf(log, "TaskReg", (r) => r.kind === 1)[0];
      const lastTaskBefore = log.records
        .slice(0, chunks[0])
        .filter((r) => r.record === "Task")
        .pop();
      expect(lastTaskBefore).toMatchObject({ task_id: timer.task_id, kind: 1 });
      // The request's tasks: its head's, and the one `json()` settles in
      // once the body is read, after the body's end (§6, as amended
      // 2026-10-23: the platform settles a whole-body read in a task of its
      // own).
      const requestTasks = indicesOf(
        log,
        (r) => r.record === "Task" && r.task_id === taskId,
      );
      expect(requestTasks, "the request's tasks").toHaveLength(2);
      expect(requestTasks[1]).toBeGreaterThan(end[0]);
      expect(
        log.records
          .slice(chunks[0], end[0] + 1)
          .filter((r) => r.record === "Task"),
      ).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    "jsbound_shim_keeps_the_fetched_response_as_the_platform_makes_it",
    async () => {
      const plain = await open(plainDir, "streams.html?case=fetch-shape");
      const shimmed = await open(shimDir, "streams.html?case=fetch-shape");
      for (const a of [plain, shimmed]) {
        expect(a.pageErrors).toEqual([]);
        expect(await errorCounters(a.page)).toEqual({ error: 0, rejection: 0 });
      }
      const p = (await slots(plain.page))["r-shape"];
      // The plain arm is the platform: a redirected basic response with
      // immutable headers and a byte-stream body.
      const shape = JSON.parse(p.slice("shape=".length)) as unknown[];
      expect(shape.slice(0, 3)).toEqual([
        "/api/data?redirected=1",
        "basic",
        true,
      ]);
      expect(String(shape[10])).toMatch(/^TypeError:/);
      expect(shape).toContain("byob");
      expect((await slots(shimmed.page))["r-shape"]).toBe(p);
      // The shimmed arm streamed every body it delivered: the redirected
      // GET, the HEAD (an empty body, not a null one, in Chromium) and the
      // last GET.
      const log = decodeLog(await readLog(shimmed.page));
      expect(recordsOf(log, "NetRequest", (r) => r.api === 1)).toHaveLength(3);
      expect(recordsOf(log, "NetResponse").map((r) => r.outcome)).toEqual([
        5, 5, 5,
      ]);
    },
    TIMEOUT,
  );

  it(
    "jsbound_shim_errors_an_aborted_body_at_once_as_the_platform_does",
    async () => {
      const plain = await open(plainDir, "streams.html?case=fetch-abort");
      const shimmed = await open(shimDir, "streams.html?case=fetch-abort");
      const p = await slots(plain.page);
      // The platform: the unread body errors at the abort.
      expect(p).toMatchObject({
        "r-first": "first=c0\n",
        "r-closed": "closed=AbortError",
        "r-read": "read=AbortError",
      });
      expect(shimmed.pageErrors).toEqual([]);
      expect(await slots(shimmed.page)).toEqual(p);
      // The end is recorded once, outcome 3, inside the page's abort, with
      // no Task of its own.
      const log = await stopAndDecode(shimmed.page);
      const { reqId, taskId } = request(
        log,
        "/api/stream?n=forever&interval=50",
      );
      const end = indicesOf(log, isBodyEnd(reqId));
      expect(end).toHaveLength(1);
      expect(
        blobText(
          (
            log.records[end[0]] as Extract<
              BoundaryRecord,
              { record: "WsMessage" }
            >
          ).data,
        ),
      ).toBe('{"outcome":3}');
      expect(log.records[end[0] - 1]).not.toMatchObject({
        record: "Task",
        task_id: taskId,
      });
    },
    TIMEOUT,
  );

  it(
    "jsbound_shim_records_xhr_and_event_source_streams_as_they_arrive",
    async () => {
      const x = await open(shimDir, "streams.html?case=xhr-stream");
      expect(x.pageErrors).toEqual([]);
      const s = await slots(x.page);
      const states = s["r-states"].slice("states=".length).split("|");
      const loading = states
        .filter((st) => st.startsWith("3:"))
        .map((st) => JSON.parse(st.slice(2)) as string);
      // Vacuity: the page saw the body grow while it was still loading.
      expect(loading.length).toBeGreaterThanOrEqual(3);
      expect(loading[0]).toBe("c0\n");
      expect(s["r-text"]).toBe(`text=${JSON.stringify("c0\nc1\nc2\n")}`);

      const log = await stopAndDecode(x.page);
      const { reqId, taskId } = request(log, "/api/stream?n=3&interval=100");
      const head = recordsOf(log, "NetResponse", (r) => r.req_id === reqId);
      expect(head).toMatchObject([{ outcome: 5, status: 200 }]);
      expect(log.records[log.records.indexOf(head[0]) - 1]).toMatchObject({
        record: "Task",
        task_id: taskId,
      });
      // One piece per LOADING state the page saw, each in its own Task, its
      // bytes what the page's responseText grew by, and the page's read
      // after it.
      const chunks = indicesOf(log, isChunk(reqId));
      const end = indicesOf(log, isBodyEnd(reqId));
      expect(end).toHaveLength(1);
      const loadingChunks = chunks.filter((i) => i < end[0]);
      let seen = "";
      const grown: string[] = [];
      for (const i of loadingChunks) {
        expect(log.records[i - 1]).toMatchObject({
          record: "Task",
          task_id: taskId,
        });
        seen += blobText(
          (log.records[i] as Extract<BoundaryRecord, { record: "WsMessage" }>)
            .data,
        );
        grown.push(seen);
      }
      expect(grown.slice(0, loading.length)).toEqual(loading);
      expect(seen).toBe("c0\nc1\nc2\n");
      loading.forEach((_, k) => {
        const next = loadingChunks[k + 1] ?? end[0];
        expect(clockBetween(log, loadingChunks[k], next)).toBe(true);
      });
      expect(
        blobText(
          (
            log.records[end[0]] as Extract<
              BoundaryRecord,
              { record: "WsMessage" }
            >
          ).data,
        ),
      ).toBe('{"outcome":1}');

      // EventSource events reach the page as they arrive on a stream that
      // never ends, each recorded before the page's read.
      const es = await open(shimDir, "streams.html?case=sse");
      expect(es.pageErrors).toEqual([]);
      expect((await slots(es.page))["r-events"]).toBe("events=e0|e1");
      const elog = await stopAndDecode(es.page);
      const e = request(elog, "/api/sse?n=forever&interval=100");
      const events = indicesOf(elog, isChunk(e.reqId));
      expect(
        events.map((i) =>
          blobText(
            (
              elog.records[i] as Extract<
                BoundaryRecord,
                { record: "WsMessage" }
              >
            ).data,
          ),
        ),
      ).toEqual(["e0", "e1"]);
      for (const i of events) {
        expect(elog.records[i - 1]).toMatchObject({
          record: "Task",
          task_id: e.taskId,
        });
        expect(clockBetween(elog, i, i + 2)).toBe(true);
      }
    },
    TIMEOUT,
  );

  it(
    "jsbound_shim_records_xhr_progress_and_upload_events_as_tasks",
    async () => {
      /** The page's clock reads after request `at`, one per listener call. */
      const pageClocks = (log: DecodedLog, at: number) =>
        indicesOf(log, (r) => r.record === "Clock" && r.src === 1).filter(
          (i) => i > at,
        );
      const hasTask = (
        log: DecodedLog,
        taskId: bigint,
        from: number,
        to: number,
      ) =>
        log.records
          .slice(from, to)
          .some((r) => r.record === "Task" && r.task_id === taskId);

      // Download: every readystatechange and progress listener call runs
      // after a Task of the request (each progress event is a task of its
      // own, §6), and after the record of every byte it could read. In
      // Chromium the last progress event comes at DONE before DONE's
      // readystatechange, with the whole body readable.
      //
      // Whether a progress event is still pending when the body ends (and so
      // comes at DONE) depends on when the last piece lands in the 50 ms
      // window. The page makes it land there: the server holds the response
      // open after its 40 pieces, and the listener that sees the last of
      // them releases the rest synchronously (/api/release), so it arrives
      // as soon as the listener returns (fixtures/streams.js "xhr-progress").
      type Seen = { type: string; state: number; len: number }[];
      const p = await open(shimDir, "streams.html?case=xhr-progress");
      expect(p.pageErrors).toEqual([]);
      const seen: Seen = (await slots(p.page))["r-seen"]
        .slice("seen=".length)
        .split("|")
        .map((e) => {
          const [type, state, len] = e.split(":");
          return { type, state: Number(state), len: Number(len) };
        });
      // Vacuity: progress events while loading and at DONE, the one at DONE
      // before DONE's readystatechange.
      expect(
        seen.filter((e) => e.type === "progress" && e.state === 3).length,
      ).toBeGreaterThan(0);
      expect(
        seen.filter((e) => e.state === 4).map((e) => e.type),
        "a progress event at DONE: if not, the released end of the held " +
          "response did not reach the page within the 50 ms progress window " +
          "(harness.ts RELEASE_SETTLE_MS, /api/release)",
      ).toEqual(["progress", "readystatechange"]);
      const plog = await stopAndDecode(p.page);
      const req = request(
        plog,
        "/api/stream?n=40&interval=5&hold=xhr-progress",
      );
      const clocks = pageClocks(plog, req.at);
      expect(clocks).toHaveLength(seen.length);
      const firstDone = seen.findIndex((e) => e.state === 4);
      let recorded = 0;
      let from = req.at;
      seen.forEach((e, k) => {
        for (const r of plog.records.slice(from, clocks[k])) {
          if (
            r.record === "WsMessage" &&
            r.req_id === req.reqId &&
            r.dir === 1
          ) {
            recorded += blobText(r.data).length;
          }
        }
        expect(recorded, `bytes recorded before ${e.type} #${k}`).toBe(e.len);
        if (e.state === 2 || e.state === 3 || k === firstDone) {
          expect(
            hasTask(plog, req.taskId, from, clocks[k]),
            `a Task before ${e.type}:${e.state} #${k}`,
          ).toBe(true);
        }
        from = clocks[k];
      });
      const end = indicesOf(plog, isBodyEnd(req.reqId));
      expect(end).toHaveLength(1);
      expect(end[0]).toBeLessThan(clocks[firstDone]);

      // Upload: the upload object's events in network tasks are Tasks of the
      // request; loadstart runs inside send(), with none.
      const plainUp = await open(plainDir, "streams.html?case=xhr-upload");
      const up = await open(shimDir, "streams.html?case=xhr-upload");
      expect(up.pageErrors).toEqual([]);
      const events = (await slots(up.page))["r-seen"]
        .slice("seen=".length)
        .split("|");
      const skeleton = (es: string[]) =>
        es.filter((e, i) => e !== es[i - 1] || e !== "upload:progress");
      expect(
        skeleton(
          (await slots(plainUp.page))["r-seen"]
            .slice("seen=".length)
            .split("|"),
        ),
      ).toEqual([
        "upload:loadstart",
        "upload:progress",
        "upload:load",
        "upload:loadend",
        "load:200",
      ]);
      expect(skeleton(events)).toEqual(
        skeleton(
          (await slots(plainUp.page))["r-seen"]
            .slice("seen=".length)
            .split("|"),
        ),
      );
      const ulog = await stopAndDecode(up.page);
      const u = request(ulog, "/api/data");
      const uclocks = pageClocks(ulog, u.at);
      expect(uclocks).toHaveLength(events.length);
      let ufrom = u.at;
      events.forEach((e, k) => {
        const task = hasTask(ulog, u.taskId, ufrom, uclocks[k]);
        if (e === "upload:loadstart") {
          expect(task, "loadstart runs inside send()").toBe(false);
        } else {
          expect(task, `a Task before ${e} #${k}`).toBe(true);
        }
        ufrom = uclocks[k];
      });
      expect(
        up.server.requests.filter((r) => r.url === "/api/data"),
      ).toHaveLength(1);

      // A page with no upload listener: the shim adds none, so a
      // cross-origin simple request (another port is another origin) goes
      // out without a preflight, as it does without the shim.
      for (const root of [plainDir, shimDir]) {
        const other = await serve(root);
        const o = await open(
          root,
          `streams.html?case=xhr-cross-origin&other=${encodeURIComponent(
            other.origin,
          )}`,
        );
        expect(o.pageErrors).toEqual([]);
        expect(other.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
          "POST /api/echo",
        ]);
      }
    },
    TIMEOUT,
  );

  it(
    "jsbound_shim_logs_xhr_progress_event_values",
    async () => {
      // A ProgressEvent's loaded, total and lengthComputable depend on how
      // the network delivered the bytes, and a page that shows progress
      // reads them (§5.2 XhrEvent, §10.1). The page notes every one it
      // observes at three requests (a chunked download, a download with a
      // content-length, a 2 MiB upload), with a listener for each type at
      // the request and at its upload object, as
      // `<target>:<type>:<loaded>:<total>:<lengthComputable>`, and reads
      // the clock in each listener.
      const o = await open(shimDir, "streams.html?case=xhr-progress-values");
      expect(o.pageErrors).toEqual([]);
      const s = await slots(o.page);
      const log = await stopAndDecode(o.page);
      expect(log.termination).toBe("Complete");
      expect(recordsOf(log, "Refusal")).toEqual([]);

      const TARGETS = ["", "req", "up"];
      const TYPES = [
        "",
        "loadstart",
        "progress",
        "abort",
        "error",
        "load",
        "timeout",
        "loadend",
      ];
      const shown = (r: Extract<BoundaryRecord, { record: "XhrEvent" }>) =>
        [
          TARGETS[r.target],
          TYPES[r.event],
          r.loaded,
          r.total,
          r.length_computable === 1,
        ].join(":");
      const cases: [string, string][] = [
        ["down", "/api/stream?n=40&interval=5"],
        ["sized", "/api/stream?n=40&interval=5&length=1"],
        ["up", "/api/data"],
      ];
      let observedCount = 0;
      for (const [name, suffix] of cases) {
        const observed = s[`r-${name}`].slice(`${name}=`.length).split("|");
        observedCount += observed.length;
        const { reqId, taskId } = request(log, suffix);
        const events = recordsOf(log, "XhrEvent", (r) => r.req_id === reqId);
        // Every observed event, with the values the page read, in the
        // order it observed them, and nothing it did not.
        expect(events.map(shown), name).toEqual(observed);

        // Vacuity: each request went through its whole life.
        const types = observed.map((e) => e.split(":").slice(0, 2).join(":"));
        for (const t of ["req:loadstart", "req:progress", "req:load"]) {
          expect(types, `${name} observed ${t}`).toContain(t);
        }
        expect(types[types.length - 1]).toBe("req:loadend");

        // A progress event, and an upload event the platform dispatches
        // while it sends the body, is a network task: its XhrEvent closes
        // a Task of the request, after only the parts of the response that
        // task brought (§6). `loadstart` runs inside send().
        events.forEach((e, k) => {
          const at = log.records.indexOf(e);
          // The XhrEvent is the last record before the page's listener,
          // whose first boundary read is the clock: replay dispatches the
          // event with everything before it applied.
          expect(
            log.records[at + 1],
            `${name}: the listener's clock read right after ${shown(e)} #${k}`,
          ).toMatchObject({ record: "Clock", src: 1 });
          let j = at - 1;
          for (; j >= 0; j--) {
            const r = log.records[j];
            const part =
              (r.record === "NetResponse" || r.record === "WsMessage") &&
              r.req_id === reqId;
            if (!part) break;
          }
          const opener = log.records[j];
          const task = opener.record === "Task" && opener.task_id === taskId;
          const type = TYPES[e.event];
          if (type === "progress" || (e.target === 2 && type !== "loadstart")) {
            expect(task, `${name}: a Task before ${shown(e)} #${k}`).toBe(true);
          }
          if (type === "loadstart") {
            expect(task, `${name}: loadstart runs inside send()`).toBe(false);
          }
        });
      }

      // The values are the network's: a chunked body is not
      // length-computable, a content-length makes it so (40 pieces, 150
      // bytes), and the upload reports its 2 MiB.
      const values = (name: string) =>
        s[`r-${name}`]
          .slice(`${name}=`.length)
          .split("|")
          .map((e) => e.split(":"));
      expect(
        values("down").filter(([, t]) => t === "progress"),
      ).not.toContainEqual(expect.arrayContaining(["true"]));
      expect(values("down")).toContainEqual([
        "req",
        "load",
        "150",
        "0",
        "false",
      ]);
      expect(values("sized")).toContainEqual([
        "req",
        "load",
        "150",
        "150",
        "true",
      ]);
      expect(values("up")).toContainEqual([
        "up",
        "load",
        String(2 * 1024 * 1024),
        String(2 * 1024 * 1024),
        "true",
      ]);
      expect(
        values("up").filter(([w, t]) => w === "up" && t === "progress").length,
      ).toBeGreaterThan(0);

      // Each XhrEvent is written before the listener that reads it runs:
      // from the first request on, the events and the listeners' clock
      // reads alternate, event first.
      const first = request(log, cases[0][1]).at;
      expect(
        log.records
          .slice(first)
          .filter(
            (r) =>
              r.record === "XhrEvent" || (r.record === "Clock" && r.src === 1),
          )
          .map((r) => r.record),
      ).toEqual(
        Array.from({ length: observedCount }, () => [
          "XhrEvent",
          "Clock",
        ]).flat(),
      );
    },
    TIMEOUT,
  );

  it(
    "jsbound_shim_ignores_events_the_page_dispatches_at_an_xhr",
    async () => {
      // An event the page dispatches at an XMLHttpRequest is its own code,
      // which runs again on replay; only the platform's events are recorded
      // (§10.1). The page dispatches a progress event at the request and at
      // its upload object inside the task that sends it, and a
      // readystatechange inside the platform's HEADERS_RECEIVED one; every
      // listener reads the clock.
      const o = await open(shimDir, "streams.html?case=xhr-synthetic");
      expect(o.pageErrors).toEqual([]);
      expect((await slots(o.page))["r-status"]).toBe("status=200");
      const log = await stopAndDecode(o.page);
      expect(log.termination).toBe("Complete");
      const { reqId, taskId, at } = request(log, "/api/echo");

      // None of the page's events is an XhrEvent.
      const events = recordsOf(log, "XhrEvent", (r) => r.req_id === reqId);
      expect(events.length, "the platform's events").toBeGreaterThan(0);
      expect(events.filter((e) => e.loaded === BigInt(99))).toEqual([]);

      // The task that sent the request, up to the next task (a `Task`, or the
      // `Loading` or `DocTask` of one while the document loads, §6): the
      // platform's loadstart events inside send(), then the listeners of the
      // page's two progress events, and nothing else.
      const nextTask = log.records.findIndex(
        (r, i) =>
          i > at &&
          (r.record === "Task" ||
            r.record === "Loading" ||
            r.record === "DocTask"),
      );
      expect(nextTask).toBeGreaterThan(at);
      expect(
        log.records
          .slice(at + 2, nextTask)
          .map((r) =>
            r.record === "XhrEvent"
              ? `XhrEvent:${r.target}:${r.event}`
              : r.record,
          ),
      ).toEqual(["XhrEvent:1:1", "XhrEvent:2:1", "Clock", "Clock"]);

      // HEADERS_RECEIVED is one Task and one head, followed by its listener's
      // clock read and that of the page's readystatechange inside it.
      const heads = indicesOf(
        log,
        (r) =>
          r.record === "NetResponse" && r.req_id === reqId && r.outcome === 5,
      );
      expect(heads).toHaveLength(1);
      expect(log.records[heads[0] - 1]).toMatchObject({
        record: "Task",
        task_id: taskId,
      });
      expect(
        log.records.slice(heads[0] + 1, heads[0] + 3).map((r) => r.record),
      ).toEqual(["Clock", "Clock"]);
    },
    TIMEOUT,
  );

  it(
    "jsbound_shim_records_an_xhr_timeout_as_outcome_4",
    async () => {
      const o = await open(shimDir, "streams.html?case=xhr-failures");
      expect(o.pageErrors).toEqual([]);
      const s = await slots(o.page);
      // The platform's verdicts, as the page saw them.
      expect(s["r-slow"]).toBe("slow=timeout,0");
      expect(s["r-refused"]).toBe("refused=error,0");
      const log = await stopAndDecode(o.page);
      expect(log.termination).toBe("Complete");
      const slow = request(log, "/api/slow?ms=3000");
      const refused = request(log, "127.0.0.1:1/");
      // §5.2: outcome 4 is a timeout, 2 a network error. The refused
      // request also had a timeout set, so a recorder that wrote 4 for any
      // failed request with a timeout fails here.
      expect(
        recordsOf(log, "NetResponse", (r) => r.req_id === slow.reqId),
      ).toMatchObject([{ outcome: 4, status: 0 }]);
      expect(
        recordsOf(log, "NetResponse", (r) => r.req_id === refused.reqId),
      ).toMatchObject([{ outcome: 2, status: 0 }]);
      // Each failure is one network task: its Task (at DONE), then the
      // outcome (at the error or timeout event that tells it).
      for (const { reqId, taskId } of [slow, refused]) {
        const tasks = recordsOf(log, "Task", (r) => r.task_id === taskId);
        expect(tasks).toHaveLength(1);
        const resp = recordsOf(log, "NetResponse", (r) => r.req_id === reqId);
        expect(log.records.indexOf(resp[0])).toBeGreaterThan(
          log.records.indexOf(tasks[0]),
        );
      }
      expect(recordsOf(log, "Refusal")).toEqual([]);

      // A timeout while the body is being sent reaches the upload object
      // first: its outcome is written before the page's upload listener
      // can tell it was a timeout.
      const u = await open(shimDir, "streams.html?case=xhr-upload-timeout");
      expect(u.pageErrors).toEqual([]);
      expect((await slots(u.page))["r-seen"]).toBe(
        "seen=upload:timeout|timeout",
      );
      const ulog = await stopAndDecode(u.page);
      const stall = request(ulog, "/api/stall");
      const resp = recordsOf(
        ulog,
        "NetResponse",
        (r) => r.req_id === stall.reqId,
      );
      expect(resp).toMatchObject([{ outcome: 4, status: 0 }]);
      const clock = indicesOf(
        ulog,
        (r) => r.record === "Clock" && r.src === 1,
      ).filter((i) => i > stall.at);
      expect(clock).toHaveLength(1);
      expect(ulog.records.indexOf(resp[0])).toBeLessThan(clock[0]);
    },
    TIMEOUT,
  );

  it(
    "jsbound_shim_logs_only_xhr_requests_that_were_sent",
    async () => {
      const o = await open(shimDir, "streams.html?case=xhr-unsent");
      expect(o.pageErrors).toEqual([]);
      expect((await slots(o.page))["r-results"]).toBe(
        "results=InvalidStateError,InvalidStateError,one,42",
      );
      const log = await stopAndDecode(o.page);
      // Exactly the two requests the server received, each logged once,
      // and the GET's body (which the platform does not send) not digested.
      const apiRequests = o.server.requests.filter((r) =>
        r.url.startsWith("/api/"),
      );
      expect(apiRequests.map((r) => `${r.method} ${r.url} ${r.body}`)).toEqual([
        "POST /api/echo one",
        "GET /api/data?get-with-body=1 ",
      ]);
      const sent = recordsOf(log, "NetRequest", (r) => r.api === 2);
      expect(
        sent.map((r) => [r.method, r.url.replace(o.server.origin, "")]),
      ).toEqual([
        ["POST", "/api/echo"],
        ["GET", "/api/data?get-with-body=1"],
      ]);
      expect(sent[0].body_digest).toBe(sha256Hex("one"));
      expect(sent[1].body_digest).toBe("");
      // Every logged request completed.
      for (const r of sent) {
        expect(
          recordsOf(log, "NetResponse", (x) => x.req_id === r.req_id).length,
        ).toBe(1);
      }
    },
    TIMEOUT,
  );

  it(
    "jsbound_shim_captures_property_style_storage_access",
    async () => {
      /** The storage page, then a write by a second page of the same origin. */
      async function arm(root: string) {
        const o = await open(root, "storage.html");
        const other = await o.context.newPage();
        await other.goto(`${o.server.origin}/cadence.html`);
        await other.evaluate(() => localStorage.setItem("fromOther", "1"));
        let s = await slots(o.page);
        for (let i = 0; i < 100 && s["r-event"] === undefined; i++) {
          await sleep(20);
          s = await slots(o.page);
        }
        return { ...o, slots: s };
      }
      const plain = await arm(plainDir);
      const shimmed = await arm(shimDir);
      for (const a of [plain, shimmed]) {
        expect(a.pageErrors).toEqual([]);
        expect(await errorCounters(a.page)).toEqual({ error: 0, rejection: 0 });
      }
      // The platform's answers (the plain arm), unchanged by the shim.
      expect(plain.slots["r-event"]).toBe("event=fromOther,1,true");
      const results = JSON.parse(
        plain.slots["r-results"].slice("results=".length),
      ) as unknown[];
      expect(results.slice(0, 8)).toEqual([
        "1",
        "undefined",
        "1",
        true,
        false,
        true,
        "2",
        "a b c",
      ]);
      expect(shimmed.slots).toEqual(plain.slots);

      // Every read of a stored value, presence or the key list is logged,
      // in the page's order (§5.2 StorageRead, §10.4).
      const log = await stopAndDecode(shimmed.page);
      const reads = recordsOf(log, "StorageRead", (r) => r.area !== 3).map(
        (r) => [r.area, r.key, r.present, r.value] as const,
      );
      const expected: (readonly [number, string, number, string])[] = [
        [1, "a", 1, "1"], // localStorage.a
        [1, "missing", 0, ""], // localStorage.missing
        [1, "a", 1, "1"], // localStorage["a"]
        [1, "a", 1, "1"], // "a" in localStorage
        [1, "zz", 0, ""], // "zz" in localStorage
        [1, "b", 1, "2"], // getItem("b") after localStorage.b = "2"
      ];
      expect(reads.slice(0, expected.length)).toEqual(expected);
      // Object.keys: the key list, then each key's descriptor.
      const keys = reads[expected.length];
      expect(keys.slice(0, 3)).toEqual([1, "keys", 2]);
      const listed = JSON.parse(keys[3]) as string[];
      expect([...listed].sort()).toEqual(["a", "b", "c"]);
      expect(
        reads
          .slice(expected.length + 1, expected.length + 1 + listed.length)
          .map((r) => r[1]),
      ).toEqual(listed);
      const rest = reads.slice(expected.length + 1 + listed.length);
      expect(rest.slice(0, 5)).toEqual([
        [1, "length", 2, "3"],
        [1, "key", 2, JSON.stringify(listed[0])],
        [1, "key", 2, "null"],
        [1, "b", 0, ""], // getItem("b") after delete
        [1, "b", 0, ""], // "b" in localStorage
      ]);
      // "getItem" in localStorage (between "zz" and "b" above) names a
      // method, not a key, so it wrote nothing. Assigning localStorage.getItem
      // made a property of the object, not a stored key, so the page's
      // getItem("getItem") found nothing, and says so.
      expect(reads.filter((r) => r[1] === "getItem")).toEqual([
        [1, "getItem", 0, ""],
      ]);
      // sessionStorage.s and its length.
      expect(reads.filter((r) => r[0] === 2)).toEqual([
        [2, "s", 1, "x"],
        [2, "length", 2, "1"],
      ]);
    },
    TIMEOUT,
  );

  it(
    "jsbound_shim_logs_event_time_stamps",
    async () => {
      const server = await serve(shimDir);
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.addInitScript({ path: `${shimDir}/counting-layer.js` });
      await page.goto(`${server.origin}/reads.html`);
      await page.click("#go");
      await waitForDone(page);
      const stamps = await page.evaluate(
        () => (globalThis as unknown as { __stamps: number[] }).__stamps,
      );
      const counted = await page.evaluate(
        () =>
          (globalThis as unknown as { __pageCounts: { timeStamp: number } })
            .__pageCounts.timeStamp,
      );
      const log = await stopAndDecode(page);
      const clocks = recordsOf(log, "Clock", (r) => r.src === 5);
      // The page read two time stamps (the click's and its own event's),
      // and the log returns exactly those values, after the click's Input.
      expect(counted).toBe(2);
      expect(clocks.map((c) => clockValue(c.bits))).toEqual(stamps);
      const click = recordsOf(
        log,
        "Input",
        (r) => r.type === "click" && r.target === "path:#go",
      )[0];
      expect(log.records.indexOf(clocks[0])).toBeGreaterThan(
        log.records.indexOf(click),
      );
    },
    TIMEOUT,
  );

  it(
    "jsbound_shim_passes_string_timer_handlers_to_the_platform",
    async () => {
      for (const path of ["timers.html", "timers-csp.html"]) {
        const plain = await open(plainDir, path);
        const shimmed = await open(shimDir, path);
        const p = (await slots(plain.page))["r-results"];
        const results = JSON.parse(p.slice("results=".length)) as unknown[];
        // The plain arm is the platform's behaviour.
        if (path === "timers.html") {
          expect(results.slice(1, 6)).toEqual([
            "number",
            "number,number,true",
            "object handler",
            2,
            0,
          ]);
        } else {
          // Refused by the CSP: nothing ran, nothing was thrown at the page,
          // and the platform reported violations.
          expect(results.slice(1, 6)).toEqual([
            "undefined",
            "undefined",
            "undefined",
            0,
            0,
          ]);
          expect(results[6]).toBeGreaterThan(0);
        }
        expect(shimmed.pageErrors).toEqual([]);
        expect((await slots(shimmed.page))["r-results"], path).toBe(p);

        // The shim cannot write the Task of a handler it hands to the
        // platform unchanged, so the session is marked non-replayable when
        // such a timer is scheduled, and the handler is not registered.
        const log = await stopAndDecode(shimmed.page);
        const handles = results[0] as boolean[];
        const refusals = recordsOf(log, "Refusal");
        if (handles.some((h) => h)) {
          expect(refusals.map((r) => r.feature)).toEqual([
            "unrecordable-timer-handler",
          ]);
        } else {
          expect(refusals).toEqual([]);
        }
        expect(
          recordsOf(log, "TaskReg", (r) => r.kind === 1 || r.kind === 2).map(
            (r) => r.kind,
          ),
          "registered timers: only the page's function timer",
        ).toEqual([1]);
      }
    },
    TIMEOUT,
  );

  it(
    "jsbound_shim_settles_platform_promises_without_timer_clamping",
    async () => {
      // §6 "Platform tasks": the shim settles the page's promise for a
      // platform promise in a task of its own. A page that awaits such
      // promises in a chain runs each continuation inside the task before
      // it, so a timer made there is nested one deeper each time, and HTML
      // clamps a timer nested past five to 4 ms: settling through the
      // original setTimeout made N awaits cost the page at least
      // 4 * (N - 5) ms that the platform does not (and a hidden page far
      // more, throttled timers). The plain arm is the platform's own cost.
      const n = 100;
      const clamped = 4 * (n - 5);
      async function arm(
        root: string,
      ): Promise<{ ms: number; log?: DecodedLog }> {
        const o = await open(root, "values.html?case=awaits");
        expect(o.pageErrors).toEqual([]);
        const [count, ms] = (await slots(o.page))["r-awaits"]
          .slice("awaits=".length)
          .split(":")
          .map(Number);
        expect(count).toBe(n);
        const log = root === shimDir ? await stopAndDecode(o.page) : undefined;
        await o.context.close();
        return { ms, log };
      }
      const plain = await arm(plainDir);
      const shimmed = await arm(shimDir);
      // Vacuity: the shim recorded every one of the awaited promises, as a
      // platform task and its outcome (src 9), so each went through it.
      const log = shimmed.log!;
      const outcomes = recordsOf(
        log,
        "PlatformValue",
        (r) => r.src === 9 && r.query === "createImageBitmap",
      );
      expect(outcomes.length).toBe(n);
      expect(
        recordsOf(log, "Task", (r) => r.kind === 13).length,
      ).toBeGreaterThanOrEqual(n);
      expect(plain.ms, "the platform's own cost").toBeLessThan(clamped / 2);
      expect(
        shimmed.ms,
        `${n} awaits took ${shimmed.ms} ms with the shim, ${plain.ms} ms without; timers clamped to 4 ms would take at least ${clamped} ms`,
      ).toBeLessThan(clamped / 2);
    },
    TIMEOUT,
  );
});

/**
 * The document's own tasks that run page code when the network delivers
 * something, replayed in the order they ran on record (CodeTracer's
 * JS-Boundary-Recording specification §6, "The document's own tasks";
 * §5.2 `DocTask` kind 5 and `PlatformValue` src 7; §7.4; §10.5): the
 * `load` and `error` of an image, a style sheet and a frame, a media
 * element's events and the state its listeners read, a dynamic `import()`
 * (ordered where the deploy step installed its seam, `--import-seam`, and
 * refused from the call where it did not), and a script the page inserts
 * that never ran during the session.
 *
 * Each case records `fixtures/resources.html?case=<name>` for real, in
 * headless Chromium, against the real fixture server, with the generic shim
 * installed by the shipped deploy route (`record-replay.ts`; one build with
 * the `import()` seam, one without), each resource
 * racing a task of the page's own; the page writes the order it saw into
 * the document, so the final checkpoint compares it. The replay then runs
 * with the resource as fast as the runner can answer, or slower than on
 * record (the runner's `responseDelayMs` test seam), and must reach `End`
 * either way; a negative control edits the log's order or a value, which
 * must diverge where it reaches the document.
 *
 * No mocks: the browser, the servers and the runner are real.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type BoundaryRecord,
  type RecordOf,
  PLATFORM_VALUE_SRC,
} from "../../packages/boundary-format/src/index.js";
import {
  seqAt,
  withRecordBefore,
  withoutRecord,
} from "../../packages/boundary-replay/src/index.js";
import { startFixtureServer, type FixtureServer } from "./harness.js";
import {
  type RecordReplay,
  expectDiverged,
  expectReplayed,
  indexWhere,
  isReady,
  lastCheckpoint,
  replaced,
  startRecordReplay,
  until,
} from "./record-replay.js";

const TIMEOUT = 120_000;

/**
 * A short mono 16-bit PCM WAV (RIFF, https://www.mmsp.ece.mcgill.ca/Documents/AudioFormats/WAVE/WAVE.html):
 * half a second of a 440 Hz tone at 8 kHz, which Chromium decodes.
 */
function toneWav(): Buffer {
  const rate = 8000;
  const samples = rate / 2;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    data.writeInt16LE(
      Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate)),
      i * 2,
    );
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "latin1");
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVEfmt ", 8, "latin1");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "latin1");
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** The fixtures installed with the dynamic `import()` seam (`--import-seam`). */
let rr: RecordReplay;
/** The same fixtures installed by the default deploy step, without the seam. */
let plain: RecordReplay;
/** A second origin, for a frame of another origin than the page's. */
let other: FixtureServer;

beforeAll(async () => {
  const addTone = (build: string) =>
    fs.writeFileSync(path.join(build, "resources-tone.wav"), toneWav());
  rr = await startRecordReplay(addTone, { importSeam: true });
  plain = await startRecordReplay(addTone);
  other = await startFixtureServer(rr.build);
}, TIMEOUT);

afterAll(async () => {
  await other?.close();
  await plain?.close();
  await rr?.close();
});

/** The order the page saw, from its `order` slot. */
function orderOf(slots: string[]): string[] {
  const s = slots.find((x) => x.startsWith("order="));
  return s === undefined ? [] : s.slice("order=".length).split(",");
}

/** The index of the resource event `event` of a resource whose URL ends with `tail`. */
function resourceEvent(
  records: BoundaryRecord[],
  event: string,
  tail: string,
): number {
  return indexWhere(
    records,
    "DocTask",
    (d) =>
      d.kind === 5 && d.event === event && d.src.split("?")[0].endsWith(tail),
  );
}

/** `records` with the record at `from` moved to just after the one at `after`. */
function moved(
  records: BoundaryRecord[],
  from: number,
  after: number,
): BoundaryRecord[] {
  const without = withoutRecord(records, from);
  const at = after > from ? after : after + 1;
  return withRecordBefore(without, at, records[from]);
}

/**
 * The import case's order: the image and the timer (in whichever order the
 * machine ran them; a loaded recording can run the 30 ms timer first) before
 * the import, whose module the server delays.
 */
function expectImportLast(order: string[]): void {
  expect([...order.slice(0, 2)].sort()).toEqual(["img", "timer:true"]);
  expect(order[2]).toBe("import:7");
  expect(order).toHaveLength(3);
}

/** A replay option that answers `tail`'s requests `ms` later. */
const slow = (tail: string, ms: number) => ({
  responseDelayMs: (url: string) => (url.split("?")[0].endsWith(tail) ? ms : 0),
});

describe("replay runs the document's resource tasks in recorded order", () => {
  it(
    "replay_runs_an_image_load_before_a_click_even_when_the_image_is_slower",
    async () => {
      const { records: rs, slots } = await rr.recordPage(
        "resources.html?case=image",
        async (page) => {
          await until(page, isReady, "the image case");
          await until(
            page,
            () =>
              (document.getElementById("r-order")?.textContent ?? "").includes(
                "img",
              ),
            "the image's load",
          );
          await page.click("#btn");
        },
      );
      expect(orderOf(slots)).toEqual([
        "img:true:true:200",
        "click",
        "dot:true",
      ]);
      const img = resourceEvent(rs, "load", "/slow-load-pixel.svg");
      const d = rs[img] as RecordOf<"DocTask">;
      expect(d.target).toBe("path:#pic");
      const click = indexWhere(rs, "Input", (i) => i.type === "click");
      expect(img).toBeLessThan(click);
      // As recorded, and with the image far slower than the click.
      expectReplayed(await rr.replay(rs), rs);
      expectReplayed(
        await rr.replay(rs, slow("/slow-load-pixel.svg", 800)),
        rs,
      );
      // The log's order is what decides: the load moved after the click.
      expectDiverged(
        await rr.replay(moved(rs, img, click)),
        "CheckpointMismatch",
        lastCheckpoint(rs),
      );
    },
    TIMEOUT,
  );

  it(
    "replay_holds_an_image_that_loaded_after_a_click_until_its_turn",
    async () => {
      const { records: rs, slots } = await rr.recordPage(
        "resources.html?case=image&delay=1500",
        async (page) => {
          await until(page, isReady, "the image case");
          await page.click("#btn");
        },
      );
      // The image had not arrived when the second one, started by the
      // click, loaded.
      expect(orderOf(slots)).toEqual([
        "click",
        "dot:false",
        "img:true:true:200",
      ]);
      const img = resourceEvent(rs, "load", "/slow-load-pixel.svg");
      expect(img).toBeGreaterThan(
        indexWhere(rs, "Input", (i) => i.type === "click"),
      );
      // The replay holds the first image's request until its turn, so the
      // second image's listener sees it still loading, even when the second
      // one takes long enough on replay for the first to have arrived.
      expectReplayed(await rr.replay(rs), rs);
      expectReplayed(await rr.replay(rs, slow("/resources-dot.svg", 600)), rs);
    },
    TIMEOUT,
  );

  it(
    "replay_orders_style_sheet_image_error_and_data_url_events_as_recorded",
    async () => {
      const { records: rs, slots } = await rr.recordPage(
        "resources.html?case=sheet&delay=300",
      );
      // The missing image fails at once (the server has no file to delay);
      // the style sheet loads after the timer.
      const order = orderOf(slots);
      expect([...order].sort()).toEqual([
        "css:true:true",
        "error:true",
        "timer",
      ]);
      expect(order.indexOf("timer")).toBeLessThan(
        order.indexOf("css:true:true"),
      );
      expect(slots).toContain("inline=true");
      const css = resourceEvent(rs, "load", "/slow-load.css");
      resourceEvent(rs, "error", "/missing.png");
      // The image that needs no request: its event is dispatched from the
      // log, to a handler set by markup, which sees it trusted.
      indexWhere(
        rs,
        "DocTask",
        (d) => d.kind === 5 && d.event === "load" && d.src.startsWith("data:"),
      );
      expectReplayed(await rr.replay(rs), rs);
      // The style sheet's load moved before the timer: the page sees the
      // three in another order, so another listener sets the closing timer.
      // Where its `TaskReg` meets another record of the log that is an
      // `ExtraRead`, and otherwise the final checkpoint differs; which one
      // depends on how the recording interleaved the records after the
      // timer, so either is accepted, at or after the timer's `Task`.
      const timer = indexWhere(rs, "Task", (t) => t.kind === 1);
      const misordered = await rr.replay(moved(rs, css, timer - 1));
      expect(misordered.status, misordered.error).toBe("diverged");
      expect([
        `CheckpointMismatch at ${lastCheckpoint(rs)}`,
        "ExtraRead",
      ]).toContain(
        misordered.divergence?.kind === "ExtraRead"
          ? "ExtraRead"
          : `${misordered.divergence?.kind} at ${misordered.divergence?.seq}`,
      );
      expect(BigInt(misordered.divergence?.seq ?? "0")).toBeGreaterThanOrEqual(
        BigInt(seqAt(rs, timer)),
      );
    },
    TIMEOUT,
  );

  it(
    "replay_answers_a_frame_from_the_build_and_refuses_one_of_another_origin",
    async () => {
      const { records: rs, slots } = await rr.recordPage(
        "resources.html?case=frame&delay=300",
      );
      expect(orderOf(slots)).toEqual([
        "timer",
        "frame:true:the framed document",
      ]);
      resourceEvent(rs, "load", "/resources-frame.html");
      expectReplayed(await rr.replay(rs), rs);
      expectReplayed(
        await rr.replay(rs, slow("/resources-frame.html", 600)),
        rs,
      );

      // A frame of another origin: the build cannot answer it, and the
      // replay says so where the frame navigates.
      const cross = await rr.recordPage(
        `resources.html?case=frame&frame=${encodeURIComponent(`${other.origin}/resources-frame.html`)}`,
      );
      expect(orderOf(cross.slots)).toContain("frame:true:cross-origin");
      const r = await rr.replay(cross.records);
      expectDiverged(r, "NonReplayable");
      expect(r.divergence?.detail).toContain("another origin");
    },
    TIMEOUT,
  );

  it(
    "replay_dispatches_media_events_from_the_log_with_the_state_they_read",
    async () => {
      const { records: rs, slots } = await rr.recordPage(
        "resources.html?case=media",
      );
      const order = orderOf(slots);
      expect(order.some((s) => s.startsWith("meta:true:0.50:"))).toBe(true);
      expect(order).toContain("ready:1:true");
      // The handler set by markup saw a trusted canplay.
      expect(slots).toContain("markup=true");
      const meta = indexWhere(
        rs,
        "DocTask",
        (d) => d.kind === 5 && d.event === "loadedmetadata",
      );
      expect((rs[meta] as RecordOf<"DocTask">).src).toBe("");
      const duration = indexWhere(
        rs,
        "PlatformValue",
        (v) =>
          v.src === PLATFORM_VALUE_SRC.media && v.query.startsWith("duration["),
      );
      expect((rs[duration] as RecordOf<"PlatformValue">).value).toBe("0.5");
      indexWhere(
        rs,
        "PlatformValue",
        (v) =>
          v.src === PLATFORM_VALUE_SRC.media && v.query.startsWith("play["),
      );
      expectReplayed(await rr.replay(rs), rs);
      // The replay browser's media is far slower than the visitor's: the
      // events and the state still come from the log.
      expectReplayed(
        await rr.replay(rs, slow("/resources-tone.wav", 1500)),
        rs,
      );
      expectDiverged(
        await rr.replay(
          replaced<"PlatformValue">(rs, duration, { value: "2.5" }),
        ),
        "CheckpointMismatch",
        lastCheckpoint(rs),
      );
    },
    TIMEOUT,
  );

  it(
    "replay_evaluates_a_dynamic_import_where_the_log_has_it",
    async () => {
      // The deploy step rewrote the page's import() into the seam.
      expect(
        fs.readFileSync(path.join(rr.build, "resources.js"), "utf-8"),
      ).toContain("__ctBoundaryImport");
      const { records: rs, slots } = await rr.recordPage(
        "resources.html?case=import&delay=300",
      );
      expectImportLast(orderOf(slots));
      expect(slots).toContain("module=true");
      // The recorder declares the seam, which is what lets replay order it.
      expect((rs[0] as RecordOf<"Header">).capabilities).toBe(
        '["import-seam"]',
      );
      const reg = indexWhere(rs, "TaskReg", (t) => t.kind === 13);
      const id = (rs[reg] as RecordOf<"TaskReg">).task_id;
      const task = indexWhere(rs, "Task", (t) => t.task_id === id);
      // The module's clock read, while it evaluated, before the import
      // settled.
      expect(rs[task - 1].record).toBe("Clock");
      expectReplayed(await rr.replay(rs), rs);
      expectReplayed(await rr.replay(rs, slow("/resources-mod.js", 800)), rs);
      // The module arrives at once while the image holds the replay back:
      // it evaluates only where the log has its reads.
      expectReplayed(
        await rr.replay(rs, slow("/slow-load-pixel.svg", 800)),
        rs,
      );
      // The same log without the declaration: replay does not trust the
      // log to order the import, and refuses it at the call.
      const undeclared = await rr.replay(
        replaced<"Header">(rs, 0, { capabilities: "[]" }),
      );
      expectDiverged(undeclared, "NonReplayable", seqAt(rs, reg));
      expect(undeclared.divergence?.detail).toContain('"dynamic-import"');
    },
    TIMEOUT,
  );

  it(
    "replay_refuses_a_dynamic_import_the_deploy_step_left_without_the_seam",
    async () => {
      // The default deploy step leaves the page's own code as it was.
      const script = fs.readFileSync(
        path.join(plain.build, "resources.js"),
        "utf-8",
      );
      expect(script).toContain(`import("./resources-mod.js" + slow)`);
      expect(script).not.toContain("__ctBoundaryImport");
      const { records: rs, slots } = await plain.recordPage(
        "resources.html?case=import&delay=300",
      );
      // The page behaved as it does with the seam.
      expectImportLast(orderOf(slots));
      expect(slots).toContain("module=true");
      // Nothing declares or orders the import.
      expect((rs[0] as RecordOf<"Header">).capabilities).toBe("[]");
      expect(rs.some((r) => r.record === "TaskReg" && r.kind === 13)).toBe(
        false,
      );
      // Replay reaches the page's call (in the `load` listener, just after
      // it set its timer) and refuses the session from there: typed, at
      // that point of the log, and no trace.
      const timerReg = indexWhere(rs, "TaskReg", (t) => t.kind === 1, 0);
      const loaded = indexWhere(rs, "DocTask", (d) => d.kind === 3);
      expect(timerReg).toBeGreaterThan(loaded);
      const r = await plain.replay(rs);
      expectDiverged(r, "NonReplayable", seqAt(rs, timerReg + 1));
      expect(r.divergence?.detail).toContain('"dynamic-import"');
      expect(r.divergence?.detail).toContain("./resources-mod.js");
    },
    TIMEOUT,
  );

  it(
    "replay_holds_a_script_the_page_inserted_that_never_ran_while_recorded",
    async () => {
      const rs = await rr.record("resources.html?case=late");
      expect(
        rs.some(
          (r) => r.record === "DocTask" && r.src.includes("resources-late.js"),
        ),
      ).toBe(false);
      const answered: string[] = [];
      const r = await rr.replay(rs, {
        responseDelayMs: (url) => {
          answered.push(url);
          return 0;
        },
      });
      expectReplayed(r, rs);
      // Vacuity guard: the runner answered the page's other requests.
      expect(answered.some((u) => u.includes("resources.js"))).toBe(true);
      expect(answered.filter((u) => u.includes("resources-late.js"))).toEqual(
        [],
      );
    },
    TIMEOUT,
  );
});

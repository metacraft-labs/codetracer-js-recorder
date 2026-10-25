/**
 * Record a fixture page for real and replay its log, for the tests that hold
 * a replay to the recording (`replay-values.test.ts`,
 * `replay-resources.test.ts`; CodeTracer's JS-Boundary-Recording
 * specification §6, §7, §10).
 *
 * The fixture directory is copied into a build, which gets the generic shim
 * by the shipped deploy route (`bundle-manifest`, then `boundary-shim
 * --build-hash`, which inserts the bootstrap, and with `--import-seam` the
 * dynamic `import()` seam, when the suite asks for it), and is served by the real fixture server (`harness.ts`). A page is
 * recorded in headless Chromium until it sets `<body data-done="1">`, its log
 * read from the shim, and replayed by the real runner (`replaySession`)
 * against the same build.
 *
 * No mocks: the browser, the server and the runner are real.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect } from "vitest";

import {
  type BoundaryRecord,
  type RecordOf,
  decodeLog,
} from "../../packages/boundary-format/src/index.js";
import {
  type Browser,
  type ReplayOptions,
  type ReplayReport,
  loadPlaywright,
  logBytes,
  replaySession,
  seqAt,
  withRecordBefore,
  withRecordReplaced,
} from "../../packages/boundary-replay/src/index.js";
import { FIXTURES, type FixtureServer, startFixtureServer } from "./harness.js";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const RECORDER_CLI = path.join(REPO_ROOT, "packages/cli/dist/index.js");

/** The slice of Playwright's page these tests drive. */
export interface Page {
  goto(url: string, options?: { referer?: string }): Promise<unknown>;
  evaluate<T>(fn: () => T): Promise<T>;
  setInputFiles(selector: string, files: string): Promise<void>;
  click(selector: string): Promise<void>;
}
export interface Context {
  newPage(): Promise<Page>;
  setOffline(offline: boolean): Promise<void>;
  close(): Promise<void>;
}

/** A build of the fixtures, its server and a browser. */
export interface RecordReplay {
  browser: Browser;
  build: string;
  server: FixtureServer;
  /** A fresh temporary directory, removed by {@link RecordReplay.close}. */
  tmp(prefix: string): string;
  /**
   * Record `pagePath` (a path under the fixture server) until it is done;
   * `drive` acts on it first (user input, a second page). Returns the
   * decoded log.
   */
  record(
    pagePath: string,
    drive?: (page: Page, context: Context) => Promise<void>,
  ): Promise<BoundaryRecord[]>;
  /**
   * As {@link record}, and also what the page wrote into its result slots
   * (`<ul id="out">`'s items' text, in order) when it was done.
   */
  recordPage(
    pagePath: string,
    drive?: (page: Page, context: Context) => Promise<void>,
  ): Promise<{ records: BoundaryRecord[]; slots: string[] }>;
  /** Replay `records` against the build (verification only, no trace). */
  replay(
    records: BoundaryRecord[],
    options?: Partial<ReplayOptions>,
  ): Promise<ReplayReport>;
  close(): Promise<void>;
}

/**
 * Build the fixtures (`prepare` may add files first, before the build is
 * hashed), start their server and a browser. `importSeam` installs the shim
 * with the dynamic `import()` seam (`boundary-shim --import-seam`, §8.1).
 */
export async function startRecordReplay(
  prepare?: (build: string) => void,
  options: { importSeam?: boolean } = {},
): Promise<RecordReplay> {
  const tmpDirs: string[] = [];
  const tmp = (prefix: string): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(d);
    return d;
  };
  const browser = await loadPlaywright().chromium.launch({ headless: true });
  const build = path.join(tmp("ct-replay-build-"), "site");
  fs.mkdirSync(build);
  for (const f of fs.readdirSync(FIXTURES)) {
    fs.copyFileSync(path.join(FIXTURES, f), path.join(build, f));
  }
  prepare?.(build);
  const hash = execFileSync(
    process.execPath,
    [RECORDER_CLI, "bundle-manifest", build],
    { encoding: "utf-8" },
  ).trim();
  execFileSync(
    process.execPath,
    [
      RECORDER_CLI,
      "boundary-shim",
      build,
      "--build-hash",
      hash,
      ...(options.importSeam === true ? ["--import-seam"] : []),
    ],
    { stdio: "pipe" },
  );
  const server = await startFixtureServer(build);
  return {
    browser,
    build,
    server,
    tmp,
    async record(pagePath, drive) {
      return (await this.recordPage(pagePath, drive)).records;
    },
    async recordPage(pagePath, drive) {
      const context = (await browser.newContext()) as unknown as Context;
      try {
        const page = await context.newPage();
        await page.goto(`${server.origin}/${pagePath}`);
        if (drive !== undefined) await drive(page, context);
        await until(page, isDone, `${pagePath} to finish`);
        // Read through the shim's own control, after it stopped: the page's
        // reads of the document are not boundary reads.
        const got = await page.evaluate(() => {
          const shim = (globalThis as unknown as Record<string, unknown>)
            .__ctBoundaryShim as { stop(): void; log(): Uint8Array };
          shim.stop();
          const items = document.querySelectorAll("#out li");
          return {
            bytes: Array.from(shim.log()),
            slots: Array.from(items).map((li) => li.textContent ?? ""),
          };
        });
        return {
          records: decodeLog(Uint8Array.from(got.bytes), {
            inlineBodies: "batch",
          }).records,
          slots: got.slots,
        };
      } finally {
        await context.close();
      }
    },
    async replay(records, options = {}) {
      const file = path.join(tmp("ct-replay-log-"), "jsbound.log");
      fs.writeFileSync(file, logBytes(records));
      return replaySession({
        log: file,
        build,
        browser,
        timeoutMs: 60_000,
        ...options,
      });
    },
    async close() {
      await server.close();
      await browser.close();
      for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    },
  };
}

/** Poll `probe` from Node (an in-page poll would be recorded as the page's). */
export async function until(page: Page, probe: () => boolean, what: string) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (await page.evaluate(probe)) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

export const isDone = () => document.body?.getAttribute("data-done") === "1";
export const isReady = () => document.body?.getAttribute("data-ready") === "1";

/** The replay reached `End` and compared every checkpoint of the log. */
export function expectReplayed(
  r: ReplayReport,
  records: BoundaryRecord[],
): void {
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
export function expectDiverged(
  r: ReplayReport,
  kind: string,
  seq?: string,
): void {
  expect(r.status, r.error).toBe("diverged");
  expect(
    `${r.divergence?.kind} at ${r.divergence?.seq}`,
    r.divergence?.detail,
  ).toBe(`${kind} at ${seq ?? r.divergence?.seq}`);
}

/** The seq of the last checkpoint (where the page's values are compared). */
export function lastCheckpoint(records: BoundaryRecord[]): string {
  const i = records.map((r) => r.record).lastIndexOf("Checkpoint");
  return seqAt(records, i);
}

/** The index of the `nth` record of `kind` that `pred` accepts. */
export function indexWhere<K extends BoundaryRecord["record"]>(
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

/** `records` with the record at `at` changed by `change`. */
export function replaced<K extends BoundaryRecord["record"]>(
  records: BoundaryRecord[],
  at: number,
  change: Partial<RecordOf<K>>,
): BoundaryRecord[] {
  return withRecordReplaced(records, at, {
    ...(records[at] as RecordOf<K>),
    ...change,
  } as BoundaryRecord);
}

/**
 * `records` with inputs the browser dispatched written in before the final
 * checkpoint, for the events headless Chromium never dispatches (it never
 * hides, freezes or resumes a page, nor changes its languages): each input's
 * `Task{kind 5}` with the next task id the log would have minted, its
 * `Input` (no properties), and the `PlatformValue{src 8}` reads its
 * listeners make, as the shim writes them (seams-dom.ts `recordInput`,
 * seams-environment.ts). Renumbered, so the log still decodes strictly.
 */
export function withInputsBeforeEnd(
  records: BoundaryRecord[],
  inputs: {
    type: string;
    target: string;
    reads: [query: string, value: string][];
  }[],
): BoundaryRecord[] {
  let nextTask = 1n;
  for (const r of records) {
    if (
      (r.record === "Task" || r.record === "TaskReg") &&
      r.task_id >= nextTask
    ) {
      nextTask = r.task_id + 1n;
    }
  }
  let at = records.map((r) => r.record).lastIndexOf("Checkpoint");
  let out = records;
  const put = (r: BoundaryRecord) => {
    out = withRecordBefore(out, at++, r);
  };
  for (const { type, target, reads } of inputs) {
    const task_id = nextTask++;
    put({ record: "Task", seq: 0n, task_id, kind: 5 });
    put({
      record: "Input",
      seq: 0n,
      task_id,
      type,
      target,
      props: "{}",
      label: "",
    });
    for (const [query, value] of reads) {
      put({
        record: "PlatformValue",
        seq: 0n,
        src: 8,
        task_id: 0n,
        query,
        value,
      });
    }
  }
  return out;
}

/** The UTF-8 text of an inline `blobref`. */
export const utf8 = (b: { kind: string; bytes?: Uint8Array }) =>
  new TextDecoder().decode(b.bytes);

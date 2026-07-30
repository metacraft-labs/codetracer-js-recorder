/**
 * RS-M9 — Express web-request spans land in the container's span stream.
 *
 * Required by
 * `codetracer-specs/Planned-Features/Request-Panel-Live-Sessions.milestones.org`
 * §RS-M9 (`express_requests_land_in_span_stream`), plus the two controls the
 * milestone's structural claims need in order to be falsifiable.
 *
 * ## What is real here
 *
 * Everything. Each test records `test-programs/web/express/` through the
 * recorder's own `record` CLI: a real Express 4 app on a real `http.Server`
 * bound to loopback, serving real HTTP over TCP, producing a real CTFS `.ct`
 * container. The spans are read back through the **canonical Nim span
 * reader** (`initSpanStreamReader` / `settledSpans`, reached via the addon's
 * `readSpanStream` binding — the same decoder `ct print -f http` and the
 * db-backend use), so these assertions cannot drift from the real decoder the
 * way a JavaScript re-implementation of the wire format would.
 *
 * There are **no mocks** in this file — no fake server, no fake container, no
 * fake span data, and therefore no mock justification to give.
 *
 * ## Why the two extra tests exist
 *
 * `express_span_step_ranges_track_the_writers_counter` is the control for the
 * failure mode every prior language milestone in this initiative hit: a
 * recorder that counts its own `register_step` calls instead of reading the
 * writer's exec-event counter. Such a recorder produces the SAME step ids
 * whether or not column-aware encoding is on, because `DeltaColumn` events are
 * not `register_step` calls. The real counter does not: it advances for every
 * exec-stream event. Recording one schedule both ways and requiring the ranges
 * to move is the only assertion here that can actually catch that bug.
 *
 * `express_span_contiguity_reflects_the_event_loop` is the control for
 * `contiguous_on_one_thread`. Node multiplexes concurrent requests onto one
 * event loop and one exec stream, so the bit is genuinely variable: a handler
 * that runs to completion without yielding is contiguous, a handler that
 * awaits (or one whose range a sibling request's events fall into) is not.
 * Asserting only that it is false somewhere would pass on a recorder that
 * hard-coded false, so this requires BOTH values in one recording and requires
 * the concurrent schedule to produce overlap the sequential one does not.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { readSpans } from "../../packages/cli/src/read-spans-cmd.js";
import {
  SPAN_STATUS_UNKNOWN,
  SPAN_STATUS_OK,
  SPAN_STATUS_ERROR,
  SPAN_META_KEYS,
} from "../../packages/runtime/src/spans.js";
import * as expressMiddleware from "../../packages/express/src/index.js";

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const CLI_PATH = path.join(PROJECT_ROOT, "packages/cli/dist/index.js");
const DEMO_APP = path.join(PROJECT_ROOT, "test-programs/web/express");

/** One decoded span record, in the reader's wire field names. */
interface Span {
  span_id: number;
  parent_span_id: number;
  is_open: boolean;
  is_external: boolean;
  status: number;
  start_wall_ns: number;
  end_wall_ns: number;
  process_ord: number;
  thread_id: number;
  start_step: number;
  end_step: number;
  span_type: string;
  label: string;
  contiguous_on_one_thread: boolean;
  shares_timeline: boolean;
  concurrent_with_siblings: boolean;
  metadata: Array<[string, string]>;
}

/** `[method, path, body]` — the shape `index.js` reads from the environment. */
type ScheduledRequest = [string, string, string | null];

/**
 * The required schedule: five requests including an async handler
 * (`/api/reports/slow` awaits inside its handler) and an error path
 * (`/api/boom` throws).
 */
const REQUIRED_SCHEDULE: ScheduledRequest[] = [
  ["GET", "/api/users", null],
  ["POST", "/api/users", '{"name":"Carol"}'],
  ["GET", "/api/reports/slow", null],
  ["GET", "/api/boom", null],
  ["GET", "/api/users/999", null],
];

interface RecordOptions {
  schedule?: ScheduledRequest[];
  concurrent?: boolean;
  columnAware?: boolean;
}

interface Recording {
  traceDir: string;
  stdout: string;
  /** Settled view: last-record-wins per span id, ascending — what a panel shows. */
  settled: Span[];
  /** Every record in append order, in-flight `is_open` records included. */
  all: Span[];
}

/** Record the demo app under the CLI and decode the spans it wrote. */
function record(options: RecordOptions = {}): Recording {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-express-spans-"));
  const args = ["record", DEMO_APP, "-o", outDir];
  if (options.columnAware === false) args.push("--no-column-aware");

  const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], {
    cwd: PROJECT_ROOT,
    encoding: "utf-8",
    env: {
      ...process.env,
      CT_EXPRESS_REQUESTS: JSON.stringify(
        options.schedule ?? REQUIRED_SCHEDULE,
      ),
      CT_EXPRESS_CONCURRENT: options.concurrent ? "1" : "0",
    },
  });

  const traceDirs = fs
    .readdirSync(outDir)
    .filter((name) => name.startsWith("trace-"));
  expect(traceDirs, `no trace produced in ${outDir}`).toHaveLength(1);
  const traceDir = path.join(outDir, traceDirs[0]);

  return {
    traceDir,
    stdout,
    settled: JSON.parse(readSpans(traceDir, true)) as Span[],
    all: JSON.parse(readSpans(traceDir, false)) as Span[],
  };
}

/** A span's metadata as a lookup; absent keys read as `undefined`. */
function meta(span: Span): Record<string, string> {
  return Object.fromEntries(span.metadata);
}

function webRequests(spans: Span[]): Span[] {
  return spans.filter((s) => s.span_type === "web-request");
}

// ---------------------------------------------------------------------------
// express_requests_land_in_span_stream
// ---------------------------------------------------------------------------

describe("express_requests_land_in_span_stream", () => {
  it("records five real requests as five spans with correct step ranges", () => {
    const recording = record();

    // The server really answered: the driver printed one line per response
    // before the container was written.
    expect(recording.stdout).toContain("GET /api/users -> 200");
    expect(recording.stdout).toContain("GET /api/boom -> 500");

    const spans = webRequests(recording.settled);
    expect(spans).toHaveLength(REQUIRED_SCHEDULE.length);
    expect(spans.map((s) => s.span_id)).toEqual([1, 2, 3, 4, 5]);

    // Every request was published open first and settled second, so a
    // reader without last-record-wins would report ten rows.
    expect(recording.all).toHaveLength(REQUIRED_SCHEDULE.length * 2);
    const openRecords = recording.all.filter((s) => s.is_open);
    expect(openRecords).toHaveLength(REQUIRED_SCHEDULE.length);
    for (const open of openRecords) {
      // An in-flight row knows where it started and nothing about where it
      // ends — that is the whole point of publishing it.
      expect(open.status).toBe(SPAN_STATUS_UNKNOWN);
      expect(open.end_step).toBe(0);
      expect(open.end_wall_ns).toBe(0);
      expect(open.start_step).toBe(
        spans.find((s) => s.span_id === open.span_id)!.start_step,
      );
    }

    const expected = [
      {
        method: "GET",
        url: "/api/users",
        statusCode: 200,
        route: "/api/users",
        hasError: false,
      },
      {
        method: "POST",
        url: "/api/users",
        statusCode: 201,
        route: "/api/users",
        hasError: false,
      },
      {
        method: "GET",
        url: "/api/reports/slow",
        statusCode: 200,
        route: "/api/reports/slow",
        hasError: false,
      },
      {
        method: "GET",
        url: "/api/boom",
        statusCode: 500,
        route: "/api/boom",
        hasError: true,
      },
      {
        method: "GET",
        url: "/api/users/999",
        statusCode: 404,
        route: "/api/users/:userId",
        hasError: false,
      },
    ];

    spans.forEach((span, i) => {
      const want = expected[i];
      const m = meta(span);
      expect(m[SPAN_META_KEYS.method]).toBe(want.method);
      expect(m[SPAN_META_KEYS.url]).toBe(want.url);
      expect(m[SPAN_META_KEYS.route]).toBe(want.route);
      expect(Number(m[SPAN_META_KEYS.statusCode])).toBe(want.statusCode);
      expect(m[SPAN_META_KEYS.framework]).toBe("express");
      expect(span.label).toBe(`${want.method} ${want.url}`);
      expect(span.is_open).toBe(false);
      // Inline binding: the steps are in THIS container, which is the whole
      // point of the milestone — no sidecar, no second recording.
      expect(span.is_external).toBe(false);
      expect(span.parent_span_id).toBe(0);
      // One Node process per recording.
      expect(span.process_ord).toBe(0);
      // A 4xx is as failed as a 5xx, and a 404 the router chose is still an
      // error status even though no handler threw — status and message are
      // independent, so a recorder that set one whenever it set the other
      // would pass a weaker test than this.
      expect(span.status).toBe(
        want.statusCode >= 400 ? SPAN_STATUS_ERROR : SPAN_STATUS_OK,
      );
      expect((m[SPAN_META_KEYS.errorMessage] ?? "").length > 0).toBe(
        want.hasError,
      );
      // Well-formed timing and sizing, recorded rather than defaulted.
      expect(Number(m[SPAN_META_KEYS.durationMs])).toBeGreaterThanOrEqual(0);
      expect(Number(m[SPAN_META_KEYS.responseSize])).toBeGreaterThan(0);
      expect(span.start_wall_ns).toBeGreaterThan(0);
      expect(span.end_wall_ns).toBeGreaterThanOrEqual(span.start_wall_ns);
    });

    // The handler that threw says why.
    expect(meta(spans[3])[SPAN_META_KEYS.errorMessage]).toBe(
      "demo handler exploded",
    );
    // The ~50 ms awaiting handler is the row whose duration must be more
    // than "not zero".
    expect(Number(meta(spans[2])[SPAN_META_KEYS.durationMs])).toBeGreaterThan(
      40,
    );

    // --- step ranges -------------------------------------------------
    //
    // A sequential schedule on one event loop gives each request its own
    // interval of the one timeline: ascending, disjoint, non-empty.
    let previousEnd = 0;
    for (const span of spans) {
      expect(span.start_step).toBeGreaterThan(previousEnd);
      expect(span.end_step).toBeGreaterThan(span.start_step);
      previousEnd = span.end_step;
      // Every span shares the recording's single exec-stream ordering.
      expect(span.shares_timeline).toBe(true);
      // Each request entered on its own async context, which the recorder
      // maps to its own container thread.
      expect(span.thread_id).toBeGreaterThan(0);
    }
    expect(new Set(spans.map((s) => s.thread_id)).size).toBe(spans.length);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// express_span_step_ranges_track_the_writers_counter
// ---------------------------------------------------------------------------

describe("express_span_step_ranges_track_the_writers_counter", () => {
  it("moves every span's range when the writer emits extra exec events", () => {
    const columnAware = webRequests(record({ columnAware: true }).settled);
    const lineOnly = webRequests(record({ columnAware: false }).settled);

    expect(columnAware).toHaveLength(REQUIRED_SCHEDULE.length);
    expect(lineOnly).toHaveLength(REQUIRED_SCHEDULE.length);
    // Same schedule, so the two recordings describe the same requests.
    expect(columnAware.map((s) => s.label)).toEqual(
      lineOnly.map((s) => s.label),
    );

    // Column-aware encoding adds `DeltaColumn` exec events, which occupy
    // step ids but are NOT `register_step` calls.  A recorder counting its
    // own step calls would therefore report IDENTICAL ranges in both
    // recordings.  Requiring every range to widen is what makes
    // "we read the writer's counter" a checkable claim rather than a
    // comment.
    columnAware.forEach((span, i) => {
      const other = lineOnly[i];
      expect(span.start_step).toBeGreaterThan(other.start_step);
      expect(span.end_step - span.start_step).toBeGreaterThan(
        other.end_step - other.start_step,
      );
    });
  }, 180_000);
});

// ---------------------------------------------------------------------------
// express_span_contiguity_reflects_the_event_loop
// ---------------------------------------------------------------------------

describe("express_span_contiguity_reflects_the_event_loop", () => {
  it("takes both values sequentially and reports overlap only when concurrent", () => {
    // Three awaiting handlers plus three that never yield, so a concurrent
    // schedule genuinely interleaves rather than completing each request
    // before the next is dequeued.
    const schedule: ScheduledRequest[] = [
      ["GET", "/api/reports/slow", null],
      ["GET", "/api/users", null],
      ["GET", "/api/reports/slow", null],
      ["GET", "/api/users/2", null],
      ["GET", "/api/reports/slow", null],
      ["GET", "/static/app.css", null],
    ];

    const sequential = webRequests(record({ schedule }).settled);
    const concurrent = webRequests(
      record({ schedule, concurrent: true }).settled,
    );

    expect(sequential).toHaveLength(schedule.length);
    expect(concurrent).toHaveLength(schedule.length);

    // --- contiguity takes BOTH values in one sequential recording ------
    //
    // A handler that runs to completion inside one async context is a
    // contiguous run of the exec stream; one that awaits has its
    // continuation land on a different context, which the recorder maps to
    // a different container thread inside the span's own range.
    const seqContiguous = sequential.filter((s) => s.contiguous_on_one_thread);
    const seqSplit = sequential.filter((s) => !s.contiguous_on_one_thread);
    expect(seqContiguous.length).toBeGreaterThan(0);
    expect(seqSplit.length).toBeGreaterThan(0);
    // And it is the awaiting handler that is split, not an arbitrary one.
    for (const span of sequential) {
      if (span.label === "GET /api/reports/slow") {
        expect(span.contiguous_on_one_thread).toBe(false);
      }
    }
    expect(
      sequential.find((s) => s.label === "GET /api/users")!
        .contiguous_on_one_thread,
    ).toBe(true);

    // --- concurrency is measured, not declared ------------------------
    //
    // Nothing overlaps when requests are issued one at a time...
    expect(sequential.every((s) => !s.concurrent_with_siblings)).toBe(true);
    // ...and something does when they are all in flight at once, so the bit
    // cannot be passing as a constant in either direction.
    expect(
      concurrent.filter((s) => s.concurrent_with_siblings).length,
    ).toBeGreaterThan(1);

    // An overlapping span really does have a sibling inside its range.
    for (const span of concurrent.filter((s) => s.concurrent_with_siblings)) {
      const overlapping = concurrent.filter(
        (other) =>
          other.span_id !== span.span_id &&
          other.start_step <= span.end_step &&
          span.start_step <= other.end_step,
      );
      expect(overlapping.length).toBeGreaterThan(0);
    }

    // Sequential ranges are disjoint; the concurrent recording contains at
    // least one nested pair.  This is the structural difference the panel
    // needs `concurrent_with_siblings` to tell it about.
    const nested = concurrent.some((a) =>
      concurrent.some(
        (b) =>
          a.span_id !== b.span_id &&
          a.start_step < b.start_step &&
          b.end_step < a.end_step,
      ),
    );
    expect(nested).toBe(true);
  }, 240_000);
});

// ---------------------------------------------------------------------------
// The middleware's copy of the span contract must not drift
// ---------------------------------------------------------------------------

describe("express_middleware_shares_the_recorder_span_contract", () => {
  it("re-declares the same status values as packages/runtime/src/spans.ts", () => {
    // `@codetracer/express` deliberately re-declares these instead of
    // importing `@codetracer/runtime`: the middleware is loaded inside the
    // recorded app and is meant to stay installed in production, so it keeps
    // zero imports rather than dragging the recorder's whole module graph in
    // for two integers.  This is the guard that makes the duplication safe.
    expect(expressMiddleware.SPAN_STATUS_OK).toBe(SPAN_STATUS_OK);
    expect(expressMiddleware.SPAN_STATUS_ERROR).toBe(SPAN_STATUS_ERROR);
  });
});

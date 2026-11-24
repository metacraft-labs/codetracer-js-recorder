/**
 * The comparison of the conformance suite's non-interference leg
 * (`packages/boundary-conformance/src/noninterference.ts`; CodeTracer's
 * JS-Boundary-Recording specification §11.3.6 step 2, §9.9.3): what it
 * compares of two sessions' logs, and what it must still reject.
 *
 * The browser decides by its own timing whether a piece or the end of a
 * streamed response body comes in a network task of its own (a `Task` of
 * kind 4 with the request's task id, written just before the piece's
 * `WsMessage`) or is read inside the page's current task, with no `Task`
 * (§6). Two sessions of one fixture can therefore differ by that one record,
 * and every later `seq` by one, without any secret being involved: a
 * combined run of the boundary and browser suites under load recorded
 * exactly that for `sensitive-login` (codetracer-pm issue
 * 2026-11-08-non-interference-leg-compares-record-positions-that-browser-timing-can-shift).
 *
 * No mocks, and no browser: these are the leg's own comparison and checks,
 * called on logs written here. The browser's timing cannot be made to pick
 * one arm or the other on demand, so the two arms it can produce are
 * written out as records, in the shape the shim writes for a streamed
 * `fetch` (a `NetRequest`, its `TaskReg{kind 4}`, the response head, the
 * body's pieces and its end), and renumbered by the replay package's own
 * `renumber`, as the recorder numbers them. The browser-driven leg itself is
 * run in `sensitive.test.ts`, with its falsifier.
 */

import { describe, expect, it } from "vitest";

import type { BoundaryRecord } from "../../packages/boundary-format/src/index.js";
import {
  type FixturePair,
  firstDifference,
  fixtureNamed,
  PUBLIC_PROBE,
  runNoninterferenceChecks,
  type Session,
} from "../../packages/boundary-conformance/src/index.js";
import {
  renumber,
  withRecordBefore,
} from "../../packages/boundary-replay/src/index.js";

const utf8 = (s: string) => new TextEncoder().encode(s);
const inline = (s: string) => ({ kind: "inline" as const, bytes: utf8(s) });

/** The login request's ids, as in the observed failure. */
const REQ = 1n;
const TASK = 118n;
const OTHER_TASK = 119n;

/** A record with a placeholder `seq`; {@link renumber} sets every one. */
const rec = (r: Record<string, unknown>): BoundaryRecord =>
  ({ seq: 0n, ...r }) as unknown as BoundaryRecord;

const task = (id: bigint) => rec({ record: "Task", task_id: id, kind: 4 });

const piece = (req: bigint, body: string) =>
  rec({
    record: "WsMessage",
    req_id: req,
    dir: 1,
    frame: 0,
    event: "",
    last_event_id: "",
    data: inline(body),
  });

const bodyEnd = (req: bigint) =>
  rec({
    record: "WsMessage",
    req_id: req,
    dir: 4,
    frame: 0,
    event: "",
    last_event_id: "",
    data: inline('{"outcome":1}'),
  });

/**
 * One session of a login: the page posts the (holed) form, reads the
 * streamed answer piece by piece, then calls the declassifier whose output
 * is `output`. The first piece came in a task of its own; whether the
 * second piece and the end did is the browser's timing, left out here and
 * inserted by the tests.
 */
function session(output: string, url = "/login"): BoundaryRecord[] {
  return renumber([
    rec({
      record: "Header",
      vocab: 1,
      protocol_level: 0,
      recorder_id: "test",
      framework: "",
      build_hash: "00",
      session_id: "07",
      prev_session: "",
      capabilities: "[]",
    }),
    rec({
      record: "NetRequest",
      req_id: REQ,
      api: 1,
      method: "POST",
      url,
      body_digest: "ab",
    }),
    rec({ record: "TaskReg", task_id: TASK, kind: 4, delay_ms: 0 }),
    task(TASK),
    rec({
      record: "NetResponse",
      req_id: REQ,
      outcome: 5,
      status: 200,
      status_text: "OK",
      url: "",
      redirected: 0,
      response_type: 1,
      headers: "[]",
      body: inline(""),
    }),
    task(TASK),
    piece(REQ, '{"ok":'),
    piece(REQ, "true}"),
    bodyEnd(REQ),
    rec({ record: "Declassify", fn_id: "domain", output }),
    rec({ record: "Mark", name: "after", data: "{}" }),
    rec({ record: "End", last_seq: 0n, reason: 2 }),
  ]);
}

/** The index of the first record of `records` that satisfies `p`. */
function indexOf(
  records: readonly BoundaryRecord[],
  p: (r: BoundaryRecord) => boolean,
): number {
  const i = records.findIndex(p);
  if (i < 0) throw new Error("no such record");
  return i;
}

const isEnd = (r: BoundaryRecord) => r.record === "WsMessage" && r.dir === 4;
const isSecondPiece = (r: BoundaryRecord) =>
  r.record === "WsMessage" &&
  r.dir === 1 &&
  new TextDecoder().decode((r.data as { bytes: Uint8Array }).bytes) === "true}";

/** `records` with the body end's optional network task present. */
const withEndTask = (records: BoundaryRecord[], id = TASK) =>
  withRecordBefore(records, indexOf(records, isEnd), task(id));

describe("the non-interference comparison", () => {
  it("noninterference_comparison_ignores_the_optional_body_task_and_positions", () => {
    // The observed failure: with X the body's end came in a task of its
    // own, with Y it was already there. Nothing else differs but the
    // declassifier's output, which the comparison leaves out.
    const x = withEndTask(session("a"));
    const y = session("b");
    expect(x.length).toBe(y.length + 1);
    expect(firstDifference(x, y)).toBeUndefined();
    expect(firstDifference(y, x)).toBeUndefined();

    // A piece's task is as optional as the end's (§6), in either arm.
    const xPiece = withRecordBefore(
      session("a"),
      indexOf(session("a"), isSecondPiece),
      task(TASK),
    );
    expect(firstDifference(xPiece, y)).toBeUndefined();
    expect(firstDifference(xPiece, withEndTask(session("b")))).toBeUndefined();
  });

  it("noninterference_comparison_still_names_a_secret_dependent_difference", () => {
    // The falsifier's shape: a request whose URL depends on the secret,
    // after the shifted records. It is named with each side's own seq.
    const d = firstDifference(
      withEndTask(session("a", "/login?first=a")),
      session("b", "/login?first=b"),
    );
    expect(d).toMatch(
      /^record \d+ differs beyond Declassify\.output: with X \{"record":"NetRequest".*first=a.*\} at seq 2, with Y \{"record":"NetRequest".*first=b.*\} at seq 2$/,
    );

    // A body that differs is still compared: the task before it is
    // dropped, the WsMessage is not.
    const y = session("b");
    const yBody = renumber(
      y.map((r) =>
        isSecondPiece(r) ? { ...piece(REQ, "fals}"), seq: 0n } : r,
      ),
    );
    expect(firstDifference(withEndTask(session("a")), yBody)).toMatch(
      /with X \{"record":"WsMessage".*\}.*with Y \{"record":"WsMessage"/,
    );

    // A network task that is not right before a piece or the end of its
    // own request's body is not the optional one, and is compared.
    const strayTask = withRecordBefore(
      session("a"),
      indexOf(session("a"), (r) => r.record === "Declassify"),
      task(TASK),
    );
    expect(firstDifference(strayTask, y)).toMatch(
      /with X \{"record":"Task","task_id":"118","kind":4\}/,
    );
    const otherRequest = withEndTask(session("a"), OTHER_TASK);
    expect(firstDifference(otherRequest, y)).toMatch(
      /with X \{"record":"Task","task_id":"119","kind":4\}/,
    );

    // Each part of the recognition is needed. A task another request
    // registered, before this request's body end, is compared.
    const secondRequest = (records: BoundaryRecord[]) => {
      const at = indexOf(records, (r) => r.record === "Declassify");
      return renumber([
        ...records.slice(0, at),
        rec({
          record: "NetRequest",
          req_id: 2n,
          api: 1,
          method: "GET",
          url: "/other",
          body_digest: "",
        }),
        rec({ record: "TaskReg", task_id: OTHER_TASK, kind: 4, delay_ms: 0 }),
        ...records.slice(at),
      ]);
    };
    expect(
      firstDifference(withEndTask(secondRequest(session("a")), OTHER_TASK), y),
    ).toMatch(/with X \{"record":"Task","task_id":"119","kind":4\}/);
    // A task of another kind before the body end is compared.
    const timerTask = withRecordBefore(
      session("a"),
      indexOf(session("a"), isEnd),
      rec({ record: "Task", task_id: TASK, kind: 1 }),
    );
    expect(firstDifference(timerTask, y)).toMatch(
      /with X \{"record":"Task","task_id":"118","kind":1\}/,
    );
    // A request's task before a WsMessage that is not a body's piece or
    // end (a message, frame 1; a close, dir 3) is compared.
    for (const notBody of [
      { ...piece(REQ, "m"), frame: 1 },
      { ...piece(REQ, "{}"), dir: 3 },
    ] as BoundaryRecord[]) {
      const at = indexOf(session("a"), (r) => r.record === "Declassify");
      const x = renumber([
        ...session("a").slice(0, at),
        task(TASK),
        notBody,
        ...session("a").slice(at),
      ]);
      const yWith = renumber([...y.slice(0, at), notBody, ...y.slice(at)]);
      expect(firstDifference(x, yWith)).toMatch(
        /with X \{"record":"Task","task_id":"118","kind":4\}/,
      );
    }

    // A record more or fewer at the end is a difference too.
    const longer = renumber([
      ...y.slice(0, -1),
      rec({ record: "Mark", name: "extra", data: "{}" }),
      y[y.length - 1],
    ]);
    expect(firstDifference(longer, y)).toMatch(
      /with X \{"record":"Mark".*extra.*with Y \{"record":"End"/,
    );
  });

  it("noninterference_checks_pass_a_pair_shifted_by_the_optional_task", () => {
    // The checks the leg reports, on the observed pair: vacuity reads the
    // declassifier outputs in order, not at equal positions.
    const fixture = fixtureNamed("sensitive-login");
    const sessionOf = (secret: string, records: BoundaryRecord[]): Session => ({
      secret,
      records,
      recording: {
        interactionProblems: [],
        targets: {},
        pageUrl: "",
        batches: [utf8(`${PUBLIC_PROBE} ${records.length}`)],
      },
    });
    const pair: FixturePair = {
      fixture,
      a: sessionOf("Ab3@ex.com", withEndTask(session("a"))),
      b: sessionOf("ab3@ex.com", session("b")),
      discarded: [],
      earlier: [],
    };
    const status = Object.fromEntries(
      runNoninterferenceChecks(pair, 0).map((c) => [c.name, c.detail]),
    );
    expect(status.vacuity).toEqual([]);
    expect(status["differs-only-in-declassify"]).toEqual([]);

    // And vacuity still fails when no declassifier output differs.
    const same: FixturePair = {
      ...pair,
      b: sessionOf("ab3@ex.com", session("a")),
    };
    const sameStatus = Object.fromEntries(
      runNoninterferenceChecks(same, 0).map((c) => [c.name, c.detail]),
    );
    expect(sameStatus.vacuity.join(" ")).toMatch(
      /no Declassify\.output differs/,
    );
  });
});

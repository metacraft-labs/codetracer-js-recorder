/**
 * M25 — correlation markers and span coverage, end to end.
 *
 * Nothing here is mocked. A real program calls `__ct.markCorrelation` and
 * `__ct.markSpanCoverage`, it is recorded through the real CLI, the real
 * native addon and the real shared CTFS writer, and the resulting `.ct`
 * container is decoded with `ct-print` — the canonical reader — to see
 * what a consumer would actually find in it.
 *
 * Why this layer had to exist. Until this suite the ONLY marker coverage
 * in the repo was `tests/browser/browser-runtime.test.ts`, which asserts
 * on the JSON message the browser runtime enqueues. That path never
 * reaches the native addon, so the whole
 * `EVENT_MARKER -> marker side channel -> trace writer` chain — the one
 * `record` actually runs — was untested. A correlation marker's failure
 * mode is being INVISIBLE rather than broken: a payload whose field names
 * drift from `db-backend`'s `MarkerPayload` still writes, still decodes as
 * an event, and simply never pairs, with no error anywhere. That is
 * exactly the failure a test asserting on the recorder's own intermediate
 * data structure cannot see, and the reason every assertion below goes
 * through a decoder rather than through the recorder's internals.
 *
 * See `codetracer-specs/Testing/CTFS-Correlation-Marker-Contract.md`
 * §10.2 (one index, two kinds), §11a (one writer-library API, thin
 * bindings) and §11a.6 (a marker mints no step).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import {
  ctPrintAvailable,
  ctPrintFull,
  ctPrintCorrelationIndex,
  ctPrintCorrelationIndexText,
  ctPrintPath,
  findCtFile,
  type CtFullBundle,
  type CtFullEvent,
  type CtCorrelationIndex,
} from "../helpers/ct-print.js";

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const CLI_PATH = path.join(PROJECT_ROOT, "packages/cli/dist/index.js");

/** The OTel ids the fixture declares coverage for (W3C trace-context example). */
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";

/**
 * Nanoseconds since the Unix epoch — deliberately chosen with significant
 * digits BELOW the 2^53 boundary (`...123`), so a wire format that carried
 * it as a JavaScript number instead of a decimal string would visibly
 * round them away.
 */
const WALL_NS = "1750000000000000123";
const MONOTONIC_NS = "987654321000";

/**
 * The recorded program.
 *
 * Every declaration goes through a local binding that is either the real
 * runtime method or `Function.prototype` (a callable that does nothing and
 * that the instrumenter does not touch, unlike a `function () {}` written
 * here, which would be instrumented and would itself mint steps). That is
 * what makes the two recordings below comparable: both execute the exact
 * same statements and the exact same calls, and differ ONLY in whether a
 * marker reaches the trace.
 *
 * The two `order-flow` crossings are deliberate: the boundary label must
 * be interned once and reused, which is what `ensure_marker_id` being
 * hoisted out of the recorder's replay loop is for.
 */
const FIXTURE = `const declaring = process.env.CT_DECLARE_MARKERS === "1";
const mark = declaring
  ? globalThis.__ct.markCorrelation.bind(globalThis.__ct)
  : Function.prototype;
const cover = declaring
  ? globalThis.__ct.markSpanCoverage.bind(globalThis.__ct)
  : Function.prototype;

function placeOrder(orderId) {
  mark("send", "order-flow", orderId, "order " + orderId, "orderId");
  return orderId;
}

function receiveOrder(orderId) {
  mark("recv", "order-flow", orderId, "order " + orderId, "orderId");
  return orderId;
}

const sent = placeOrder("order-4242");
const received = receiveOrder(sent);
mark("sideways", "audit-log", 42, "forty-two", "answer");
cover(${JSON.stringify(TRACE_ID)}, ${JSON.stringify(SPAN_ID)}, ${JSON.stringify(WALL_NS)}, ${JSON.stringify(MONOTONIC_NS)});
console.log(received);
`;

/** One recording: the decoded container plus its correlation index. */
interface Recording {
  bundle: CtFullBundle;
  index: CtCorrelationIndex;
  indexText: string;
}

/** Record the fixture through the CLI and decode everything ct-print offers. */
function record(tmpDir: string, declaring: boolean): Recording {
  const tag = declaring ? "declaring" : "control";
  const programPath = path.join(tmpDir, `markers-${tag}.js`);
  fs.writeFileSync(programPath, FIXTURE);
  const outDir = path.join(tmpDir, `traces-${tag}`);

  const stdout = execFileSync(
    process.execPath,
    [CLI_PATH, "record", programPath, "--out-dir", outDir],
    {
      cwd: PROJECT_ROOT,
      env: { ...process.env, CT_DECLARE_MARKERS: declaring ? "1" : "0" },
      encoding: "utf-8",
      timeout: 60000,
    },
  );

  const match = stdout.match(/Trace written to:\s*(.+)/);
  if (!match) {
    throw new Error(`recorder did not report a trace directory:\n${stdout}`);
  }
  const ctFile = findCtFile(match[1].trim());
  return {
    bundle: ctPrintFull(ctFile),
    index: ctPrintCorrelationIndex(ctFile),
    indexText: ctPrintCorrelationIndexText(ctFile),
  };
}

/** Every event ct-print recognised as carrying a `MarkerPayload`. */
type MarkerEvent = Extract<CtFullEvent, { kind: "io" }>;

function markerEvents(bundle: CtFullBundle): MarkerEvent[] {
  return bundle.events.filter(
    (e): e is MarkerEvent =>
      e.kind === "io" && e.correlation_marker !== undefined,
  );
}

/** The exec-stream index of the (single) step recorded for `line`. */
function stepIndexOfLine(bundle: CtFullBundle, line: number): number {
  const steps = bundle.events.filter(
    (e): e is Extract<CtFullEvent, { kind: "step" }> =>
      e.kind === "step" && e.line === line,
  );
  if (steps.length !== 1) {
    throw new Error(
      `expected exactly one step on line ${line}, found ${steps.length}`,
    );
  }
  return steps[0].step_index;
}

/**
 * The 1-based lines of the fixture that call `mark(...)`.
 *
 * Derived from the fixture text rather than hard-coded, so editing the
 * program above cannot silently point the step-attribution assertions at
 * the wrong lines. Source order happens to be execution order here.
 */
const MARK_LINES = FIXTURE.split("\n")
  .map((text, index) => ({ text, line: index + 1 }))
  .filter(({ text }) => /^\s*mark\(/.test(text))
  .map(({ line }) => line);

/** The 1-based line of the fixture's single `cover(...)` call. */
const COVER_LINE =
  FIXTURE.split("\n").findIndex((text) => /^\s*cover\(/.test(text)) + 1;

describe("test_correlation_markers_recorded_end_to_end", () => {
  let tmpDir: string;
  let declared: Recording;
  let control: Recording;

  beforeAll(() => {
    // Loud, not skipped. A marker that is absent and a decoder that is
    // absent look identical from inside a test that returns early, and
    // "the suite was green" is precisely how an invisible marker survives
    // a fix cycle.
    if (!ctPrintAvailable()) {
      throw new Error(
        `ct-print not found at ${ctPrintPath()} — build it in ` +
          "codetracer-trace-format-nim (`just build-ct-print`) or set " +
          "CT_PRINT. This suite must not skip.",
      );
    }
    if (!fs.existsSync(CLI_PATH)) {
      throw new Error(
        `CLI not built at ${CLI_PATH} — run \`just build\` first. ` +
          "This suite must not skip.",
      );
    }
    // The fixture and the assertions have to agree on how many
    // declarations there are; a fixture edit that broke the derivation
    // would otherwise weaken every assertion below without failing.
    if (MARK_LINES.length !== 3) {
      throw new Error(
        `expected 3 mark() calls in the fixture, derived ${MARK_LINES.length}`,
      );
    }
    if (COVER_LINE < 1) {
      throw new Error("could not locate the fixture's cover() call");
    }
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-markers-"));
    declared = record(tmpDir, true);
    control = record(tmpDir, false);
  }, 180000);

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes one decodable MarkerPayload per declared crossing", () => {
    const markers = markerEvents(declared.bundle);
    expect(markers).toHaveLength(3);

    // ct-print hoists these three to the TOP LEVEL of the event, and only
    // does so when the metadata slot parsed as a complete marker payload.
    // Asserting on the hoisted copies therefore also asserts that the
    // payload decoded — the property a drifted field name would break.
    expect(markers.map((m) => m.boundary_id)).toEqual([
      "order-flow",
      "order-flow",
      "audit-log",
    ]);
    expect(markers.map((m) => m.direction)).toEqual(["send", "recv", "send"]);
    expect(markers.map((m) => m.key_value)).toEqual([
      "order-4242",
      "order-4242",
      "42",
    ]);
  });

  it("carries the binding name in show_text, not the placeholder", () => {
    const markers = markerEvents(declared.bundle);

    // The reason `show_text` is a parameter of the shared writer API at
    // all: it names the binding a cross-process origin chain resumes its
    // walk on in the SENDING recording. The shared writer substitutes the
    // literal "show" when a caller passes nothing, and a marker carrying
    // that placeholder is visible with its history unreachable — the exact
    // "not broken, just useless" failure this contract is about.
    expect(markers.map((m) => m.correlation_marker?.show_text)).toEqual([
      "orderId",
      "orderId",
      "answer",
    ]);
    expect(markers.map((m) => m.correlation_marker?.show_value)).toEqual([
      "order order-4242",
      "order order-4242",
      "forty-two",
    ]);
    for (const m of markers) {
      expect(m.correlation_marker?.key_text).toBe("key");
    }
  });

  it("normalises an unrecognised direction to send rather than dropping it", () => {
    // The fixture's third crossing asks for "sideways". A marker with a
    // direction the pair index cannot deserialise vanishes from that index
    // silently, so an unpairable marker is worse than one that picked a
    // side.
    const audit = markerEvents(declared.bundle).find(
      (m) => m.boundary_id === "audit-log",
    );
    expect(audit).toBeDefined();
    expect(audit?.correlation_marker?.direction).toBe("send");
  });

  it("interns each boundary label once and agrees with the index", () => {
    const markers = markerEvents(declared.bundle);
    const [firstOrder, secondOrder, audit] = markers;

    // Two crossings of the same boundary share one interned id...
    expect(firstOrder.correlation_marker?.marker_id).toBe(
      secondOrder.correlation_marker?.marker_id,
    );
    // ...and a different boundary gets a different one, so the id really
    // identifies the boundary rather than being a constant.
    expect(audit.correlation_marker?.marker_id).not.toBe(
      firstOrder.correlation_marker?.marker_id,
    );

    // The index and the payload must name the same ids. They are written
    // by two different code paths (`corrmark.ns` vs the event's metadata
    // slot), and a lookup that finds an id the payload does not carry is
    // a marker no consumer can resolve.
    const boundaryEntries = declared.index.entries.filter(
      (e) => e.kind === "boundary",
    );
    expect(boundaryEntries).toHaveLength(3);
    const indexedIds = boundaryEntries.map((e) =>
      e.kind === "boundary" ? e.marker_id : -1,
    );
    const payloadIds = markers.map((m) => m.correlation_marker?.marker_id);
    expect([...indexedIds].sort()).toEqual([...payloadIds].sort());
  });

  it("indexes the declared span coverage under its own kind", () => {
    expect(declared.index.correlation_index).toBe("present");

    const spans = declared.index.entries.filter(
      (e) => e.kind === "span_coverage",
    );
    expect(spans).toHaveLength(1);
    const span = spans[0];
    if (span.kind !== "span_coverage") throw new Error("unreachable");

    // The ids come back as the wire bytes re-rendered in hex, which is
    // what proves `mark_span_coverage_hex` decoded the hex the program
    // passed rather than hashing the characters: an index keyed on the
    // hex rendering is present, correct-looking and permanently
    // unqueryable (contract §10.2 item 3).
    expect(span.trace_id).toBe(TRACE_ID);
    expect(span.span_id).toBe(SPAN_ID);

    // A span-coverage entry deliberately mints no MarkerPayload and no
    // event, so it must NOT show up among the boundary crossings.
    expect(markerEvents(declared.bundle)).toHaveLength(3);
  });

  it("preserves every digit of a nanosecond timestamp", () => {
    // Asserted against the TEXT report, not the JSON one: these counts
    // exceed Number.MAX_SAFE_INTEGER, so `JSON.parse` would round them and
    // the assertion would pass against a recorder that had already lost
    // the low digits on the way in.
    expect(declared.indexText).toContain(WALL_NS);
  });

  it("mints no step of its own", () => {
    // §11a.6, pinned: a marker attaches to the enclosing step. Minting one
    // would insert an exec-stream event no user code executed and shift
    // every later step index — and spans' start_step / end_step, and every
    // other step-addressed coordinate, are measured in those indices.
    //
    // The two recordings run the identical program with the identical
    // statements executed; only the declarations differ.
    expect(declared.bundle.counts.steps).toBe(control.bundle.counts.steps);

    // Guard against the comparison being vacuous — two recordings that
    // both declared nothing would satisfy the equality above for the
    // wrong reason.
    expect(markerEvents(declared.bundle).length).toBeGreaterThan(0);
    expect(markerEvents(control.bundle)).toHaveLength(0);
  });

  it("reports an undeclared recording as unindexed, not as covering nothing", () => {
    // Contract §9: a recording that was never indexed says NOTHING about
    // any span, while an indexed one that covers none is a definitive no.
    // Collapsing the two is what makes a lookup failure impossible to
    // place, so the control run has to be distinguishable.
    expect(control.index.correlation_index).toBe("absent");
    expect(control.index.entries).toHaveLength(0);
  });

  it("announces the index in the recording's header", () => {
    // `meta.dat` bit 14 (contract §12). It is a hint rather than a gate —
    // the container's file entry is the authority — but it is the cheapest
    // possible answer to "is this recording worth opening for a marker
    // lookup", and the flag must track reality in BOTH directions or it
    // is worse than absent.
    expect(declared.bundle.metadata.flags?.has_correlation_index).toBe(true);
    expect(control.bundle.metadata.flags?.has_correlation_index).toBe(false);
  });

  it("carries the marker in the metadata slot, with empty content", () => {
    // What the marker looks like as an event is now the SHARED WRITER's
    // decision, not this recorder's — `registerCorrelationMarkerById`
    // writes `registerIOEvent(ioStdout, [], payload)`.
    //
    // This changed when the recorder became a binding, and it is
    // user-visible, so it is pinned rather than left to drift: before,
    // this recorder wrote the marker as an `ioStderr` event whose content
    // was its own `{"key":…,"payload":…}` JSON. A marker now shows up in
    // an output view as an EMPTY STDOUT WRITE. Nothing is lost — the key
    // and the shown value are both in the payload above, and `ct-print
    // --markers` renders them — but a consumer that printed a marker's
    // content now prints nothing.
    for (const m of markerEvents(declared.bundle)) {
      expect(m.io_kind).toBe("ioStdout");
      expect(m.bytes_len).toBe(0);
      expect(m.text ?? "").toBe("");
    }
  });

  it("attaches each marker to the step for its own source line", () => {
    // A marker attaches to the ENCLOSING step — the line the call sits on
    // (contract §11a.6) — and the two places that record which step that
    // was must agree, because a marker that reports two different
    // coordinates is a marker whose location is undefined.
    //
    // Both halves of this are load-bearing and each catches a different
    // bug, so neither is redundant:
    //
    //   * `geid` in `corrmark.ns` is what an indexed lookup returns.
    //   * `step_id` on the IO event is what a consumer walking the event
    //     stream sees, and it is the one the debugger renders a marker at.
    //
    // Getting the second wrong by one is issue #601's failure ("the flow
    // view rendered the output one source line too high"), and it is not
    // hypothetical here: this recorder hit exactly that when it moved onto
    // the shared marker API, because `register_step` only BUFFERS its step
    // so that late-arriving values still attach to it, which means at the
    // moment a marker is declared the step for the marker's own line has
    // not been emitted yet and a naive `stepCount - 1` names the previous
    // one. The shared writer now derives one step id for both coordinates
    // (`enclosingStepId` in `codetracer_trace_writer_ffi.nim`), so this
    // asserts they are the same number AND that the number is right.
    const markerSteps = MARK_LINES.map((l) =>
      stepIndexOfLine(declared.bundle, l),
    );

    const eventSteps = markerEvents(declared.bundle)
      .map((m) => m.step_id)
      .sort((a, b) => a - b);
    expect(eventSteps).toEqual([...markerSteps].sort((a, b) => a - b));

    const geids = declared.index.entries
      .filter((e) => e.kind === "boundary")
      .map((e) => e.geid)
      .sort((a, b) => a - b);
    expect(geids).toEqual(eventSteps);
  });

  it("attaches the span-coverage declaration to its own source line too", () => {
    // Span coverage writes no event, so `geid` is its ONLY coordinate and
    // nothing cross-checks it — which is exactly why it is worth pinning
    // separately rather than assuming the boundary-crossing assertion
    // above covers it. It goes through a different shared-writer entry
    // point (`registerSpanCoverageHex`), and an entry point that forgot
    // the step id would still produce a findable, correct-looking index.
    const span = declared.index.entries.find((e) => e.kind === "span_coverage");
    expect(span).toBeDefined();
    expect(span?.geid).toBe(stepIndexOfLine(declared.bundle, COVER_LINE));
  });

  it("still records the program's own output alongside the markers", () => {
    // A marker rides the IO event stream. If lowering one disturbed the
    // stream the program's actual output would be the casualty, and that
    // is a user-visible break rather than a debugger-only one.
    const stdout = declared.bundle.events.filter(
      (e): e is MarkerEvent =>
        e.kind === "io" && e.correlation_marker === undefined,
    );
    expect(stdout.some((e) => (e.text ?? "").includes("order-4242"))).toBe(
      true,
    );
  });
});

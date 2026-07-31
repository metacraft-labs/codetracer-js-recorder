/**
 * M26 verification suite: browser-side JavaScript recorder.
 *
 * Pins the browser runtime + the AOT CLI + the Vite plugin against the
 * milestone's verification tests.  Headless-Chrome / Vite-dev-server
 * end-to-end paths are SKIPPed narrowly when the host shell does not
 * have browser infrastructure (per the M5 SKIP discipline).
 *
 * Cross-references:
 *   * `codetracer-specs/Planned-Features/Value-Origin-Tracking.milestones.org` M26.
 *   * `codetracer-specs/GUI/Debugging-Features/Value-Origin-Tracking.md` §14.4.
 */

import { describe, it, expect } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { spawnSync } from "node:child_process";

import {
  createBrowserRuntime,
  resolveEndpoint,
  encodeValue,
} from "@codetracer/runtime-browser";
import type {
  BrowserTransport,
  TransportFactory,
  BrowserEvent,
} from "@codetracer/runtime-browser";
import { codetracerVitePlugin } from "@codetracer/vite-plugin";
import { codetracerWebpackLoader } from "@codetracer/webpack-plugin";
import { codetracerEsbuildPlugin } from "@codetracer/esbuild-plugin";
import { codetracerRollupPlugin } from "@codetracer/rollup-plugin";
import { instrument } from "@codetracer/instrumenter-core";

// ── Fake WebSocket transport ────────────────────────────────────────────

/**
 * Synchronous in-memory transport so tests can pin the exact sequence
 * of events without spinning a real WebSocket server.  The transport
 * starts in OPEN state (readyState === 1) so events flush immediately.
 */
class FakeTransport implements BrowserTransport {
  public readonly sentBatches: string[] = [];
  public readyState = 1; // OPEN
  public closed = false;
  public onopen?: () => void;
  send(payload: string): void {
    if (this.closed) throw new Error("send on closed transport");
    this.sentBatches.push(payload);
  }
  close(): void {
    this.closed = true;
  }
  /** Convenience: parse all received lines from all batches. */
  receivedEvents(): BrowserEvent[] {
    const events: BrowserEvent[] = [];
    for (const batch of this.sentBatches) {
      for (const line of batch.split("\n")) {
        const trimmed = line.trim();
        if (trimmed) events.push(JSON.parse(trimmed));
      }
    }
    return events;
  }
}

function makeFactory(transport: FakeTransport): TransportFactory {
  return () => transport;
}

// ── Verification test 1: browser runtime emits JSON over WebSocket ──────
//
// Pins the first 10 events the runtime ships against the canonical
// vocabulary order: `SessionStart`, `Manifest`, then the user-emitted
// `Step` / `Call` / `Assignment` / etc. mix.

describe("test_browser_runtime_emits_json_events_over_websocket", () => {
  it("emits the canonical event sequence as newline-delimited JSON", () => {
    const transport = new FakeTransport();
    const runtime = createBrowserRuntime({
      transportFactory: makeFactory(transport),
      flushThreshold: 1, // flush every event for deterministic assertion
      manifest: { formatVersion: 1, paths: [], functions: [], sites: [] },
      program: "fixture-page",
      args: [],
    });
    // Simulate the instrumented page calling the runtime.
    runtime.step(0);
    runtime.enter(0, [42, "hello"] as unknown as IArguments);
    runtime.write(7);
    runtime.value("x", 10);
    runtime.ret(0, true);
    runtime.markCorrelation("send", "outbound", "key-1", { payload: "p" });
    runtime.stop();

    const events = transport.receivedEvents();
    // Expected order: SessionStart, Manifest, Step, Call, Assignment,
    // Value, Return, CorrelationMarker, SessionEnd.
    expect(events.length).toBeGreaterThanOrEqual(9);
    expect(events[0].kind).toBe("SessionStart");
    expect(events[1].kind).toBe("Manifest");
    expect(events[2].kind).toBe("Step");
    expect(events[3].kind).toBe("Call");
    expect(events[4].kind).toBe("Assignment");
    expect(events[5].kind).toBe("Value");
    expect(events[6].kind).toBe("Return");
    expect(events[7].kind).toBe("CorrelationMarker");
    expect(events[8].kind).toBe("SessionEnd");

    // Spot-check encoding correctness.
    const callEvt = events[3] as Extract<BrowserEvent, { kind: "Call" }>;
    expect(callEvt.fnId).toBe(0);
    expect(callEvt.args).toHaveLength(2);
    expect(callEvt.args[0].typeKind).toBe("Int");
    expect(callEvt.args[0].value).toBe(42);
    expect(callEvt.args[1].typeKind).toBe("String");
    expect(callEvt.args[1].value).toBe("hello");
  });

  it("respects `window.__codetracer_endpoint` global override", () => {
    const explicitGlobal = { __codetracer_endpoint: "ws://example:9999/x" };
    expect(resolveEndpoint(undefined, explicitGlobal)).toBe(
      "ws://example:9999/x",
    );
    // Explicit option wins over the global.
    expect(resolveEndpoint("ws://custom/y", explicitGlobal)).toBe(
      "ws://custom/y",
    );
  });

  it("defaults to ws://localhost:9230/ct-stream when nothing is configured", () => {
    expect(resolveEndpoint(undefined, {})).toBe(
      "ws://localhost:9230/ct-stream",
    );
  });
});

// ── Verification test 2: daemon translates JSON events to .ct ────────────
//
// We cannot reach into the Rust receiver from Vitest, but we *can* pin
// the JSON-side contract: the events the browser runtime emits must
// parse cleanly into the receiver's `BrowserEvent` vocabulary.  The
// Rust-side round-trip is verified by the receiver's unit tests
// (`browser_stream_receiver::tests::full_session_round_trips_to_in_memory_writer`).

describe("test_daemon_translates_browser_json_events_to_ct_file", () => {
  it("produces JSON that mirrors the receiver's TypeScript vocabulary", () => {
    const transport = new FakeTransport();
    const runtime = createBrowserRuntime({
      transportFactory: makeFactory(transport),
      flushThreshold: 1,
      manifest: {
        formatVersion: 1,
        paths: ["app.js"],
        functions: [],
        sites: [],
      },
    });
    runtime.step(0);
    runtime.write(1);
    runtime.stop();

    const events = transport.receivedEvents();
    // Every event must have a discriminator that matches the Rust
    // receiver's `#[serde(tag = "kind")]` variant names.
    const validKinds = new Set([
      "SessionStart",
      "Manifest",
      "Path",
      "Step",
      "Call",
      "Return",
      "Assignment",
      "Value",
      "Write",
      "CorrelationMarker",
      "SessionEnd",
    ]);
    for (const evt of events) {
      expect(validKinds.has(evt.kind)).toBe(true);
    }
    // `Assignment` events must carry `siteId`, not `site_id` (the wire
    // uses camelCase; serde rename_all is configured on the Rust side).
    const assignment = events.find((e) => e.kind === "Assignment");
    expect(assignment).toBeDefined();
    expect((assignment as { siteId: number }).siteId).toBe(1);
  });
});

// ── Verification test 3: marker-only network correlation (no fetch shim) ──

describe("test_browser_recorder_emits_network_send_on_fetch", () => {
  it("emits a CorrelationMarker for a user-placed send marker (no fetch shim)", () => {
    const transport = new FakeTransport();
    const runtime = createBrowserRuntime({
      transportFactory: makeFactory(transport),
      flushThreshold: 1,
    });
    // The user's page code calls `__ct.markCorrelation('send', ...)`
    // BEFORE encoding the request body.  The runtime emits the marker
    // event verbatim — there is no fetch / XHR / WebSocket shim
    // intercepting the actual network call.
    const requestId = "request-42";
    runtime.markCorrelation("send", "outbound", requestId);
    // (the page would call fetch(...) here; no shim runs)
    runtime.stop();

    const events = transport.receivedEvents();
    const marker = events.find(
      (e): e is Extract<BrowserEvent, { kind: "CorrelationMarker" }> =>
        e.kind === "CorrelationMarker",
    );
    expect(marker).toBeDefined();
    expect(marker!.direction).toBe("send");
    expect(marker!.boundary).toBe("outbound");
    expect(marker!.key).toBe(requestId);
  });

  it("ships zero protocol-specific events when the page makes raw network calls without markers", () => {
    const transport = new FakeTransport();
    const runtime = createBrowserRuntime({
      transportFactory: makeFactory(transport),
      flushThreshold: 1,
    });
    // No `markCorrelation` call — the runtime must not synthesise one
    // even if the page invokes `fetch(...)` directly.  The page would
    // call fetch here; we don't, because the runtime has no shim that
    // would observe it anyway.
    runtime.step(0);
    runtime.stop();

    const events = transport.receivedEvents();
    const markers = events.filter((e) => e.kind === "CorrelationMarker");
    expect(markers).toHaveLength(0);
  });
});

// ── Verification test 4: ct instrument CLI AOT produces drop-in bundle ──

describe("test_ct_instrument_cli_aot_produces_drop_in_bundle", () => {
  it("emits an instrumented bundle + manifest + browser-runtime stub", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ct-m26-aot-"));
    const srcFile = path.join(tmp, "app.js");
    fs.writeFileSync(
      srcFile,
      "function greet(name) { const greeting = 'hi ' + name; return greeting; }\ngreet('world');\n",
    );
    const outDir = path.join(tmp, "out");

    const cli = path.resolve(
      __dirname,
      "..",
      "..",
      "packages",
      "cli",
      "dist",
      "index.js",
    );
    if (!fs.existsSync(cli)) {
      console.warn(`SKIP: CLI dist not built at ${cli}; run \`npm run build\``);
      return;
    }
    const result = spawnSync(
      process.execPath,
      [
        cli,
        "instrument",
        srcFile,
        "--out",
        outDir,
        "--browser",
        "--endpoint",
        "ws://localhost:9230/ct-stream",
      ],
      { encoding: "utf-8" },
    );
    expect(result.status, `cli output: ${result.stderr}`).toBe(0);

    // 1. The instrumented file must exist and reference __ct.step/.write.
    const outFile = path.join(outDir, "app.js");
    expect(fs.existsSync(outFile)).toBe(true);
    const instrumented = fs.readFileSync(outFile, "utf-8");
    expect(instrumented).toMatch(/__ct\.step\(\d+\)/);

    // 2. The manifest sidecar must exist and be valid JSON.
    const manifestPath = path.join(outDir, "codetracer.manifest.json");
    expect(fs.existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    expect(manifest.formatVersion).toBe(1);
    expect(Array.isArray(manifest.paths)).toBe(true);

    // 3. The browser-runtime bootstrap stub must exist and install __ct.
    const stub = path.join(outDir, "codetracer-runtime.js");
    expect(fs.existsSync(stub)).toBe(true);
    const stubSrc = fs.readFileSync(stub, "utf-8");
    expect(stubSrc).toMatch(/globalThis\.__ct/);
    expect(stubSrc).toMatch(/WebSocket/);
    expect(stubSrc).toMatch(/ws:\/\/localhost:9230\/ct-stream/);
  });
});

// ── Verification test 5: Vite plugin instruments transform pipeline ──

describe("test_vite_plugin_instruments_during_dev_server_transform", () => {
  it("transforms matching modules and skips node_modules", () => {
    const sliceLog: Array<{ id: string; sites: number }> = [];
    const plugin = codetracerVitePlugin({
      endpoint: "ws://localhost:9230/ct-stream",
      onSlice: (id, slice) => sliceLog.push({ id, sites: slice.sites.length }),
    });

    // Source-of-truth: a small piece of JS the plugin should rewrite.
    const userSource = "function fn() { const x = 1; return x; }\nfn();\n";
    const result = plugin.transform(userSource, "/proj/src/app.js");
    expect(result).not.toBeNull();
    expect(result!.code).toMatch(/__ct\.step\(\d+\)/);
    // `__ct.write` takes the site id *and* the assigned value; matching
    // only the one-argument form would pass vacuously.
    expect(result!.code).toMatch(/__ct\.write\(\d+\s*,/);

    // node_modules paths must be skipped.
    const ignored = plugin.transform(
      userSource,
      "/proj/node_modules/foo/index.js",
    );
    expect(ignored).toBeNull();

    // The onSlice hook fired exactly once for the instrumented module.
    expect(sliceLog).toHaveLength(1);
    expect(sliceLog[0].id).toBe("/proj/src/app.js");
    expect(sliceLog[0].sites).toBeGreaterThan(0);

    // The HTML transform injects the endpoint global.
    const html = plugin.transformIndexHtml!(
      "<html><head><title>t</title></head><body></body></html>",
    );
    expect(html).toContain("window.__codetracer_endpoint");
    expect(html).toContain("ws://localhost:9230/ct-stream");

    // HMR: a changed module returns its own modules so Vite's default
    // HMR path takes over — i.e. only this module is re-instrumented.
    const fakeModule = { id: "/proj/src/app.js" } as unknown;
    const hmr = plugin.handleHotUpdate!({
      file: "/proj/src/app.js",
      modules: [fakeModule],
    });
    expect(hmr).toEqual([fakeModule]);
  });
});

// ── Verification tests 6-8: smoke tests for Webpack / esbuild / Rollup ──
//
// The plugins are thin wrappers around `@codetracer/instrumenter-core`;
// the smoke tests pin that wrapping by checking the wrapper rewrites a
// canonical source the same way the core does.  Full bundler-runner
// tests are deferred — see M26 note 2026-06 — because Webpack /
// esbuild / Rollup are not installed in the dev shell.

describe("test_webpack_plugin_smoke", () => {
  it("rewrites source identically to the core instrumenter", () => {
    const source =
      "function add(a, b) { const sum = a + b; return sum; }\nadd(1, 2);\n";
    const filename = "/proj/src/index.js";

    const direct = instrument(source, { filename });
    const wrapped = codetracerWebpackLoader(source, filename);
    expect(wrapped).not.toBeNull();
    expect(wrapped!.code).toBe(direct.code);

    // node_modules must be skipped.
    const ignored = codetracerWebpackLoader(
      source,
      "/proj/node_modules/x/index.js",
    );
    expect(ignored).toBeNull();
  });
});

describe("test_esbuild_plugin_smoke", () => {
  it("exposes the expected plugin shape and filter", () => {
    const plugin = codetracerEsbuildPlugin();
    expect(plugin.name).toBe("codetracer:instrument");
    expect(typeof plugin.setup).toBe("function");

    // Run setup against a fake build object; assert that onLoad is
    // called with a regex that matches both .ts and .js extensions.
    let captured: { filter: RegExp } | null = null;
    plugin.setup({
      onLoad(filter, _cb) {
        captured = filter;
      },
    });
    expect(captured).not.toBeNull();
    expect(captured!.filter.test("/proj/app.js")).toBe(true);
    expect(captured!.filter.test("/proj/app.ts")).toBe(true);
    expect(captured!.filter.test("/proj/app.tsx")).toBe(true);
    expect(captured!.filter.test("/proj/app.css")).toBe(false);
  });
});

describe("test_rollup_plugin_smoke", () => {
  it("rewrites source identically to the core instrumenter", () => {
    const source =
      "function double(n) { const r = n * 2; return r; }\ndouble(3);\n";
    const filename = "/proj/src/lib.js";

    const direct = instrument(source, { filename });
    const plugin = codetracerRollupPlugin();
    const wrapped = plugin.transform(source, filename);
    expect(wrapped).not.toBeNull();
    expect(wrapped!.code).toBe(direct.code);

    // node_modules must be skipped.
    const ignored = plugin.transform(source, "/proj/node_modules/x/index.js");
    expect(ignored).toBeNull();
  });
});

// ── Extra: the encoder is shared with the Node runtime semantics ──

describe("browser runtime value encoder mirrors Node runtime", () => {
  it("encodes primitives and arrays into TraceLowLevelEvent-compatible shapes", () => {
    expect(encodeValue(42)).toEqual({ value: 42, typeKind: "Int" });
    expect(encodeValue("hi")).toEqual({ value: "hi", typeKind: "String" });
    expect(encodeValue(null)).toEqual({ value: null, typeKind: "None" });
    expect(encodeValue([1, 2])).toEqual({
      value: [
        { value: 1, typeKind: "Int" },
        { value: 2, typeKind: "Int" },
      ],
      typeKind: "Seq",
    });
  });

  it("safely handles circular references", () => {
    const obj: Record<string, unknown> = {};
    obj.self = obj;
    const encoded = encodeValue(obj);
    expect(encoded.typeKind).toBe("Struct");
    const fields = (
      encoded.value as {
        fields: Array<{ name: string; value: { typeKind: string } }>;
      }
    ).fields;
    expect(fields[0].value.typeKind).toBe("Raw");
  });
});

// ── M38d: the flush policy has a time bound as well as a count bound ─────
//
// `codetracer-specs/Recording-Backends/WASM-Replay-Snapshots-And-Slices.md`
// §2 requires a consumer to be able to derive artefacts from this stream
// *while the page is still running*. A count-only policy makes that
// unreachable for any page producing fewer events than the threshold — most
// short pages, and every fixture in this repo — because the whole recording
// then reaches the daemon in one batch at `stop()`.
//
// These tests measure **arrival times against a transport that records
// them**, not a final total: a total cannot tell "delivered during the run"
// from "delivered at the end", which is the entire distinction under test.

const sleep = (ms: number) => new Promise((resume) => setTimeout(resume, ms));

/**
 * The interval the runtime defaults to. Duplicated here rather than
 * imported because it is not part of the package's public surface; the
 * test that pins the default (below) is what keeps the two in step, and it
 * fails loudly rather than silently waiting the wrong amount if they drift.
 */
const DEFAULT_FLUSH_INTERVAL_MS = 50;

/** A transport that timestamps every frame it receives and its own close. */
class TimingTransport implements BrowserTransport {
  public readonly arrivals: { at: number; payload: string }[] = [];
  public closedAt: number | null = null;
  public readyState = 1; // OPEN
  public onopen?: () => void;
  send(payload: string): void {
    this.arrivals.push({ at: performance.now(), payload });
  }
  close(): void {
    this.closedAt = performance.now();
  }
  receivedEvents(): BrowserEvent[] {
    const events: BrowserEvent[] = [];
    for (const arrival of this.arrivals) {
      for (const line of arrival.payload.split("\n")) {
        const trimmed = line.trim();
        if (trimmed) events.push(JSON.parse(trimmed));
      }
    }
    return events;
  }
}

describe("test_short_session_streams_before_stop", () => {
  it("delivers a sub-threshold session to the transport during the run", async () => {
    const transport = new TimingTransport();
    // No `flushThreshold` and no `flushIntervalMs`: the DEFAULTS are what
    // this pins, because "a default-configured page never streams" is the
    // defect.
    const rt = createBrowserRuntime({
      transportFactory: makeTimingFactory(transport),
      program: "short-page",
    });

    // `SessionStart` plus a handful of events — far below the 256-event
    // count threshold, so under a count-only policy nothing would leave
    // until `stop()`.
    rt.step(1);
    rt.enter(2, [7]);
    rt.ret(2, 42);
    expect(rt.bufferedCount).toBeGreaterThan(0);

    await sleep(DEFAULT_FLUSH_INTERVAL_MS * 4);

    // Asserted BEFORE anything stops the session. This observation is the
    // whole point and is not recoverable from a final total.
    expect(transport.arrivals.length).toBeGreaterThanOrEqual(1);
    expect(rt.bufferedCount).toBe(0);
    const kinds = transport.receivedEvents().map((e) => e.kind);
    expect(kinds).toContain("SessionStart");
    expect(kinds).toContain("Call");
    expect(kinds).toContain("Return");

    rt.stop();
    for (const arrival of transport.arrivals.slice(0, -1)) {
      expect(arrival.at).toBeLessThan(transport.closedAt as number);
    }
  });

  it("holds everything to stop() when the time-based flush is disabled", async () => {
    // The negative control. Without it the test above would pass equally
    // against a runtime that shipped on every event, and would say nothing
    // about which bound delivered the batch.
    const transport = new TimingTransport();
    const rt = createBrowserRuntime({
      transportFactory: makeTimingFactory(transport),
      program: "short-page",
      flushIntervalMs: 0,
    });
    rt.step(1);
    rt.enter(2, [7]);

    await sleep(DEFAULT_FLUSH_INTERVAL_MS * 4);
    expect(transport.arrivals.length).toBe(0);
    expect(rt.bufferedCount).toBeGreaterThan(0);

    rt.stop();
    expect(transport.arrivals.length).toBe(1);
  });

  it("still honours an explicit flushThreshold exactly", async () => {
    // The time bound is added ALONGSIDE the count bound, not in place of
    // it: a page that asks for a frame per event still gets one, and a
    // count-driven flush cancels the deadline it satisfied rather than
    // leaving a timer to ship an empty frame later.
    const transport = new TimingTransport();
    const rt = createBrowserRuntime({
      transportFactory: makeTimingFactory(transport),
      program: "eager-page",
      flushThreshold: 1,
    });
    const afterConstruction = transport.arrivals.length;
    expect(afterConstruction).toBeGreaterThanOrEqual(1);
    rt.step(1);
    expect(transport.arrivals.length).toBe(afterConstruction + 1);

    await sleep(DEFAULT_FLUSH_INTERVAL_MS * 4);
    expect(transport.arrivals.length).toBe(afterConstruction + 1);
    rt.stop();
  });

  it("measures the deadline from a batch's first event, not its last", async () => {
    // A steady dribble must not be able to postpone its own delivery:
    // re-arming on every event would let a page emitting one event every
    // 10ms hold a batch indefinitely against a 40ms interval.
    const transport = new TimingTransport();
    const rt = createBrowserRuntime({
      transportFactory: makeTimingFactory(transport),
      program: "dribble-page",
      flushIntervalMs: 40,
    });
    for (let i = 0; i < 8; i++) {
      rt.step(i);
      await sleep(10);
    }
    expect(transport.arrivals.length).toBeGreaterThanOrEqual(1);
    rt.stop();
  });
});

function makeTimingFactory(transport: TimingTransport): TransportFactory {
  return () => transport;
}

/** Direct owner-library exercise: genuine browser fetch/Response/streams, not a
 * substitute cursor, transport or scheduler. The small timer bridge observes
 * original native timers on record and registers with the real owned loop on
 * replay, using the SAME task allocator as network/platform work. Level0 DOM
 * checkpoints qualify this library only, not framework privacy/conformance.
 */
import { createRecordFetch } from "../../../packages/boundary-shim/src/browser/seams-net.js";
import { createReplayFetch } from "../../../packages/boundary-shim/src/browser/replay/net.js";
import { Recorder } from "../../../packages/boundary-shim/src/browser/recorder.js";
import { captureOriginals } from "../../../packages/boundary-shim/src/browser/originals.js";
import {
  readEnvironment,
  installBoundaryShim,
} from "../../../packages/boundary-shim/src/browser/install.js";
import { installReplayShim } from "../../../packages/boundary-shim/src/browser/replay/install.js";
import { domV1Hash } from "../../../packages/boundary-shim/src/browser/dom-v1.js";
import {
  sensitiveState,
  currentSensitiveValues,
} from "../../../packages/boundary-shim/src/browser/sensitive.js";
import { sanitizeRecord } from "../../../packages/boundary-shim/src/browser/record-scrub.js";
import { NO_SCRUB_LISTS } from "../../../packages/boundary-shim/src/browser/scrub.js";
import { decodeLog } from "../../../packages/boundary-format/src/index.js";
import { installReplayRuntime } from "../../../packages/boundary-replay/src/browser/runtime.js";

const encode = (bytes) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const serial = (value) =>
  JSON.parse(
    JSON.stringify(value, (_, v) => (typeof v === "bigint" ? String(v) : v)),
  );
const originals = () => [
  window.fetch,
  window.XMLHttpRequest,
  window.WebSocket,
  window.EventSource,
  navigator.sendBeacon,
  window.setTimeout,
  window.requestAnimationFrame,
  Object.getOwnPropertyDescriptor(window, "fetch"),
];
const same = (before) => {
  const after = originals(),
    a = after.at(-1),
    b = before.at(-1);
  return (
    after.slice(0, -1).every((v, i) => v === before[i]) &&
    Reflect.ownKeys(a).length === Reflect.ownKeys(b).length &&
    Reflect.ownKeys(a).every((k) => a[k] === b[k])
  );
};
const descriptors = () => [
  Object.getOwnPropertyDescriptor(Response.prototype, "url").get,
  Response.prototype.clone,
  Response.prototype.text,
  Headers.prototype.set,
];
const matching = (before) => descriptors().every((v, i) => v === before[i]);
const caught = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    return { name: e.name, message: e.message };
  }
};

function recordContext(orig = captureOriginals(window)) {
  const sensitive = sensitiveState(window),
    holes = () => currentSensitiveValues(window, sensitive);
  const rec = new Recorder({
    checkpointScheme: "dom-v1",
    checkpointHash: () => domV1Hash(document),
    sanitize: (r) => sanitizeRecord(r, NO_SCRUB_LISTS, holes),
  });
  rec.start(
    {
      vocab: 1,
      protocol_level: 0,
      recorder_id: "fetch-library-test",
      framework: "",
      build_hash: "a".repeat(64),
      session_id: "1".repeat(32),
      prev_session: "",
      capabilities: "[]",
    },
    readEnvironment(window, orig),
  );
  const refused = new Set();
  return {
    w: window,
    rec,
    orig,
    sensitive,
    holes,
    refuseOnce(feature, detail) {
      if (refused.has(feature)) return;
      refused.add(feature);
      rec.emit("Refusal", { feature, detail });
    },
  };
}
function replayContext(replay) {
  let task = 1n,
    req = 1n;
  const sensitive = sensitiveState(window);
  return {
    w: window,
    replay,
    orig: replay.originals,
    holes: () => currentSensitiveValues(window, sensitive),
    nextTaskId: () => task++,
    nextReqId: () => req++,
  };
}
function bridgeDelay(ctx, record) {
  return (ms) =>
    new ctx.orig.Promise((resolve) => {
      const id = record ? ctx.rec.nextTaskId() : ctx.nextTaskId();
      if (record) {
        ctx.rec.emit("TaskReg", { task_id: id, kind: 1, delay_ms: ms });
        ctx.orig.setTimeout.call(
          window,
          () => {
            ctx.rec.task(id, 1);
            resolve();
          },
          ms,
        );
      } else {
        ctx.replay.registerTask(id, 1, ms);
        ctx.replay.onTask(id, () => {
          ctx.replay.offTask(id);
          resolve();
        });
      }
    });
}
async function workflow(mode, call, delay, reuse) {
  const out = [];
  if (mode.startsWith("abort-consumer:")) {
    const [, consumer, copy, reason] = mode.split(":"),
      ac = new AbortController();
    const r = await call("/api/slow?consumer=" + consumer, {
        signal: ac.signal,
      }),
      target = copy === "clone" ? r.clone() : r;
    let settled = false,
      pendingBeforeAbort = false,
      abortCalls = 0;
    const reading = target[consumer]();
    reading.then(
      () => (settled = true),
      () => (settled = true),
    );
    const stop = delay(15).then(() => {
      pendingBeforeAbort = !settled;
      abortCalls++;
      if (reason === "default") ac.abort();
      else if (reason === "dom")
        ac.abort(new DOMException("custom body stop", "AbortError"));
      else ac.abort(new Error("custom error stop"));
    });
    try {
      await reading;
      out.push({ ok: true });
    } catch (e) {
      out.push({
        ok: false,
        name: e?.name,
        message: e?.message,
        sameReason: e === ac.signal.reason,
      });
    }
    await stop;
    out.push({ pendingBeforeAbort, abortCalls });
  } else if (mode === "abort-before") {
    const ac = new AbortController();
    ac.abort(new DOMException("stop before headers", "AbortError"));
    try {
      await call("/api/late-head", { signal: ac.signal });
    } catch (e) {
      out.push({
        error: e.name,
        message: e.message,
        same: e === ac.signal.reason,
      });
    }
  } else if (mode === "abort-head") {
    const ac = new AbortController();
    const p = call("/api/late-head", { signal: ac.signal });
    const stop = delay(15).then(() =>
      ac.abort(new DOMException("stop pending head", "AbortError")),
    );
    try {
      await p;
    } catch (e) {
      out.push({
        error: e.name,
        message: e.message,
        same: e === ac.signal.reason,
      });
    }
    await stop;
  } else if (mode === "failure-head") {
    try {
      await call("/api/fail");
    } catch (e) {
      out.push({ error: e.name, message: e.message });
    }
  } else if (mode === "abort-body") {
    const ac = new AbortController();
    const r = await call("/api/slow", { signal: ac.signal });
    const stop = delay(15).then(() =>
      ac.abort(new DOMException("stop body", "AbortError")),
    );
    try {
      await r.text();
    } catch (e) {
      out.push({
        error: e.name,
        message: e.message,
        same: e === ac.signal.reason,
      });
    }
    await stop;
  } else if (mode === "invalid-json") {
    const r = await call("/api/invalid-json");
    try {
      await r.json();
      out.push({ ok: true });
    } catch (e) {
      out.push({ name: e.name, message: e.message });
    }
  } else if (mode === "opaque-null") {
    const url = new URL("/api/data", location.href);
    url.hostname = "localhost";
    const r = await call(url.href, { mode: "no-cors" });
    out.push({ status: r.status, type: r.type, bodyNull: r.body === null });
    out.push(await r.text());
  } else {
    const path =
      mode === "null-body"
        ? "/api/empty"
        : mode === "delayed-text"
          ? "/api/slow"
          : mode === "clone-meta"
            ? "/api/redirect"
            : mode === "large"
              ? "/api/large"
              : "/api/data";
    const request = {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "X-Factory-Test": "native-header",
      },
      body: "field=" + document.querySelector("input").value,
    };
    const r = await call(
      path,
      mode === "null-body" || mode === "clone-meta" ? undefined : request,
    );
    out.push({
      status: r.status,
      statusText: r.statusText,
      url: r.url,
      type: r.type,
      redirected: r.redirected,
      header: r.headers.get("x-factory"),
      bodyNull: r.body === null,
    });
    if (mode === "ready-text") await delay(80);
    if (mode === "clone-meta") {
      const url = r.url,
        clone = r.clone(),
        again = reuse();
      out.push({
        same: again.same,
        before: url,
        after: r.url,
        clone: clone.url,
        immutable: caught(() => r.headers.set("x-change", "no"))?.name,
      });
      out.push(await r.text(), await clone.text());
    } else out.push(await r.text());
  }
  document.querySelector("#out").textContent = JSON.stringify(out);
  return out;
}
globalThis.factoryRecord = async (mode) => {
  const before = originals(),
    ctx = recordContext(),
    call = createRecordFetch(ctx),
    unchanged = same(before);
  const reuse = () => ({
    same: __FETCH_LEGACY__ ? true : createRecordFetch(ctx) === call,
  });
  const result = await workflow(mode, call, bridgeDelay(ctx, true), reuse);
  ctx.rec.end(2);
  const bytes = ctx.rec.log(),
    records = decodeLog(bytes, { inlineBodies: "batch" }).records;
  return {
    result,
    unchanged,
    reuse: reuse().same,
    log: encode(bytes),
    records: serial(records),
  };
};
globalThis.factoryReplay = async ({ mode, log }) => {
  const before = originals(),
    replay = installReplayRuntime(window, { log }),
    ctx = replayContext(replay);
  const sentinel = new Error("raw replay fetch"),
    native = ctx.orig.fetch;
  let raw = 0;
  ctx.orig.fetch = function () {
    raw++;
    throw sentinel;
  };
  let witnessed = false;
  try {
    ctx.orig.fetch.call(window, "/witness");
  } catch (e) {
    witnessed = e === sentinel && raw === 1;
  }
  raw = 0;
  const call = createReplayFetch(ctx),
    unchanged = same(before),
    reuse = () => ({
      same: __FETCH_LEGACY__ ? true : createReplayFetch(ctx) === call,
    });
  let result, error;
  globalThis.factoryFinal = () => ({
    result,
    error,
    unchanged,
    reuse: reuse().same,
    raw,
    witnessed,
    status: serial(replay.status()),
    next: serial(replay.peek()),
    latched: (() => {
      if (!replay.failed) return undefined;
      const before = serial(replay.peek());
      try {
        replay.next("Clock");
      } catch (e) {
        return {
          name: e.name,
          divergence: serial(e.divergence),
          same: e.divergence === replay.failed,
          before,
          after: serial(replay.peek()),
        };
      }
    })(),
  });
  try {
    result = await workflow(mode, call, bridgeDelay(ctx, false), reuse);
  } catch (e) {
    error = { name: e.name, message: e.message, divergence: e.divergence };
  }
  ctx.orig.fetch = native;
  return factoryFinal();
};

globalThis.factoryPreflight = () => {
  const before = originals(),
    ctx = recordContext(),
    call = createRecordFetch(ctx),
    prepared = descriptors();
  const reuse = __FETCH_LEGACY__ ? true : createRecordFetch(ctx) === call;
  const conflict = caught(() => createRecordFetch({ ...ctx }));
  const conflictUnchanged = matching(prepared) && same(before);
  // Cross-mode test uses real runtime originals/cursor in another browser test;
  // no fake cursor object is passed off as integration here.
  return { reuse, conflict, conflictUnchanged, unchanged: same(before) };
};
globalThis.factoryStopped = async (fault) => {
  const native = captureOriginals(window),
    raw = native.fetch;
  let pending, self, args;
  native.fetch = function (...a) {
    self = this;
    args = a;
    return (pending = raw.apply(this, a));
  };
  const ctx = recordContext(native),
    call = createRecordFetch(ctx),
    input = "/api/data",
    init = { headers: { "X-Factory-Test": "identity" } };
  if (fault) ctx.rec.injectEncoderFault();
  else ctx.rec.end(2);
  const returned = call.call({ arbitrary: true }, input, init),
    identity = returned === pending;
  const r = await returned,
    text = await r.text();
  return {
    identity,
    self: self === window,
    args: args[0] === input && args[1] === init,
    text,
    recording: ctx.rec.recording,
  };
};
globalThis.factoryMissing = () => {
  const before = descriptors(),
    orig = captureOriginals(window),
    ctx = recordContext({ ...orig, fetch: undefined });
  const absent = createRecordFetch(ctx) === undefined;
  const real = recordContext(orig),
    present = typeof createRecordFetch(real) === "function";
  return { absent, present, changed: !matching(before) };
};
globalThis.factoryCrossMode = (log) => {
  const replay = installReplayRuntime(window, { log }),
    ctx = replayContext(replay),
    call = createReplayFetch(ctx),
    prepared = descriptors(),
    before = originals();
  const conflict = caught(() => createRecordFetch(recordContext()));
  return {
    conflict,
    unchanged: matching(prepared) && same(before),
    reuse: __FETCH_LEGACY__ ? true : createReplayFetch(ctx) === call,
  };
};
globalThis.factoryGenericRepeated = async () => {
  const first = installBoundaryShim(window),
    fetch = window.fetch;
  await first.stop();
  const second = installBoundaryShim(window);
  return {
    same: first === second,
    fetch: fetch === window.fetch,
    recording: second.recording,
  };
};
globalThis.factoryGenericReplayRepeated = (log) => {
  const replay = installReplayRuntime(window, { log }),
    first = installReplayShim(window, replay),
    fetch = window.fetch;
  const second = installReplayShim(window, replay);
  return { same: first === second, fetch: fetch === window.fetch };
};
// Deliberate descriptor/iterator fault injection exercises setup failure only;
// this is not a mocked transport, response, replay cursor or integration proof.
globalThis.factorySetupFailure = () => {
  const ctx = recordContext(),
    map = ctx.orig.responseGetters,
    sentinel = new Error("original preparation iterator failure");
  let reentry;
  const iterate = map[Symbol.iterator].bind(map);
  map[Symbol.iterator] = function* () {
    const iterator = iterate();
    yield iterator.next().value;
    reentry = caught(() => createRecordFetch(ctx));
    throw sentinel;
  };
  let first;
  try {
    createRecordFetch(ctx);
  } catch (e) {
    first = e;
  }
  const after = descriptors(),
    retry = caught(() => createRecordFetch(ctx));
  return {
    same: first === sentinel,
    reentry,
    retry,
    unchanged: matching(after),
  };
};

globalThis.factoryPlain = (mode) => {
  const orig = captureOriginals(window);
  return workflow(
    mode,
    (...args) => orig.fetch.call(window, ...args),
    (ms) =>
      new orig.Promise((resolve) => orig.setTimeout.call(window, resolve, ms)),
    () => ({ same: true }),
  );
};

globalThis.factoryAvailable = () =>
  ["text", "json", "arrayBuffer", "blob", "formData", "bytes"].filter(
    (name) => typeof Response.prototype[name] === "function",
  );

// Capability-removal fault controls use the actual runtime/context/originals;
// they neither provide a mock cursor nor stand in for streaming integration.
globalThis.factoryReplayMissing = (log, key) => {
  const replay = installReplayRuntime(window, { log }),
    ctx = replayContext(replay),
    saved = ctx.orig[key],
    before = originals(),
    prepared = descriptors();
  ctx.orig[key] = undefined;
  const absent = createReplayFetch(ctx) === undefined;
  const unchanged = matching(prepared) && same(before);
  ctx.orig[key] = saved;
  const restored = createReplayFetch(ctx);
  return {
    absent,
    unchanged,
    restored: typeof restored === "function",
    globalUnchanged: same(before),
    prepared: !matching(prepared),
  };
};
globalThis.factoryRecordMissingResponse = () => {
  const ctx = recordContext({
      ...captureOriginals(window),
      Response: undefined,
    }),
    before = originals(),
    prepared = descriptors();
  return {
    supported: typeof createRecordFetch(ctx) === "function",
    globalUnchanged: same(before),
    prototypesUnchanged: matching(prepared),
  };
};

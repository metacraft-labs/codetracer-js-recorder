// Appended by the isolation test bundle to the genuine fetch fixture so the
// same actual contexts/Recorder/owned-loop helpers are reused, not copied.
import {
  createFrameworkReplayFetch,
  createReplayFetch as createRealmReplayFetch,
} from "../../../packages/boundary-shim/src/browser/replay/net.js";
import { numberToBits } from "../../../packages/boundary-shim/src/browser/recorder.js";
// Fixed ownership preparation controls. The actual runtime supplies the cursor;
// native consumer instrumentation observes the exact original Promise, receiver
// and arguments. It does not replace the native Response/body or platform work.
globalThis.factoryIsolation = async ({
  log,
  consumer,
  copy,
  state,
  scope,
  failure,
}) => {
  const replay = installReplayRuntime(window, { log }),
    ctx = replayContext(replay),
    nativeFetch = window.fetch,
    beforeGlobals = originals(),
    native = Response.prototype[consumer];
  let settled, receiver, args;
  Response.prototype[consumer] = function (...a) {
    receiver = this;
    args = a;
    settled = native.apply(this, a);
    return settled;
  };
  const prepare =
    scope === "realm" ? createRealmReplayFetch : createFrameworkReplayFetch;
  const call = prepare(ctx),
    prepared = descriptors(),
    sameCallable = prepare(ctx) === call,
    wrongScope = caught(() =>
      (scope === "realm" ? createFrameworkReplayFetch : createRealmReplayFetch)(
        ctx,
      ),
    ),
    wrongContext = caught(() => prepare({ ...ctx })),
    unchanged = matching(prepared) && same(beforeGlobals);
  const finishNeutral = async () => {
    const clock = replay.next("Clock", { src: 2 });
    const storage = replay.next("StorageRead", {
      area: 1,
      key: "foreign-neutral",
    });
    for (let i = 0; i < 100 && replay.status().state !== "done"; i++)
      await new ctx.orig.Promise((resolve) =>
        ctx.orig.setTimeout.call(window, resolve, 0),
      );
    return {
      clock: serial(clock),
      storage: serial(storage),
      status: serial(replay.status()),
    };
  };
  let neutral;
  if (state === "done") neutral = await finishNeutral();
  if (state === "diverged") {
    try {
      replay.next("Clock", { src: 1 });
    } catch {}
  }
  const before = serial(replay.peek()),
    failed = replay.failed;
  const response =
      copy === "constructed"
        ? new Response(
            consumer === "json" ? '{"foreign":true}' : "field=value",
            {
              headers: { "content-type": "application/x-www-form-urlencoded" },
            },
          )
        : await nativeFetch("/api/foreign?consumer=" + consumer),
    target = copy === "clone" ? response.clone() : response;
  if (failure === "used") await native.call(target);
  const wantedReceiver = failure === "receiver" ? {} : target;
  let baselineError;
  if (failure) {
    try {
      await native.call(wantedReceiver, undefined);
    } catch (e) {
      baselineError = { name: e.name, message: e.message };
    }
  }
  let value, error, identity, sameReceiver, sameArgs;
  try {
    const marker = undefined;
    const returned = Response.prototype[consumer].call(wantedReceiver, marker);
    identity = returned === settled;
    sameReceiver = receiver === wantedReceiver;
    sameArgs = args.length === 1 && args[0] === marker;
    const result = await returned;
    value =
      result instanceof ArrayBuffer
        ? Array.from(new Uint8Array(result))
        : result instanceof Uint8Array
          ? Array.from(result)
          : result instanceof Blob
            ? { size: result.size, type: result.type }
            : result instanceof FormData
              ? Array.from(result)
              : result;
  } catch (e) {
    error = { name: e.name, message: e.message, divergence: e.divergence };
  }
  const after = serial(replay.peek()),
    counters = serial([ctx.nextTaskId(), ctx.nextReqId()]);
  if (state === "pending" && (!error || !error.divergence))
    neutral = await finishNeutral();
  return {
    identity,
    sameReceiver,
    sameArgs,
    value,
    error,
    baselineError,
    sameCallable,
    wrongScope,
    wrongContext,
    unchanged,
    before,
    after,
    neutral,
    failedUnchanged: replay.failed === failed,
    counters,
    globalFetchUnchanged: window.fetch === nativeFetch,
    status: serial(replay.status()),
  };
};

globalThis.factoryNeutralLog = () => {
  const ctx = recordContext();
  ctx.rec.emit("Clock", { src: 2, bits: numberToBits(performance.now()) });
  localStorage.setItem("foreign-neutral", "neutral");
  ctx.rec.emit("StorageRead", {
    area: 1,
    key: "foreign-neutral",
    present: 1,
    value: localStorage.getItem("foreign-neutral"),
  });
  ctx.rec.end(2);
  return encode(ctx.rec.log());
};

globalThis.factoryScopeSetup = (log, kind, key) => {
  const replay = installReplayRuntime(window, { log }),
    ctx = replayContext(replay),
    before = descriptors(),
    globals = originals();
  if (kind === "missing") {
    const saved = ctx.orig[key];
    ctx.orig[key] = undefined;
    const absent = createFrameworkReplayFetch(ctx) === undefined,
      unchanged = matching(before) && same(globals);
    ctx.orig[key] = saved;
    const call = createFrameworkReplayFetch(ctx);
    return {
      absent,
      unchanged,
      restored: typeof call,
      reuse: createFrameworkReplayFetch(ctx) === call,
    };
  }
  if (kind === "failure") {
    const map = ctx.orig.headersMutators,
      iterate = map[Symbol.iterator].bind(map),
      firstName = map.keys().next().value,
      beforeMethod = Headers.prototype[firstName],
      sentinel = new Error("original framework preparation failure");
    let reentry, first;
    map[Symbol.iterator] = function* () {
      const iterator = iterate();
      yield iterator.next().value;
      reentry = caught(() => createFrameworkReplayFetch(ctx));
      throw sentinel;
    };
    try {
      createFrameworkReplayFetch(ctx);
    } catch (e) {
      first = e;
    }
    const after = descriptors(),
      retry = caught(() => createFrameworkReplayFetch(ctx));
    return {
      same: first === sentinel,
      partialChanged: Headers.prototype[firstName] !== beforeMethod,
      reentry,
      retry,
      unchanged: matching(after) && same(globals),
    };
  }
  createRealmReplayFetch(ctx);
  const after = descriptors(),
    conflict = caught(() => createFrameworkReplayFetch(ctx));
  return { conflict, unchanged: matching(after) && same(globals) };
};

function isolationNeutral(ctx) {
  ctx.rec.emit("Clock", { src: 2, bits: numberToBits(performance.now()) });
  localStorage.setItem("foreign-neutral", "neutral");
  ctx.rec.emit("StorageRead", {
    area: 1,
    key: "foreign-neutral",
    present: 1,
    value: localStorage.getItem("foreign-neutral"),
  });
}
globalThis.factoryIsolationRecordSequence = async () => {
  const ctx = recordContext(),
    call = createRecordFetch(ctx);
  isolationNeutral(ctx);
  const foreign = await ctx.orig.fetch.call(
    window,
    "/api/foreign?consumer=text",
  );
  const text = await foreign.text();
  const result = await workflow(
    "delayed-text",
    call,
    bridgeDelay(ctx, true),
    () => ({ same: createRecordFetch(ctx) === call }),
  );
  ctx.rec.end(2);
  const bytes = ctx.rec.log();
  return {
    text,
    result,
    log: encode(bytes),
    records: serial(decodeLog(bytes, { inlineBodies: "batch" }).records),
  };
};
globalThis.factoryIsolationReplaySequence = async (log) => {
  const replay = installReplayRuntime(window, { log }),
    ctx = replayContext(replay),
    call = createFrameworkReplayFetch(ctx);
  const clock = replay.next("Clock", { src: 2 }),
    storage = replay.next("StorageRead", { area: 1, key: "foreign-neutral" });
  const before = serial(replay.peek()),
    foreign = await ctx.orig.fetch.call(window, "/api/foreign?consumer=text"),
    text = await foreign.text(),
    after = serial(replay.peek());
  let raw = 0;
  const sentinel = new Error("sequence raw replay request");
  ctx.orig.fetch = () => {
    raw++;
    throw sentinel;
  };
  let witnessed = false;
  try {
    ctx.orig.fetch();
  } catch (e) {
    witnessed = e === sentinel && raw === 1;
  }
  raw = 0;
  const result = await workflow(
    "delayed-text",
    call,
    bridgeDelay(ctx, false),
    () => ({ same: createFrameworkReplayFetch(ctx) === call }),
  );
  for (let i = 0; i < 100 && replay.status().state !== "done"; i++)
    await new ctx.orig.Promise((resolve) =>
      ctx.orig.setTimeout.call(window, resolve, 0),
    );
  return {
    clock: serial(clock),
    storage: serial(storage),
    before,
    after,
    text,
    result,
    raw,
    witnessed,
    status: serial(replay.status()),
  };
};

/** Actual cancellation inputs through the original factory fixture. Native
 * fetch/Response/streams, strict codec and owned scheduler remain genuine.
 * The existing timer bridge records page timing; timeout cases use the actual
 * native AbortSignal.timeout rather than a timer polling its state.
 */
const previousCancellationWorkflow = workflow;
let activeCancellationController;
workflow = async function (mode, call, delay, reuse) {
  if (!mode.startsWith("cancellation:"))
    return previousCancellationWorkflow(mode, call, delay, reuse);
  const [, timing, kind] = mode.split(":"),
    trace = [],
    controller = new AbortController(),
    getReason = Object.getOwnPropertyDescriptor(
      AbortSignal.prototype,
      "reason",
    ).get,
    getAborted = Object.getOwnPropertyDescriptor(
      AbortSignal.prototype,
      "aborted",
    ).get;
  activeCancellationController = controller;
  let reason;
  if (kind === "error") reason = new Error("page cancellation");
  else if (kind === "dom")
    reason = new DOMException("page cancellation", "AbortError");
  else if (kind === "timeout")
    reason = new DOMException("page timeout", "TimeoutError");
  else if (kind === "string") reason = "page cancellation";
  else if (kind === "number") reason = 42;
  else if (kind === "null") reason = null;
  else if (kind === "name-getter")
    reason = {
      get name() {
        trace.push("reason.name");
        return "AbortError";
      },
    };
  const signal =
    kind === "native-timeout" ? AbortSignal.timeout(20) : controller.signal;
  const stop = () =>
    kind === "default" ? controller.abort() : controller.abort(reason);
  let abortEvents = 0;
  signal.addEventListener("abort", () => {
    abortEvents++;
  });
  if (timing === "stopped-event")
    signal.addEventListener("abort", (event) =>
      event.stopImmediatePropagation(),
    );
  if (timing === "own-signal-getters") {
    Object.defineProperties(signal, {
      aborted: {
        get() {
          trace.push("signal.aborted");
          return getAborted.call(this);
        },
      },
      reason: {
        get() {
          trace.push("signal.reason");
          return getReason.call(this);
        },
      },
    });
  }
  if (timing === "pre-aborted" || timing === "own-signal-getters") stop();
  if (timing === "expired-timeout") {
    await new Promise((resolve) =>
      signal.addEventListener("abort", resolve, { once: true }),
    );
  }
  let settled = false,
    pendingBeforeAbort,
    value;
  const init =
    timing === "getter-error"
      ? {
          get headers() {
            trace.push("init.headers");
            throw reason;
          },
          signal,
        }
      : { signal };
  // Inherited RequestInit members observe every dictionary read the call
  // makes. Reads through the page's own init are its native conversion (the
  // count Record reads them is the separate argument-consistency concern); a
  // read through any other dictionary is the recorder's, and must not reach
  // the page.
  const inherited = [];
  let inheritedLive;
  if (timing === "proto-getters")
    for (const key of [
      "body",
      "cache",
      "credentials",
      "duplex",
      "headers",
      "integrity",
      "keepalive",
      "method",
      "mode",
      "priority",
      "redirect",
      "referrer",
      "referrerPolicy",
      "window",
    ]) {
      if (Object.prototype.hasOwnProperty.call(Object.prototype, key)) continue;
      inherited.push(key);
      Object.defineProperty(Object.prototype, key, {
        configurable: true,
        get() {
          if (this === init) inheritedLive = true;
          else trace.push("foreign." + key);
          return undefined;
        },
      });
    }
  let pending;
  try {
    pending = call(
      timing === "failure-equal" ? "/api/fail" : "/api/late-head",
      init,
    );
  } finally {
    for (const key of inherited) delete Object.prototype[key];
  }
  pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const stopping = ["pending", "stopped-event", "proto-getters"].includes(
    timing,
  )
    ? delay(15).then(() => {
        pendingBeforeAbort = !settled;
        stop();
      })
    : undefined;
  try {
    await pending;
    value = { resolved: true };
  } catch (error) {
    if (timing === "failure-equal") controller.abort(error);
    const object =
      error !== null && ["object", "function"].includes(typeof error);
    value = {
      type: typeof error,
      isNull: error === null,
      sameReason: error === getReason.call(signal),
      sameThrown: error === reason,
    };
    // An arbitrary reason.name getter is a page-side observation. It must
    // remain unread unless this fixture explicitly asks for it.
    if (object && kind !== "name-getter") {
      value.name = error.name;
      value.message = error.message;
    } else if (!object) value.primitive = error;
  }
  if (stopping) await stopping;
  const result = {
    value,
    trace,
    abortEvents,
    signalAborted: getAborted.call(signal),
    ...(pendingBeforeAbort === undefined ? {} : { pendingBeforeAbort }),
    ...(inheritedLive === undefined ? {} : { inheritedLive }),
  };
  document.querySelector("#out").textContent = JSON.stringify(result);
  return result;
};

/** Real network failure followed by an unrelated abort with that EXACT error.
 * Only observer registration is injected before the factory's native promise
 * reaction. The transport, promise identity and rejection are genuine. This
 * discriminates causal cancellation from signal state/reason equality.
 */
function observeNoncausalFailure(orig) {
  const native = orig.fetch;
  return function (...args) {
    const pending = native.apply(this, args);
    orig.promiseThen.call(pending, undefined, (error) => {
      activeCancellationController.abort(error);
    });
    return pending;
  };
}
globalThis.factoryCancellationNative = (mode) => {
  const orig = captureOriginals(window),
    call = observeNoncausalFailure(orig);
  return workflow(mode, (...args) => call.call(window, ...args));
};
globalThis.factoryCancellationRecord = async (mode) => {
  const orig = captureOriginals(window);
  orig.fetch = observeNoncausalFailure(orig);
  const ctx = recordContext(orig),
    call = createRecordFetch(ctx);
  const result = await workflow(mode, call, bridgeDelay(ctx, true));
  ctx.rec.end(2);
  const bytes = ctx.rec.log();
  return {
    result,
    log: encode(bytes),
    records: serial(decodeLog(bytes, { inlineBodies: "batch" }).records),
  };
};

/** Observe the captured cancellation listener lifecycle without replacing any
 * platform behavior. These wrappers delegate their exact arguments/receiver to
 * the actual captured native functions. No fake stream or event is dispatched.
 */
globalThis.factoryCancellationCleanup = async (kind) => {
  const orig = captureOriginals(window),
    add = orig.addEventListener,
    remove = orig.removeEventListener,
    raw = orig.fetch,
    controller = new AbortController(),
    listeners = [],
    removals = [];
  let rawInit, suppliedInit;
  orig.addEventListener = function (...args) {
    if (args[0] === "abort")
      listeners.push({ target: this, listener: args[1] });
    return add.apply(this, args);
  };
  orig.removeEventListener = function (...args) {
    if (args[0] === "abort") removals.push({ target: this, listener: args[1] });
    return remove.apply(this, args);
  };
  orig.fetch = function (...args) {
    if (args.length > 1) rawInit = args[1];
    return raw.apply(this, args);
  };
  // Record converts with the captured constructor, then fetches the Request
  // alone (JS-Boundary-Recording §9.7): its init is the native conversion's.
  const RawRequest = orig.Request;
  orig.Request = function Request(input, init) {
    // The first construction is the page's conversion; an engine without
    // AbortSignal.any constructs a private follower Request after it.
    if (rawInit === undefined) rawInit = init;
    return new RawRequest(input, init);
  };
  if (kind === "without-any") orig.abortSignalAny = undefined;
  // An engine before AbortSignal.reason keeps the unchanged native path.
  if (kind === "without-reason") orig.abortSignalReason = undefined;
  const ctx = recordContext(orig),
    call = createRecordFetch(ctx);
  suppliedInit = { signal: controller.signal };
  if (kind === "null") suppliedInit.mode = "no-cors";
  let error, beforeCompletion;
  if (["reject", "without-any", "without-reason"].includes(kind)) {
    controller.abort();
    try {
      await call("/api/late-head", suppliedInit);
    } catch (value) {
      error = value;
    }
  } else {
    const opaque = new URL("/api/success", location.href);
    opaque.hostname = "localhost";
    const response = await call(
      kind === "null"
        ? opaque.href
        : ["cancel", "body-abort", "reader-closed"].includes(kind)
          ? "/api/head"
          : "/api/success",
      suppliedInit,
    );
    beforeCompletion = removals.length;
    if (kind === "cancel") await response.body.cancel("page cancellation");
    else if (kind === "body-abort") {
      const reading = response.text().catch((value) => {
        error = value;
      });
      controller.abort(new Error("body cancellation"));
      await reading;
    } else if (kind === "reader-closed") {
      const reading = response.body.getReader().closed.catch((value) => {
        error = value;
      });
      controller.abort();
      await reading;
    } else if (kind === "clone") {
      const clone = response.clone();
      await Promise.all([response.text(), clone.text()]);
    } else await response.text();
  }
  ctx.rec.end(2);
  const records = decodeLog(ctx.rec.log(), { inlineBodies: "batch" }).records;
  return {
    added: listeners.length,
    removed: removals.length,
    beforeCompletion,
    sameRegistration: removals.every((value) =>
      listeners.some(
        (listener) =>
          value.target === listener.target &&
          value.listener === listener.listener,
      ),
    ),
    privateTarget: listeners.every(
      (value) => value.target !== controller.signal,
    ),
    rawArguments: rawInit === suppliedInit,
    error: error && { name: error.name, message: error.message },
    refusals: serial(records.filter((record) => record.record === "Refusal")),
    last: records.at(-1).record,
  };
};

// Actual native Chromium can expose a non-null stream at status204; the existing
// rebuilder refuses it. Compare raw cancellation with native before preparation,
// and label this exceptional retained-until-abort mirror explicitly.
globalThis.factoryCancellationExceptional = async () => {
  const orig = captureOriginals(window);
  const run = async (call) => {
    const controller = new AbortController(),
      reason = new Error("raw response cancellation");
    const response = await call("/api/empty", { signal: controller.signal });
    const observed = {
      status: response.status,
      bodyNull: response.body === null,
    };
    controller.abort(reason);
    try {
      observed.value = await response.text();
    } catch (error) {
      observed.error = {
        name: error.name,
        message: error.message,
        sameReason: error === reason,
      };
    }
    return observed;
  };
  const native = await run((...args) => orig.fetch.call(window, ...args));
  let added = 0,
    removed = 0;
  const add = orig.addEventListener,
    remove = orig.removeEventListener;
  orig.addEventListener = function (...args) {
    if (args[0] === "abort") added++;
    return add.apply(this, args);
  };
  orig.removeEventListener = function (...args) {
    if (args[0] === "abort") removed++;
    return remove.apply(this, args);
  };
  const ctx = recordContext(orig),
    call = createRecordFetch(ctx);
  const recorded = await run(call);
  ctx.rec.end(2);
  const records = decodeLog(ctx.rec.log(), { inlineBodies: "batch" }).records;
  return {
    native,
    recorded,
    added,
    removed,
    refusals: serial(records.filter((record) => record.record === "Refusal")),
    last: records.at(-1).record,
  };
};

/** A real fetched Response with a page-observable own body accessor. This
 * guards the original count and Recorder.guard exception boundary; it is not
 * a fabricated Response/stream or a substitute transport.
 */
globalThis.factoryCancellationBodyObservation = async (kind) => {
  const orig = captureOriginals(window),
    raw = orig.fetch,
    body = Object.getOwnPropertyDescriptor(orig.Response.prototype, "body").get,
    sentinel = new Error("response body getter sentinel");
  let reads = 0,
    nativeResponse;
  orig.fetch = function (...args) {
    return orig.promiseThen.call(raw.apply(this, args), (response) => {
      nativeResponse = response;
      Object.defineProperty(response, "body", {
        get() {
          reads++;
          if (kind === "throw") throw sentinel;
          return body.call(this);
        },
      });
      return response;
    });
  };
  const ctx = recordContext(orig),
    call = createRecordFetch(ctx),
    controller = new AbortController(),
    url = new URL("/api/success", location.href),
    init = { signal: controller.signal };
  if (kind === "null") {
    url.hostname = "localhost";
    init.mode = "no-cors";
  }
  let value, error, sameResponse;
  try {
    const response = await call(url.href, init);
    sameResponse = response === nativeResponse;
    value = await response.text();
  } catch (caught) {
    error = {
      name: caught.name,
      message: caught.message,
      same: caught === sentinel,
    };
  }
  ctx.rec.end(2);
  return {
    reads,
    value,
    error,
    sameResponse,
    records: serial(
      decodeLog(ctx.rec.log(), { inlineBodies: "batch" }).records,
    ),
  };
};

globalThis.factoryCancellationShadowNull = async () => {
  const orig = captureOriginals(window),
    raw = orig.fetch,
    body = Object.getOwnPropertyDescriptor(orig.Response.prototype, "body").get;
  let reads = 0;
  const fetched = function (...args) {
    return orig.promiseThen.call(raw.apply(this, args), (response) => {
      Object.defineProperty(response, "body", {
        get() {
          reads++;
          return null;
        },
      });
      return response;
    });
  };
  const run = async (call) => {
    const controller = new AbortController(),
      reason = new Error("shadow-null cancellation");
    const response = await call("/api/head", { signal: controller.signal });
    const result = { internalBodyNull: body.call(response) === null };
    const deadline = new Error("shadow-null read did not abort");
    let timer;
    const reading = response.text();
    controller.abort(reason);
    try {
      result.value = await Promise.race([
        reading,
        new orig.Promise((_, reject) => {
          timer = orig.setTimeout.call(window, () => reject(deadline), 1000);
        }),
      ]);
    } catch (error) {
      result.error = {
        name: error.name,
        message: error.message,
        sameReason: error === reason,
      };
      result.deadline = error === deadline;
    } finally {
      orig.clearTimeout.call(window, timer);
    }
    return result;
  };
  const native = await run((...args) => fetched.call(window, ...args));
  const nativeReads = reads;
  reads = 0;
  orig.fetch = fetched;
  const ctx = recordContext(orig),
    call = createRecordFetch(ctx),
    recorded = await run(call);
  ctx.rec.end(2);
  return {
    native,
    recorded,
    nativeReads,
    recordReads: reads,
    records: serial(
      decodeLog(ctx.rec.log(), { inlineBodies: "batch" }).records,
    ),
  };
};

globalThis.factoryCancellationForeignBody = async () => {
  const orig = captureOriginals(window),
    raw = orig.fetch,
    body = Object.getOwnPropertyDescriptor(orig.Response.prototype, "body").get;
  let internalBody,
    reads = 0;
  const fetched = function (...args) {
    return orig.promiseThen.call(raw.apply(this, args), (response) => {
      internalBody = body.call(response);
      const shadow = new orig.ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode("page-created shadow body"),
          );
          controller.close();
        },
      });
      Object.defineProperty(response, "body", {
        get() {
          reads++;
          return shadow;
        },
      });
      return response;
    });
  };
  const run = async (call, native) => {
    const controller = new AbortController(),
      reason = new Error("foreign-body cancellation");
    const response = await call("/api/head", { signal: controller.signal });
    // On untouched native, consume the explicitly page-created shadow stream;
    // on Record the existing rebuilder already follows that observable stream.
    // Neither reads the genuine native internal body until its abort control.
    const shadowText = native
      ? await new orig.Response(response.body).text()
      : await response.text();
    const reader = internalBody.getReader();
    reader.closed.catch(() => {});
    const reading = reader.read();
    controller.abort(reason);
    const deadline = new Error(
      "native body remained live after foreign body completed",
    );
    let timer;
    const result = { shadowText };
    try {
      result.value = await Promise.race([
        reading,
        new orig.Promise((_, reject) => {
          timer = orig.setTimeout.call(window, () => reject(deadline), 1000);
        }),
      ]);
    } catch (error) {
      result.error = {
        name: error.name,
        message: error.message,
        sameReason: error === reason,
      };
      result.deadline = error === deadline;
    } finally {
      orig.clearTimeout.call(window, timer);
    }
    return result;
  };
  const native = await run((...args) => fetched.call(window, ...args), true),
    nativeReads = reads;
  reads = 0;
  orig.fetch = fetched;
  const ctx = recordContext(orig),
    call = createRecordFetch(ctx),
    recorded = await run(call, false);
  ctx.rec.end(2);
  return {
    native,
    recorded,
    nativeReads,
    recordReads: reads,
    records: serial(
      decodeLog(ctx.rec.log(), { inlineBodies: "batch" }).records,
    ),
  };
};

/** A Refused raw body (Chromium's non-null 204 stream) on a long-lived page
 * signal that is never aborted. Its mirror can only be released once nothing
 * can read that native body; `hold` keeps the Response as the control. The
 * genuine engine collector decides reachability (the test drives it through
 * CDP); only the captured listener functions are observed, as in the cleanup
 * fixture above.
 */
globalThis.factoryCancellationCollected = async (hold) => {
  const orig = captureOriginals(window),
    remove = orig.removeEventListener,
    observed = { added: 0, removed: 0 };
  const add = orig.addEventListener;
  orig.addEventListener = function (...args) {
    if (args[0] === "abort") observed.added++;
    return add.apply(this, args);
  };
  orig.removeEventListener = function (...args) {
    if (args[0] === "abort") observed.removed++;
    return remove.apply(this, args);
  };
  const ctx = recordContext(orig),
    call = createRecordFetch(ctx),
    controller = new AbortController();
  await (async () => {
    const response = await call("/api/empty", { signal: controller.signal });
    observed.status = response.status;
    observed.bodyNull = response.body === null;
    observed.text = await response.text();
    if (hold) globalThis.cancellationHeldResponse = response;
  })();
  ctx.rec.end(2);
  const records = decodeLog(ctx.rec.log(), { inlineBodies: "batch" }).records;
  observed.refusals = serial(
    records.filter((record) => record.record === "Refusal"),
  );
  observed.last = records.at(-1).record;
  observed.removedAtEnd = observed.removed;
  // The long-lived page signal outlives the request, as an application's
  // component-lifetime controller does.
  globalThis.cancellationLongLived = controller;
  globalThis.cancellationCollected = observed;
  return { ...observed };
};

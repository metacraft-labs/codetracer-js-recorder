/** Request argument observation through the genuine factory fixture. No fake
 * fetch/codec/cursor. Getters intentionally witness native dictionary conversion;
 * thrown getter values are explicit application inputs, not transport failures.
 */
const previousArgumentWorkflow = workflow;
workflow = async function (mode, call, delay, reuse) {
  if (!mode.startsWith("argument:"))
    return previousArgumentWorkflow(mode, call, delay, reuse);
  const kind = mode.slice("argument:".length),
    trace = [],
    receivers = [],
    ac = new AbortController(),
    sentinel = kind.endsWith("-null")
      ? null
      : kind.endsWith("-undefined")
        ? undefined
        : kind.endsWith("-typeerror")
          ? new TypeError("argument getter sentinel")
          : new Error("argument getter sentinel"),
    reasonGet = Object.getOwnPropertyDescriptor(
      AbortSignal.prototype,
      "reason",
    ).get;
  ac.abort();
  let input = location.origin + "/echo",
    init,
    bodyReads = 0,
    methodReads = 0;
  if (kind === "plain-abort") {
    init = { signal: ac.signal };
  } else if (kind.startsWith("validation-")) {
    init =
      kind === "validation-signal"
        ? { signal: 42 }
        : kind === "validation-method"
          ? { method: "bad method" }
          : kind === "validation-body"
            ? { method: "GET", body: "body" }
            : kind === "validation-header"
              ? { headers: { "bad\nheader": "value" } }
              : undefined;
    if (kind === "validation-url") input = "http://[";
  } else if (kind.startsWith("request-")) {
    input = new Request(input, { signal: ac.signal });
    if (kind === "request-shadow" || kind === "request-signal-shadow") {
      for (const key of kind === "request-signal-shadow"
        ? ["signal"]
        : ["method", "url", "body", "signal"])
        Object.defineProperty(input, key, {
          get() {
            trace.push("request." + key);
            throw sentinel;
          },
        });
    }
    if (
      kind !== "request-missing" &&
      kind !== "request-shadow" &&
      kind !== "request-signal-shadow"
    ) {
      init = {};
      Object.defineProperty(init, "signal", {
        get() {
          trace.push("signal");
          receivers.push(this === init);
          return kind === "request-null" ? null : undefined;
        },
      });
    }
  } else if (kind.startsWith("body-")) {
    const value = "field=value",
      bytes = new TextEncoder().encode(value),
      params = new URLSearchParams({ field: "value" });
    params.toString = () => {
      trace.push("own.params.toString");
      return "wrong";
    };
    init = {
      method: "POST",
      body:
        kind === "body-params"
          ? params
          : kind === "body-buffer"
            ? bytes.buffer
            : kind === "body-view"
              ? bytes
              : value,
    };
  } else {
    init = {};
    for (const key of ["body", "headers", "method", "signal"])
      Object.defineProperty(init, key, {
        get() {
          trace.push(key);
          receivers.push(this === init);
          if (kind === "throw-" + key || kind.startsWith("throw-" + key + "-"))
            throw sentinel;
          if (key === "body") {
            bodyReads++;
            return kind === "changing"
              ? "body-" + bodyReads
              : kind === "coercions"
                ? "native body"
                : undefined;
          }
          if (key === "headers")
            return kind === "coercions"
              ? [
                  [
                    "X-Argument",
                    {
                      toString() {
                        trace.push("header.toString");
                        return "native header";
                      },
                    },
                  ],
                ]
              : undefined;
          if (key === "method") {
            methodReads++;
            if (kind === "coercions")
              return {
                toString() {
                  trace.push("method.toString");
                  return "post";
                },
              };
            return kind === "changing"
              ? methodReads === 1
                ? "POST"
                : "PUT"
              : "GET";
          }
          return kind === "changing" || kind === "coercions" ? null : ac.signal;
        },
      });
    if (kind === "coercions")
      input = {
        toString() {
          trace.push("url.toString");
          return location.origin + "/echo";
        },
      };
  }
  let value,
    returnedPromise = false;
  try {
    const p = call.call(window, input, init);
    returnedPromise = p instanceof Promise;
    const response = await p;
    value = { status: response.status, body: await response.text() };
  } catch (e) {
    value = {
      name: e?.name,
      message: e?.message,
      sameReason: e === reasonGet.call(ac.signal),
      sameThrown: e === sentinel,
    };
  }
  const result = { trace, receivers, returnedPromise, value };
  document.querySelector("#out").textContent = JSON.stringify(result);
  return result;
};
globalThis.factoryArgumentNative = (mode) =>
  workflow(mode, window.fetch, undefined, undefined);

// Actual failed metadata guard: independently witness raw native Promise,
// original argument identities and captured Window receiver at the fallback.
globalThis.factoryArgumentFault = async (mode) => {
  const orig = captureOriginals(window),
    raw = orig.fetch;
  let nativePromise, nativeArgs, nativeSelf, callArgs, identity;
  orig.fetch = function (...args) {
    nativeArgs = args;
    nativeSelf = this;
    return (nativePromise = raw.apply(this, args));
  };
  const ctx = recordContext(orig),
    call = createRecordFetch(ctx);
  const observed = function (...args) {
    callArgs = args;
    const promise = call.apply(this, args);
    identity = promise === nativePromise;
    return promise;
  };
  const result = await workflow(mode, observed);
  ctx.rec.end(2);
  return {
    result,
    identity,
    receiver: nativeSelf === window,
    args: callArgs.every((arg, i) => arg === nativeArgs[i]),
    records: serial(
      decodeLog(ctx.rec.log(), { inlineBodies: "batch" }).records,
    ),
  };
};

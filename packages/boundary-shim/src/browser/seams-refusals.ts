/**
 * The features V1 refuses (JS-Boundary-Recording.md §7.5). The first use of
 * each writes one `Refusal` naming it, before the feature runs, and the
 * page keeps working: the call goes through to the platform unchanged. The
 * session is non-replayable from that `seq` on.
 */

import { type SeamContext, asConstructor, replaceValue } from "./context.js";

/** The `Refusal.feature` names of §7.5. */
export const RefusedFeature = {
  worker: "worker",
  sharedWorker: "shared-worker",
  serviceWorkerMessage: "service-worker-message",
  webAssembly: "webassembly",
  broadcastChannel: "broadcast-channel",
  indexedDb: "indexeddb",
  weakRef: "weakref",
  finalizationRegistry: "finalization-registry",
} as const;

type Global = Record<string, unknown>;

/** Patch every refused feature this window has. */
export function patchRefusals(ctx: SeamContext): void {
  const { w } = ctx;
  const g = w as unknown as Global;

  refuseConstructor(ctx, g, "Worker", RefusedFeature.worker);
  refuseConstructor(ctx, g, "SharedWorker", RefusedFeature.sharedWorker);
  refuseConstructor(
    ctx,
    g,
    "BroadcastChannel",
    RefusedFeature.broadcastChannel,
  );
  refuseConstructor(
    ctx,
    g,
    "FinalizationRegistry",
    RefusedFeature.finalizationRegistry,
  );

  const wasm = g.WebAssembly as Global | undefined;
  if (wasm !== undefined) {
    for (const fn of [
      "instantiate",
      "instantiateStreaming",
      "compile",
      "compileStreaming",
    ]) {
      refuseMethod(
        ctx,
        wasm,
        fn,
        RefusedFeature.webAssembly,
        `WebAssembly.${fn}`,
      );
    }
    refuseConstructor(ctx, wasm, "Module", RefusedFeature.webAssembly);
    refuseConstructor(ctx, wasm, "Instance", RefusedFeature.webAssembly);
  }

  const idb = (g.IDBFactory as { prototype: Global } | undefined)?.prototype;
  if (idb !== undefined) {
    for (const fn of ["open", "deleteDatabase", "databases"]) {
      refuseMethod(ctx, idb, fn, RefusedFeature.indexedDb, `indexedDB.${fn}`);
    }
  }

  const weakRef = (g.WeakRef as { prototype: Global } | undefined)?.prototype;
  if (weakRef !== undefined) {
    refuseMethod(
      ctx,
      weakRef,
      "deref",
      RefusedFeature.weakRef,
      "WeakRef.deref",
    );
  }

  // Service Worker message channels: listening for, or posting, messages.
  const swc = (g.ServiceWorkerContainer as { prototype: Global } | undefined)
    ?.prototype;
  if (swc !== undefined) {
    const origAdd = swc.addEventListener as (...a: unknown[]) => void;
    replaceValue(
      swc,
      "addEventListener",
      function addEventListener(
        this: unknown,
        type: unknown,
        ...rest: unknown[]
      ) {
        if (type === "message") {
          ctx.refuseOnce(
            RefusedFeature.serviceWorkerMessage,
            "navigator.serviceWorker message listener",
          );
        }
        return origAdd.call(this, type, ...rest);
      },
    );
    const onmessage = Object.getOwnPropertyDescriptor(swc, "onmessage");
    if (onmessage?.set !== undefined && onmessage.get !== undefined) {
      const set = onmessage.set;
      Object.defineProperty(swc, "onmessage", {
        get: onmessage.get,
        set(this: unknown, v: unknown) {
          ctx.refuseOnce(
            RefusedFeature.serviceWorkerMessage,
            "navigator.serviceWorker.onmessage",
          );
          set.call(this, v);
        },
        enumerable: onmessage.enumerable,
        configurable: onmessage.configurable,
      });
    }
  }
  const sw = (g.ServiceWorker as { prototype: Global } | undefined)?.prototype;
  if (sw !== undefined) {
    refuseMethod(
      ctx,
      sw,
      "postMessage",
      RefusedFeature.serviceWorkerMessage,
      "ServiceWorker.postMessage",
    );
  }
}

function refuseMethod(
  ctx: SeamContext,
  owner: Global,
  name: string,
  feature: string,
  detail: string,
): void {
  const original = owner[name];
  if (typeof original !== "function") return;
  const patched = function (this: unknown, ...args: unknown[]): unknown {
    ctx.refuseOnce(feature, detail);
    return original.apply(this, args);
  };
  Object.defineProperty(patched, "name", { value: name });
  Object.defineProperty(patched, "length", { value: original.length });
  replaceValue(owner, name, patched);
}

function refuseConstructor(
  ctx: SeamContext,
  owner: Global,
  name: string,
  feature: string,
): void {
  const Orig = owner[name];
  if (typeof Orig !== "function") return;
  const Patched = function (this: unknown, ...args: unknown[]): unknown {
    if (new.target === undefined) {
      // Calling these without `new` throws (or, for WebAssembly, also
      // throws): keep the platform's behaviour.
      return (Orig as (...a: unknown[]) => unknown)(...args);
    }
    ctx.refuseOnce(feature, `new ${name}`);
    return Reflect.construct(Orig, args, new.target);
  };
  asConstructor(Patched, Orig);
  replaceValue(owner, name, Patched);
}

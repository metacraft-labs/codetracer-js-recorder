/**
 * Web Storage and cookie seams (JS-Boundary-Recording.md §5.2
 * `StorageRead`, §10.1, §10.4).
 *
 * A page reads storage through methods (`getItem`, `key`, `length`) and
 * also through properties: `localStorage.foo`, `"foo" in localStorage`,
 * `Object.keys(localStorage)`, `for…in`, `JSON.stringify(localStorage)`.
 * Property access reaches the platform through the storage object's
 * named-property interceptor, which no prototype patch can see
 * (https://html.spec.whatwg.org/multipage/webstorage.html#the-storage-interface,
 * https://webidl.spec.whatwg.org/#legacy-platform-object-abstract-ops).
 * So `window.localStorage` and `window.sessionStorage` answer with one
 * `Proxy` per storage object, whose every trap performs the platform's own
 * operation on the real object and logs what it revealed:
 *
 *  - a read of a name that is not on the prototype chain (`get`, `has`,
 *    `getOwnPropertyDescriptor`) is a read of that key: `StorageRead{key,
 *    present, value}`;
 *  - a name on the prototype chain (`getItem`, `length`, `toString`, …)
 *    resolves to the prototype, whatever is stored: not a storage read;
 *  - the key list (`ownKeys`), `length` and `key(n)` are reads of the
 *    area's shape: `StorageRead{present: 2}`, `key` naming the read
 *    (`keys`, `length`, `key`), `value` its JSON result.
 *
 * Writes (`setItem`, assignment, `delete`, `clear`) are the page's own
 * deterministic outputs and are not logged. The proxy keeps the identity
 * checks a page makes: `localStorage` is the same object on every read,
 * `instanceof Storage`, `Storage.prototype.getItem.call(localStorage, …)`
 * (every `Storage` method unwraps it), `StorageEvent.storageArea ===
 * localStorage`, and `new StorageEvent(…, {storageArea: localStorage})`.
 */

import {
  type SeamContext,
  asConstructor,
  replaceAccessor,
  replaceValue,
} from "./context.js";

/** `StorageRead.area` (§5.2). */
const Area = { local: 1, session: 2, cookie: 3 };

/** `StorageRead.present` of a read of an area's shape, not of one key. */
export const SHAPE_READ = 2;

/** Patch every storage seam: the two Web Storage areas and the cookie. */
export function patchStorage(ctx: SeamContext): void {
  const { w, rec, orig } = ctx;

  // The real storage objects, read once through the original getters. A
  // document denied storage throws on every read; its area is then never
  // wrapped, and the patched getter throws to the page as before.
  const areaOf = new Map<Storage, number>();
  for (const [name, area] of [
    ["localStorage", Area.local],
    ["sessionStorage", Area.session],
  ] as const) {
    const g = orig.storageAreas.get(name);
    if (g === undefined) continue;
    try {
      areaOf.set(g.descriptor.get!.call(w) as Storage, area);
    } catch {
      // Storage denied to this document.
    }
  }

  const log = (area: number, key: string, present: number, value: string) =>
    rec.guard(() => rec.emit("StorageRead", { area, key, present, value }));

  // One proxy per real storage object, and the way back.
  const proxyOf = new Map<Storage, Storage>();
  const realOf = new WeakMap<object, Storage>();
  const unwrap = (s: unknown): unknown =>
    (typeof s === "object" || typeof s === "function") && s !== null
      ? (realOf.get(s) ?? s)
      : s;
  const areaOfThis = (s: unknown): number =>
    areaOf.get(unwrap(s) as Storage) ?? 0;

  /** Whether `p` resolves to the prototype chain of `t` (not a key read). */
  const onPrototype = (t: object, p: string): boolean => {
    const proto = Reflect.getPrototypeOf(t);
    return proto !== null && Reflect.has(proto, p);
  };

  /**
   * Log what the platform's own-property answer for key `p` revealed: a
   * stored value (a data property), or that no such key is stored. An
   * accessor is a page expando, not storage.
   */
  const logKey = (
    area: number,
    p: string,
    d: PropertyDescriptor | undefined,
  ): void => {
    if (!rec.recording) return;
    if (d === undefined) log(area, p, 0, "");
    else if ("value" in d) log(area, p, 1, String(d.value));
  };

  const wrap = (real: Storage, area: number): Storage => {
    const existing = proxyOf.get(real);
    if (existing !== undefined) return existing;
    // Accessors found on the prototype run with the real object as `this`,
    // so the platform's own accessors never see the proxy.
    const recv = (receiver: unknown) => (receiver === proxy ? real : receiver);
    const proxy: Storage = new Proxy(real, {
      get(t, p, receiver) {
        if (typeof p !== "string" || onPrototype(t, p)) {
          return Reflect.get(t, p, recv(receiver));
        }
        const d = Reflect.getOwnPropertyDescriptor(t, p);
        logKey(area, p, d);
        if (d !== undefined && "value" in d) return d.value as unknown;
        return Reflect.get(t, p, recv(receiver));
      },
      has(t, p) {
        if (typeof p === "string" && !onPrototype(t, p)) {
          logKey(area, p, Reflect.getOwnPropertyDescriptor(t, p));
        }
        return Reflect.has(t, p);
      },
      getOwnPropertyDescriptor(t, p) {
        const d = Reflect.getOwnPropertyDescriptor(t, p);
        if (typeof p === "string" && !onPrototype(t, p)) logKey(area, p, d);
        return d;
      },
      ownKeys(t) {
        const keys = Reflect.ownKeys(t);
        if (rec.recording) {
          log(
            area,
            "keys",
            SHAPE_READ,
            JSON.stringify(keys.filter((k) => typeof k === "string")),
          );
        }
        return keys;
      },
      // An assignment is the platform's named setter (or, for a name on
      // the prototype chain, an own property), performed on the real
      // object as the receiver. defineProperty, deleteProperty and the
      // rest are the Proxy defaults: the target's own operation.
      set(t, p, v, receiver) {
        return Reflect.set(t, p, v, recv(receiver));
      },
    });
    proxyOf.set(real, proxy);
    realOf.set(proxy, real);
    return proxy;
  };

  // window.localStorage / window.sessionStorage answer with the proxy.
  for (const [name, g] of orig.storageAreas) {
    const get = g.descriptor.get!;
    replaceAccessor(
      g.owner,
      name,
      function (this: unknown) {
        const real = get.call(this) as Storage;
        const area = areaOf.get(real);
        return area === undefined ? real : wrap(real, area);
      },
      g.descriptor.set,
    );
  }

  // Every Storage method unwraps `this`, so the platform's brand check
  // sees the real object. Arguments are passed through untouched (their
  // count included), so the platform converts and refuses them as before.
  const origGet = orig.storageGetItem;
  replaceValue(
    w.Storage.prototype,
    "getItem",
    function getItem(this: unknown, key: unknown): string | null {
      const area = areaOfThis(this);
      // An object key is converted by the platform with its toString; the
      // log needs the same string, so it is converted once here, as WebIDL
      // converts a DOMString (ToString, which a template literal applies),
      // and the string is what the platform gets.
      const args =
        area !== 0 &&
        arguments.length > 0 &&
        ((typeof key === "object" && key !== null) || typeof key === "function")
          ? [`${key as object}`]
          : Array.from(arguments);
      const v = (origGet as (...a: unknown[]) => string | null).apply(
        unwrap(this),
        args,
      );
      if (area !== 0 && rec.recording) {
        log(area, String(args[0]), v === null ? 0 : 1, v ?? "");
      }
      return v;
    },
  );
  for (const [name, f] of orig.storageMethods) {
    const patched =
      name === "key"
        ? function key(this: unknown): string | null {
            const v = f.apply(unwrap(this), Array.from(arguments)) as
              | string
              | null;
            const area = areaOfThis(this);
            if (area !== 0 && rec.recording) {
              log(area, "key", SHAPE_READ, JSON.stringify(v));
            }
            return v;
          }
        : function (this: unknown): unknown {
            return f.apply(unwrap(this), Array.from(arguments));
          };
    if (name !== "key") Object.defineProperty(patched, "name", { value: name });
    replaceValue(w.Storage.prototype, name, patched);
  }
  const length = orig.storageLength;
  if (length !== undefined) {
    const get = length.descriptor.get!;
    replaceAccessor(
      length.owner,
      "length",
      function (this: unknown) {
        const n = get.call(unwrap(this)) as number;
        const area = areaOfThis(this);
        if (area !== 0 && rec.recording) {
          log(area, "length", SHAPE_READ, JSON.stringify(n));
        }
        return n;
      },
      length.descriptor.set,
    );
  }

  // A storage event names its area by the real object; the page compares
  // it with the proxy it knows. A page that constructs one passes the
  // proxy, which the platform's conversion would refuse.
  const area = orig.storageEventArea;
  if (area !== undefined) {
    const get = area.descriptor.get!;
    replaceAccessor(
      area.owner,
      "storageArea",
      function (this: unknown) {
        const real = get.call(this) as Storage | null;
        const a = real === null ? undefined : areaOf.get(real);
        return a === undefined ? real : wrap(real!, a);
      },
      area.descriptor.set,
    );
  }
  const OrigEvent = orig.StorageEvent;
  if (OrigEvent !== undefined) {
    const PatchedEvent = function StorageEvent(
      this: unknown,
      ...args: unknown[]
    ): StorageEvent {
      if (new.target === undefined) {
        // Calling an event constructor without `new` throws; keep that.
        return (OrigEvent as unknown as (...a: unknown[]) => StorageEvent)(
          ...args,
        );
      }
      const init = args[1];
      if (typeof init === "object" && init !== null) {
        // The dictionary is read by the platform, member by member, through
        // this view, so its getters run as often and in the same order.
        args[1] = new Proxy(init, {
          get(t, p, r) {
            const v = Reflect.get(t, p, r) as unknown;
            return p === "storageArea" ? unwrap(v) : v;
          },
        });
      }
      return Reflect.construct(OrigEvent, args, new.target) as StorageEvent;
    };
    asConstructor(PatchedEvent, OrigEvent);
    replaceValue(w, "StorageEvent", PatchedEvent);
    const init = orig.initStorageEvent;
    if (init !== undefined) {
      replaceValue(
        OrigEvent.prototype,
        "initStorageEvent",
        function initStorageEvent(this: unknown): void {
          const args = Array.from(arguments);
          if (args.length > 7) args[7] = unwrap(args[7]);
          init.apply(this, args);
        },
      );
    }
  }

  const cookie = orig.cookie;
  if (cookie !== undefined) {
    const get = cookie.descriptor.get!;
    const set = cookie.descriptor.set;
    replaceAccessor(
      cookie.owner,
      "cookie",
      function (this: unknown) {
        const v = get.call(this) as string;
        log(Area.cookie, "", 1, v);
        return v;
      },
      set === undefined
        ? undefined
        : function (this: unknown, v: unknown) {
            set.call(this, v);
          },
    );
  }
}

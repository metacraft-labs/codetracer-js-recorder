/**
 * Platform tasks and the files a user chose (JS-Boundary-Recording.md §5.2
 * `TaskReg`/`Task` kind 13, §6, §7.5, §10.1).
 *
 * **Platform tasks.** Some platform promises settle in a task of their own
 * rather than in the microtask of the call that made them: a whole-body read
 * of a `Blob` (File API, "read operation": "queue a global task on the file
 * reading task source"), of a `Request` or of a `Response` the page made
 * (Fetch, "fully read body": "queue a fetch task"), and `crypto.subtle.digest`
 * (Web Cryptography, "queue a global task on the crypto task source"). The
 * browser may run any other task between the call and that one, so the order
 * is the boundary's: the call writes `TaskReg{kind 13}` and the settlement
 * writes `Task{kind 13}`, just before the page's continuation runs in it. A
 * `Response` a `fetch` produced is the exception: its whole-body reads are
 * tasks of its request (stream-body.ts).
 *
 * Those platform tasks the shim cannot order exactly are refused
 * (`unrecordable-platform-task`): reading a `Blob` as a stream (each chunk
 * settles in a task of its own, and the reads are made through the stream's
 * reader, not through a call the shim sees), a `FileReader` (its events are
 * tasks whose `ProgressEvent` values depend on how the platform read the
 * bytes), and every `crypto.subtle` method but `digest` (they settle in
 * tasks too, and several of them draw random numbers inside the platform:
 * `generateKey`, and `encrypt` and `sign` with randomised schemes).
 *
 * **Files a user chose.** A file input's `files`, and the files of a
 * `DataTransfer`, are the user's: their name, size, type and modification
 * time are recorded with the input (`DomEffect{effect 6}`, seams-dom.ts), and
 * replay hands the page files of that shape. Their contents are not
 * recorded: they are what JS-Boundary-Recording.md §11.3 calls sensitive
 * input, and recording them waits for that design (JBR's sensitive-input
 * milestone). So the first read of the contents of such a file, of a slice
 * of one or of a `Blob`, `File`, `Response` or `Request` made from one, and an
 * object URL made for one, is refused (`file-content`) before it runs: the
 * session is non-replayable from there, never replayed with other bytes.
 */

import {
  type SeamContext,
  asConstructor,
  replaceAccessor,
  replaceValue,
} from "./context.js";
import { TaskKind } from "./recorder.js";

/** `Refusal.feature`: a platform task the shim cannot order exactly (§7.5). */
export const UNRECORDABLE_PLATFORM_TASK = "unrecordable-platform-task";
/** `Refusal.feature`: the page read the contents of a file a user chose. */
export const FILE_CONTENT = "file-content";

/**
 * The whole-body reads of a `Request` and a `Response` (Fetch, "consume
 * body"), and of a `Blob` (File API), that settle in a task of their own.
 */
export const BODY_READS: readonly string[] = [
  "arrayBuffer",
  "blob",
  "bytes",
  "formData",
  "json",
  "text",
];
export const BLOB_READS: readonly string[] = ["arrayBuffer", "bytes", "text"];
/** The `FileReader` reads, all refused. */
export const FILE_READER_READS: readonly string[] = [
  "readAsArrayBuffer",
  "readAsBinaryString",
  "readAsDataURL",
  "readAsText",
];
/** The `SubtleCrypto` methods, all refused but `digest`. */
export const SUBTLE_METHODS: readonly string[] = [
  "decrypt",
  "deriveBits",
  "deriveKey",
  "encrypt",
  "exportKey",
  "generateKey",
  "importKey",
  "sign",
  "unwrapKey",
  "verify",
  "wrapKey",
];

/**
 * The objects whose contents are a user's file: the files themselves, and
 * every `Blob`, `File`, `Response` and `Request` made from one. One set per
 * realm (the shim's bundle is evaluated once per document).
 */
const userContent = new WeakSet<object>();

/**
 * The `Response` objects the page holds that no `fetch` streamed to it
 * (stream-body.ts keeps those): the ones it made (`new Response`,
 * `Response.json`, `error`, `redirect`), a `fetch` response passed to it
 * as the platform made it (a null body), and their clones. A whole-body read
 * of one of them is a platform task (§6, kind 13); the recorder's own
 * responses (the upload transport's) are none of the page's and are not
 * recorded.
 */
const pageResponses = new WeakSet<object>();

/** Note that the page holds `r` (see {@link pageResponses}). */
export function markPageResponse(r: object): void {
  pageResponses.add(r);
}

/** Whether the page holds `r` and no `fetch` streamed it. */
export function isPageResponse(r: unknown): boolean {
  return typeof r === "object" && r !== null && pageResponses.has(r);
}

/** Whether `v` carries the contents of a file a user chose. */
export function isUserContent(v: unknown): boolean {
  return (
    (typeof v === "object" || typeof v === "function") &&
    v !== null &&
    userContent.has(v)
  );
}

/**
 * A promise the platform settles in a task of its own (§6): the call's
 * `TaskReg{kind 13}` now, and the `Task` when it settles, before the page's
 * continuation runs. Returns the promise the page gets.
 */
export function recordPlatformTask<T>(
  ctx: SeamContext,
  settled: Promise<T>,
): Promise<T> {
  const { rec, orig } = ctx;
  if (!rec.recording) return settled;
  const taskId = rec.guard(() => {
    const id = rec.nextTaskId();
    rec.emit("TaskReg", {
      task_id: id,
      kind: TaskKind.platform,
      delay_ms: 0,
    });
    return id;
  });
  if (taskId === undefined) return settled;
  const task = () => rec.guard(() => rec.task(taskId, TaskKind.platform));
  return new orig.Promise<T>((resolve, reject) => {
    (orig.promiseThen as Promise<T>["then"]).call(
      settled,
      (v) => {
        task();
        resolve(v);
      },
      (e: unknown) => {
        task();
        reject(e);
      },
    );
  });
}

/** Patch every seam this module owns. */
export function patchPlatformSeams(ctx: SeamContext): void {
  patchUserFiles(ctx);
  patchBlobReads(ctx);
  patchRequestReads(ctx);
  patchSubtle(ctx);
  patchFileReader(ctx);
}

type Global = Record<string, unknown>;
type Fn = (...a: unknown[]) => unknown;

/** Replace method `name` of `owner` by `make(original)`, keeping its shape. */
export function wrapMethod(
  owner: Global | undefined,
  name: string,
  make: (original: Fn) => Fn,
): void {
  const original = owner?.[name];
  if (typeof original !== "function") return;
  const patched = make(original as Fn);
  Object.defineProperty(patched, "name", { value: name });
  Object.defineProperty(patched, "length", { value: original.length });
  replaceValue(owner!, name, patched);
}

function protoOf(w: SeamContext["w"], name: string): Global | undefined {
  return (w as unknown as Record<string, { prototype?: Global } | undefined>)[
    name
  ]?.prototype;
}

/**
 * Mark the files a user chose, wherever the page gets them, and every object
 * made from their contents; refuse a read of those contents.
 */
function patchUserFiles(ctx: SeamContext): void {
  const { w } = ctx;
  const markList = (list: unknown) => {
    const files = list as FileList | null;
    if (files === null || files === undefined) return;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (f !== undefined && f !== null) userContent.add(f);
    }
  };
  for (const [ctor, prop] of [
    ["HTMLInputElement", "files"],
    ["DataTransfer", "files"],
  ] as const) {
    const proto = protoOf(w, ctor);
    const d =
      proto === undefined
        ? undefined
        : Object.getOwnPropertyDescriptor(proto, prop);
    if (d?.get === undefined) continue;
    const get = d.get;
    replaceAccessor(
      proto!,
      prop,
      function (this: unknown) {
        const list = get.call(this) as unknown;
        markList(list);
        return list;
      },
      d.set,
    );
  }
  wrapMethod(
    protoOf(w, "DataTransferItem"),
    "getAsFile",
    (original) =>
      function (this: unknown, ...args: unknown[]) {
        const f = original.apply(this, args);
        if (f !== null && typeof f === "object") userContent.add(f);
        return f;
      },
  );

  // Objects made from a user's file carry its contents.
  const fromParts = (parts: unknown) =>
    Array.isArray(parts) && parts.some((p) => isUserContent(p));
  for (const name of ["Blob", "File"] as const) {
    const Orig = (w as unknown as Global)[name] as Function | undefined;
    if (typeof Orig !== "function") continue;
    const Patched = function (this: unknown, ...args: unknown[]): unknown {
      if (new.target === undefined) {
        return (Orig as Fn)(...args);
      }
      const made = Reflect.construct(Orig, args, new.target) as object;
      if (fromParts(args[0])) userContent.add(made);
      return made;
    };
    asConstructor(Patched, Orig);
    replaceValue(
      (Orig as { prototype: object }).prototype,
      "constructor",
      Patched,
    );
    replaceValue(w, name, Patched);
  }
  wrapMethod(
    protoOf(w, "Blob"),
    "slice",
    (original) =>
      function (this: unknown, ...args: unknown[]) {
        const s = original.apply(this, args) as object;
        if (isUserContent(this)) userContent.add(s);
        return s;
      },
  );
  for (const name of ["Response", "Request"] as const) {
    const Orig = (w as unknown as Global)[name] as Function | undefined;
    if (typeof Orig !== "function") continue;
    const Patched = function (this: unknown, ...args: unknown[]): unknown {
      if (new.target === undefined) return (Orig as Fn)(...args);
      const made = Reflect.construct(Orig, args, new.target) as object;
      if (name === "Response") pageResponses.add(made);
      const body =
        name === "Response"
          ? args[0]
          : (args[1] as { body?: unknown } | undefined)?.body;
      if (
        isUserContent(body) ||
        (name === "Request" && isUserContent(args[0]))
      ) {
        userContent.add(made);
      }
      return made;
    };
    asConstructor(Patched, Orig);
    replaceValue(
      (Orig as { prototype: object }).prototype,
      "constructor",
      Patched,
    );
    replaceValue(w, name, Patched);
    if (name === "Response") {
      // The statics make responses the page holds too.
      for (const make of ["json", "error", "redirect"]) {
        const f = (Orig as unknown as Global)[make];
        if (typeof f !== "function") continue;
        const patchedStatic = function (this: unknown, ...a: unknown[]) {
          const r = (f as Fn).apply(this === Patched ? Orig : this, a);
          if (typeof r === "object" && r !== null) pageResponses.add(r);
          return r;
        };
        Object.defineProperty(patchedStatic, "name", { value: make });
        Object.defineProperty(patchedStatic, "length", { value: f.length });
        Object.defineProperty(Patched, make, {
          value: patchedStatic,
          writable: true,
          enumerable: false,
          configurable: true,
        });
      }
    }
  }
  const url = (w as unknown as Global).URL as Global | undefined;
  wrapMethod(
    url,
    "createObjectURL",
    (original) =>
      function (this: unknown, ...args: unknown[]) {
        if (isUserContent(args[0])) {
          ctx.refuseOnce(FILE_CONTENT, "URL.createObjectURL of a user's file");
        }
        return original.apply(this, args);
      },
  );
}

/** Refuse a read of a user's file's contents, before it runs. */
function refuseUserContent(ctx: SeamContext, of: unknown, what: string): void {
  if (isUserContent(of)) ctx.refuseOnce(FILE_CONTENT, what);
}

function patchBlobReads(ctx: SeamContext): void {
  const proto = protoOf(ctx.w, "Blob");
  for (const name of BLOB_READS) {
    wrapMethod(
      proto,
      name,
      (original) =>
        function (this: unknown, ...args: unknown[]) {
          refuseUserContent(ctx, this, `Blob.${name} of a user's file`);
          const settled = original.apply(this, args) as Promise<unknown>;
          return recordPlatformTask(ctx, settled);
        },
    );
  }
  wrapMethod(
    proto,
    "stream",
    (original) =>
      function (this: unknown, ...args: unknown[]) {
        refuseUserContent(ctx, this, "Blob.stream of a user's file");
        ctx.refuseOnce(UNRECORDABLE_PLATFORM_TASK, "Blob.stream");
        return original.apply(this, args);
      },
  );
}

function patchRequestReads(ctx: SeamContext): void {
  const proto = protoOf(ctx.w, "Request");
  for (const name of BODY_READS) {
    wrapMethod(
      proto,
      name,
      (original) =>
        function (this: unknown, ...args: unknown[]) {
          refuseUserContent(ctx, this, `Request.${name} of a user's file`);
          const settled = original.apply(this, args) as Promise<unknown>;
          return recordPlatformTask(ctx, settled);
        },
    );
  }
}

function patchSubtle(ctx: SeamContext): void {
  const proto = protoOf(ctx.w, "SubtleCrypto");
  wrapMethod(
    proto,
    "digest",
    (original) =>
      function (this: unknown, ...args: unknown[]) {
        refuseUserContent(
          ctx,
          args[1],
          "crypto.subtle.digest of a user's file",
        );
        const settled = original.apply(this, args) as Promise<unknown>;
        return recordPlatformTask(ctx, settled);
      },
  );
  for (const name of SUBTLE_METHODS) {
    wrapMethod(
      proto,
      name,
      (original) =>
        function (this: unknown, ...args: unknown[]) {
          ctx.refuseOnce(UNRECORDABLE_PLATFORM_TASK, `crypto.subtle.${name}`);
          return original.apply(this, args);
        },
    );
  }
}

function patchFileReader(ctx: SeamContext): void {
  const proto = protoOf(ctx.w, "FileReader");
  for (const name of FILE_READER_READS) {
    wrapMethod(
      proto,
      name,
      (original) =>
        function (this: unknown, ...args: unknown[]) {
          refuseUserContent(
            ctx,
            args[0],
            `FileReader.${name} of a user's file`,
          );
          ctx.refuseOnce(UNRECORDABLE_PLATFORM_TASK, `FileReader.${name}`);
          return original.apply(this, args);
        },
    );
  }
}

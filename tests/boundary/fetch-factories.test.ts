/**
 * Reusable fetch library boundaries against real Chromium and a local HTTP
 * server: native streaming/error/abort behavior, actual Recorder/strict codec,
 * and actual owned replay scheduler/dom-v1 checkpoints. Exact existing native
 * exception differences are diagnostics, not claimed native parity. No mocked transport,
 * cursor, Response or runner. A setup-only iterator fault is explicitly injected
 * in the fixture to witness original exception identity/reentry/failed retry.
 * Native timer observation shares Recorder/Replay ids with fetch, not a fake
 * wire tape. This is bounded library preparation, not framework conformance.
 */
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import ts from "typescript";
import * as path from "node:path";
import * as http from "node:http";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  loadPlaywright,
  type Browser,
  type BrowserContext,
  type Page,
} from "./harness.js";

const TIMEOUT = 60_000;
const root = path.resolve(__dirname, "../..");
const fixture = path.join(__dirname, "fixtures/fetch-factories.js");
let browser: Browser,
  server: http.Server,
  origin: string,
  bundle: string,
  legacyBundle: string;
const legacy = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures/fetch-legacy.json"), "utf8"),
);
const requests: { url: string; body: string; header: string | undefined }[] =
  [];
const contexts: BrowserContext[] = [];
const timers = new Set<ReturnType<typeof setTimeout>>();
const later = (fn: () => void, ms: number) => {
  const timer = setTimeout(() => {
    timers.delete(timer);
    fn();
  }, ms);
  timers.add(timer);
};
const html =
  '<!doctype html><input type="password" value="native-sensitive-value"><main id="out"></main>';

async function bundled(mutation?: string): Promise<string> {
  if (mutation === "legacy") {
    const output = await build({
      entryPoints: [fixture],
      absWorkingDir: root,
      bundle: true,
      platform: "browser",
      format: "iife",
      target: "es2020",
      write: false,
      metafile: true,
      define: { __FETCH_LEGACY__: "true" },
      plugins: [
        {
          name: "immutable-original-fetch",
          setup(plugin) {
            plugin.onLoad(
              { filter: /\/(seams-net|replay\/net)\.ts$/ },
              async (args) => {
                let source = await fs.promises.readFile(args.path, "utf8");
                const replay = args.path.endsWith("/replay/net.ts"),
                  name = replay ? "replayFetch" : "patchFetch",
                  saved = legacy.functions[name];
                if (
                  createHash("sha256").update(saved.source).digest("hex") !==
                  saved.sha256
                )
                  throw Error("immutable legacy function hash changed");
                const start = source.indexOf("function " + name + "("),
                  end = source.indexOf(
                    replay
                      ? "\nfunction replayBeacon"
                      : "\n/** `XMLHttpRequest.readyState`",
                    start,
                  );
                if (start < 0 || end < 0)
                  throw Error("exact legacy replacement anchors changed");
                source =
                  source.slice(0, start) +
                  saved.source +
                  "\n" +
                  source.slice(end);
                source = source.replace(
                  replay
                    ? 'import { prepareFetch } from "../fetch-preparation.js";\n'
                    : 'import { prepareFetch } from "./fetch-preparation.js";\n',
                  "",
                );
                const exported = replay
                  ? "createReplayFetch"
                  : "createRecordFetch";
                source +=
                  "\nexport function " +
                  exported +
                  '(ctx){const before=Object.getOwnPropertyDescriptor(ctx.w,"fetch");' +
                  name +
                  '(ctx);const call=ctx.w.fetch;Object.defineProperty(ctx.w,"fetch",before);return call;}\n';
                return {
                  contents: source,
                  loader: "ts",
                  resolveDir: path.dirname(args.path),
                };
              },
            );
          },
        },
      ],
    });
    expect(
      Object.keys(output.metafile!.inputs).some((file) =>
        file.includes("fetch-preparation"),
      ),
    ).toBe(false);
    return output.outputFiles![0].text;
  }
  const plugins = mutation
    ? [
        {
          name: "exact-fetch-inverse",
          setup(plugin: import("esbuild").PluginBuild) {
            plugin.onLoad(
              { filter: /\/(fetch-preparation|seams-net|replay\/net)\.ts$/ },
              async (args) => {
                const source = await fs.promises.readFile(args.path, "utf8");
                let old: string | undefined, next: string | undefined;
                if (
                  mutation === "reuse" &&
                  args.path.endsWith("/fetch-preparation.ts")
                ) {
                  old = "return previous.fetch;";
                  next = "return make();";
                }
                if (
                  mutation === "conflict" &&
                  args.path.endsWith("/fetch-preparation.ts")
                ) {
                  old =
                    "previous.context !== context || previous.mode !== mode";
                  next = "false";
                }
                if (
                  mutation === "global" &&
                  args.path.endsWith("/fetch-preparation.ts")
                ) {
                  old = "preparation.fetch = make();";
                  next =
                    "preparation.fetch = make(); (realm as Window).fetch = preparation.fetch;";
                }
                if (
                  mutation === "record-bypass" &&
                  args.path.endsWith("/seams-net.ts")
                ) {
                  old =
                    "if (!rec.recording) return origFetch.call(w, input, init);";
                  next = "if (true) return origFetch.call(w, input, init);";
                }
                if (
                  mutation === "replay-global" &&
                  args.path.endsWith("/replay/net.ts")
                ) {
                  old =
                    "return function fetch(input: RequestInfo | URL, init?: RequestInit) {";
                  next =
                    "return w.fetch; return function fetch(input: RequestInfo | URL, init?: RequestInit) {";
                }
                if (
                  mutation === "replay-raw" &&
                  args.path.endsWith("/replay/net.ts")
                ) {
                  old =
                    "return function fetch(input: RequestInfo | URL, init?: RequestInit) {";
                  next =
                    "return orig.fetch!; return function fetch(input: RequestInfo | URL, init?: RequestInit) {";
                }
                if (old === undefined) return;
                if (source.split(old).length !== 2)
                  throw new Error(
                    "inverse exact source anchor changed: " + mutation,
                  );
                return {
                  contents: source.replace(old, next!),
                  loader: "ts",
                  resolveDir: path.dirname(args.path),
                };
              },
            );
          },
        },
      ]
    : [];
  return (
    await build({
      entryPoints: [fixture],
      absWorkingDir: root,
      bundle: true,
      platform: "browser",
      format: "iife",
      target: "es2020",
      write: false,
      define: { __FETCH_LEGACY__: "false" },
      plugins,
    })
  ).outputFiles![0].text;
}
beforeAll(async () => {
  bundle = await bundled();
  legacyBundle = await bundled("legacy");
  browser = await loadPlaywright().chromium.launch({ headless: true });
  server = http.createServer((req, res) => {
    if (!req.url?.startsWith("/api/")) {
      res.setHeader("Content-Type", "text/html");
      res.end(html);
      return;
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      requests.push({
        url: req.url!,
        body,
        header: req.headers["x-factory-test"] as string | undefined,
      });
      if (req.url === "/api/fail") {
        req.socket.destroy();
        return;
      }
      if (req.url === "/api/redirect") {
        res.writeHead(302, { Location: "/api/data?redirected=1" });
        res.end();
        return;
      }
      if (req.url === "/api/late-head") {
        later(() => {
          if (!res.destroyed) {
            res.setHeader("X-Factory", "native");
            res.end("late");
          }
        }, 200);
        return;
      }
      if (req.url === "/api/invalid-json") {
        res.setHeader("Content-Type", "application/json");
        res.end("not json");
        return;
      }
      if (req.url === "/api/empty") {
        res.writeHead(204, { "X-Factory": "native" });
        res.end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": req.url!.includes("consumer=formData")
          ? "application/x-www-form-urlencoded"
          : "text/plain; charset=utf-8",
        "X-Factory": "native",
      });
      if (req.url!.startsWith("/api/slow")) {
        res.flushHeaders();
        later(() => {
          if (!res.destroyed) res.write("first:");
        }, 50);
        later(() => {
          if (!res.destroyed) res.end("second");
        }, 100);
        return;
      }
      res.end(
        req.url === "/api/large"
          ? "public body ".repeat(300)
          : "native response",
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin =
    "http://127.0.0.1:" +
    (server.address() as import("node:net").AddressInfo).port;
}, TIMEOUT);
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((c) => c.close()));
});
afterAll(async () => {
  for (const timer of timers) clearTimeout(timer);
  await Promise.all(contexts.map((c) => c.close()));
  await browser?.close();
  if (server !== undefined)
    await new Promise<void>((resolve) => server.close(() => resolve()));
});
async function page(source = bundle): Promise<Page> {
  const context = await browser.newContext();
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(origin);
  await page.evaluate((source) => (0, eval)(source), source);
  return page;
}
type Recorded = {
  result: unknown[];
  unchanged: boolean;
  reuse: boolean;
  log: string;
  records: { record: string; [key: string]: unknown }[];
};
async function record(mode: string, source = bundle): Promise<Recorded> {
  const p = await page(source);
  return p.evaluate((mode) => (window as any).factoryRecord(mode), mode);
}
async function replay(
  mode: string,
  recorded: Recorded,
  source = bundle,
  allowPending = false,
) {
  const p = await page(source);
  await p.evaluate(() => {
    document.querySelector("input")!.value = "replay-placeholder-value";
  });
  await p.evaluate(
    (input) => {
      void (window as any).factoryReplay(input);
    },
    { mode, log: recorded.log },
  );
  const deadline = Date.now() + 15_000;
  let final: any;
  do {
    final = await p.evaluate(() => (window as any).factoryFinal?.());
    if (
      final &&
      (final.error ||
        ["done", "diverged"].includes(final.status.state) ||
        (allowPending && final.result))
    )
      return final;
    await new Promise((r) => setTimeout(r, 10));
  } while (Date.now() < deadline);
  throw new Error("real owned loop did not finish: " + JSON.stringify(final));
}

describe("direct owner fetch library", () => {
  for (const mode of [
    "delayed-text",
    "ready-text",
    "clone-meta",
    "null-body",
    "opaque-null",
    "invalid-json",
    "large",
    "abort-before",
    "abort-head",
    "abort-body",
    "failure-head",
  ])
    it(
      mode + " uses native records and real owned-loop settlement",
      async () => {
        const nativePage = await page(),
          native = await nativePage.evaluate(
            (mode) => (window as any).factoryPlain(mode),
            mode,
          );
        const before = requests.length,
          r = await record(mode);
        const old = await record(mode, legacyBundle);
        expect(r.result).toEqual(old.result);
        if (mode === "abort-body") {
          expect(native).toEqual([
            {
              error: "AbortError",
              message: "The user aborted a request.",
              same: false,
            },
          ]);
          expect(old.result).toEqual([
            { error: "TypeError", message: "Failed to fetch", same: false },
          ]);
        } else if (mode === "invalid-json") {
          expect(native).toEqual([
            {
              name: "SyntaxError",
              message: `Unexpected token 'o', "not json" is not valid JSON`,
            },
          ]);
          expect(old.result).toEqual([
            {
              name: "SyntaxError",
              message: `Failed to execute 'close' on 'ReadableByteStreamController': Unexpected token 'o', "not json" is not valid JSON`,
            },
          ]);
        } else expect(r.result).toEqual(native);
        expect(r.unchanged).toBe(true);
        expect(r.reuse).toBe(true);
        const req = r.records.filter((r) => r.record === "NetRequest");
        expect(req).toHaveLength(1);
        expect(
          r.records.filter((r) => r.record === "TaskReg" && r.kind === 4),
        ).toHaveLength(1);
        expect(r.records.filter((r) => r.record === "Checkpoint")).toHaveLength(
          1,
        );
        expect(r.records.at(-1)?.record).toBe("End");
        expect(
          Buffer.from(r.log, "base64").includes(
            Buffer.from("native-sensitive-value"),
          ),
        ).toBe(false);
        if (["delayed-text", "ready-text", "large"].includes(mode)) {
          expect(
            requests
              .slice(before)
              .some(
                (r) =>
                  r.body === "field=native-sensitive-value" &&
                  r.header === "native-header",
              ),
          ).toBe(true);
          expect(req[0].body_digest).toMatch(/^[0-9a-f]{64}$/);
        }
        const count = requests.length,
          replayed = await replay(mode, r);
        expect(replayed.witnessed).toBe(true);
        expect(replayed.raw).toBe(0);
        if (mode !== "null-body") expect(replayed.error).toBeUndefined();
        expect(replayed.unchanged).toBe(true);
        expect(replayed.reuse).toBe(true);
        if (mode === "null-body") {
          expect(native[0]).toMatchObject({ status: 204, bodyNull: false });
          const refusal = r.records.find((r) => r.record === "Refusal");
          expect(refusal).toEqual({
            record: "Refusal",
            seq: "4",
            feature: "unrecordable-response-body",
            detail: "fetch response basic 204",
          });
          const oldReplayed = await replay(mode, old, legacyBundle);
          expect(
            old.records.find((record) => record.record === "Refusal"),
          ).toEqual(refusal);
          for (const observed of [replayed, oldReplayed]) {
            expect(observed.witnessed).toBe(true);
            expect(observed.raw).toBe(0);
            expect(observed.unchanged).toBe(true);
            expect(observed.latched.before).toEqual(observed.latched.after);
            expect(observed.latched.before).toMatchObject({
              kind: "Refusal",
              seq: "4",
              record: refusal,
            });
            expect(observed.latched).toMatchObject({
              name: "ReplayDivergence",
              divergence: { kind: "NonReplayable", seq: "4" },
              same: true,
            });
            expect(observed.status.state).toBe("diverged");
            expect(observed.status.divergence).toMatchObject({
              kind: "NonReplayable",
              seq: "4",
              recorded:
                'Refusal{feature="unrecordable-response-body", detail="fetch response basic 204"}',
            });
            expect(observed.next).toMatchObject({
              kind: "Refusal",
              seq: "4",
              record: refusal,
            });
          }
        } else {
          expect(replayed.status.state, JSON.stringify(replayed.status)).toBe(
            "done",
          );
          expect(replayed.status.checkpoints).toBe(1);
          expect(replayed.result).toEqual(r.result);
          expect(replayed.status.tasks).toBe(
            r.records.filter((r) => r.record === "Task").length,
          );
          if (mode === "opaque-null")
            expect(r.result).toEqual([
              { status: 0, type: "opaque", bodyNull: true },
              "",
            ]);
        }
        expect(replayed.status.pageErrors).toEqual([]);
        expect(requests.length).toBe(count);
      },
      TIMEOUT,
    );
  it("keeps immutable legacy callbacks identical to extracted callback ASTs", () => {
    for (const saved of Object.values(legacy.functions) as {
      file: string;
      source: string;
      sha256: string;
      callbackPrintedSha256: string;
    }[]) {
      expect(createHash("sha256").update(saved.source).digest("hex")).toBe(
        saved.sha256,
      );
      const printed = (source: string) => {
        const sf = ts.createSourceFile(
          saved.file,
          source,
          ts.ScriptTarget.Latest,
          true,
        );
        const found: ts.FunctionExpression[] = [];
        const visit = (node: ts.Node) => {
          if (ts.isFunctionExpression(node) && node.name?.text === "fetch")
            found.push(node);
          ts.forEachChild(node, visit);
        };
        visit(sf);
        expect(found).toHaveLength(1);
        return ts
          .createPrinter({ removeComments: false })
          .printNode(ts.EmitHint.Unspecified, found[0], sf);
      };
      const old = printed(saved.source),
        current = printed(fs.readFileSync(path.join(root, saved.file), "utf8"));
      expect(createHash("sha256").update(old).digest("hex")).toBe(
        saved.callbackPrintedSha256,
      );
      expect(current).toBe(old);
    }
  });
  for (const consumer of [
    "text",
    "json",
    "arrayBuffer",
    "blob",
    "formData",
    "bytes",
  ])
    for (const copy of ["original", "clone"])
      for (const reason of ["default", "dom", "error"])
        it(
          "pending " +
            consumer +
            " " +
            copy +
            " " +
            reason +
            " retains exact legacy record and owned replay",
          async () => {
            const mode =
              "abort-consumer:" + consumer + ":" + copy + ":" + reason;
            const nativePage = await page();
            expect(
              await nativePage.evaluate(() =>
                (window as any).factoryAvailable(),
              ),
            ).toEqual([
              "text",
              "json",
              "arrayBuffer",
              "blob",
              "formData",
              "bytes",
            ]);
            const native: any = await nativePage.evaluate(
              (mode) => (window as any).factoryPlain(mode),
              mode,
            );
            const old = await record(mode, legacyBundle),
              current = await record(mode);
            expect(current.result).toEqual(old.result);
            expect(old.result).toEqual([
              {
                ok: false,
                name: "TypeError",
                message: "Failed to fetch",
                sameReason: false,
              },
              { pendingBeforeAbort: true, abortCalls: 1 },
            ]);
            expect(native).toEqual([
              {
                ok: false,
                name: "AbortError",
                message: "The user aborted a request.",
                sameReason: false,
              },
              { pendingBeforeAbort: true, abortCalls: 1 },
            ]);
            expect(current.unchanged && current.reuse).toBe(true);
            expect(
              current.records.filter((r) => r.record === "Refusal"),
            ).toEqual([]);
            const ends = current.records.filter(
              (r) => r.record === "WsMessage" && r.dir === 4,
            );
            expect(ends).toHaveLength(1);
            expect(
              JSON.parse(
                new TextDecoder().decode(
                  Uint8Array.from(Object.values((ends[0].data as any).bytes)),
                ),
              ),
            ).toEqual({ outcome: 3 });
            const count = requests.length,
              replayed = await replay(mode, current),
              legacyReplay = await replay(mode, old, legacyBundle);
            for (const [observed, recorded] of [
              [replayed, current],
              [legacyReplay, old],
            ] as const) {
              expect(observed.result).toEqual(recorded.result);
              expect(observed.error).toBeUndefined();
              expect(
                observed.status.state,
                JSON.stringify(observed.status),
              ).toBe("done");
              expect(observed.status.checkpoints).toBe(1);
              expect(observed.status.pageErrors).toEqual([]);
              expect(observed.status.tasks).toBe(
                recorded.records.filter((r) => r.record === "Task").length,
              );
              expect(observed.raw).toBe(0);
              expect(observed.witnessed).toBe(true);
            }
            expect(requests.length).toBe(count);
          },
          TIMEOUT,
        );
  it("reuses one context and rejects another before mutation", async () => {
    const p = await page(),
      r = await p.evaluate(() => (window as any).factoryPreflight());
    expect(r).toEqual({
      reuse: true,
      conflict: {
        name: "TypeError",
        message: "fetch preparation belongs to another context or mode",
      },
      conflictUnchanged: true,
      unchanged: true,
    });
  });
  it("preserves native Promise, receiver and argument identity when stopped or guard-faulted", async () => {
    for (const fault of [false, true]) {
      const p = await page();
      expect(
        await p.evaluate(
          (fault) => (window as any).factoryStopped(fault),
          fault,
        ),
      ).toEqual({
        identity: true,
        self: true,
        args: true,
        text: "native response",
        recording: false,
      });
    }
  });
  it("does not reserve an unsupported original and rejects cross-mode overwrite", async () => {
    const p = await page();
    expect(await p.evaluate(() => (window as any).factoryMissing())).toEqual({
      absent: true,
      present: true,
      changed: true,
    });
    const r = await record("null-body"),
      q = await page();
    for (const key of ["fetch", "Response"]) {
      const missing = await page();
      expect(
        await missing.evaluate(
          ({ log, key }) => (window as any).factoryReplayMissing(log, key),
          { log: r.log, key },
        ),
      ).toEqual({
        absent: true,
        unchanged: true,
        restored: true,
        globalUnchanged: true,
        prepared: true,
      });
    }
    const withoutResponse = await page();
    expect(
      await withoutResponse.evaluate(() =>
        (window as any).factoryRecordMissingResponse(),
      ),
    ).toEqual({
      supported: true,
      globalUnchanged: true,
      prototypesUnchanged: true,
    });
    expect(
      await q.evaluate((log) => (window as any).factoryCrossMode(log), r.log),
    ).toEqual({
      conflict: {
        name: "TypeError",
        message: "fetch preparation belongs to another context or mode",
      },
      unchanged: true,
      reuse: true,
    });
  });
  it("retains original setup failure and rejects reentry and failed retry", async () => {
    const p = await page(),
      r = await p.evaluate(() => (window as any).factorySetupFailure());
    expect(r).toEqual({
      same: true,
      reentry: {
        name: "TypeError",
        message: "fetch preparation is incomplete or failed",
      },
      retry: {
        name: "TypeError",
        message: "fetch preparation is incomplete or failed",
      },
      unchanged: true,
    });
  });
  it("preserves repeated generic installation and stopped no-op control", async () => {
    const p = await page();
    expect(
      await p.evaluate(() => (window as any).factoryGenericRepeated()),
    ).toEqual({ same: true, fetch: true, recording: false });
    const r = await record("null-body"),
      q = await page();
    expect(
      await q.evaluate(
        (log) => (window as any).factoryGenericReplayRepeated(log),
        r.log,
      ),
    ).toEqual({ same: true, fetch: true });
  });
  it("importing reservation module allocates no WeakMap; counter is independently witnessed", async () => {
    const source = (
      await build({
        stdin: {
          resolveDir: root,
          contents:
            "import {prepareFetch} from './packages/boundary-shim/src/browser/fetch-preparation.ts'; globalThis.preparationForTest=prepareFetch;",
        },
        bundle: true,
        platform: "browser",
        write: false,
      })
    ).outputFiles![0].text;
    const p = await page("");
    const r = await p.evaluate((source) => {
      const Native = WeakMap;
      let count = 0;
      window.WeakMap = class extends Native {
        constructor(...args: any[]) {
          super(...(args as []));
          count++;
        }
      } as typeof WeakMap;
      new WeakMap();
      const witnessed = count === 1;
      count = 0;
      (0, eval)(source);
      const allocations = count;
      window.WeakMap = Native;
      return { witnessed, allocations };
    }, source);
    expect(r).toEqual({ witnessed: true, allocations: 0 });
  });
  for (const inverse of [
    "reuse",
    "conflict",
    "global",
    "record-bypass",
    "replay-raw",
    "replay-global",
  ])
    it(
      "exact compiled source inverse " + inverse + " fails its specific oracle",
      async () => {
        const mutated = await bundled(inverse);
        if (inverse === "reuse") {
          const r = await record("clone-meta", mutated);
          expect(r.reuse).toBe(false);
          expect(r.result[1]).toMatchObject({
            same: false,
            before: origin + "/api/data?redirected=1",
            after: "",
            clone: "",
          });
          expect(
            r.records.filter((r) => r.record === "NetRequest"),
          ).toHaveLength(1);
        } else if (inverse === "conflict") {
          const p = await page(mutated),
            r = await p.evaluate(() => (window as any).factoryPreflight());
          expect(r.conflict).toBeNull();
          expect(r.reuse).toBe(true);
          expect(r.unchanged).toBe(true);
        } else if (inverse === "global") {
          const r = await record("null-body", mutated);
          expect(r.unchanged).toBe(false);
          expect(
            r.records.filter((r) => r.record === "NetRequest"),
          ).toHaveLength(1);
          expect(r.result[0]).toMatchObject({ status: 204 });
        } else if (inverse === "record-bypass") {
          const r = await record("null-body", mutated);
          expect(r.result[0]).toMatchObject({ status: 204 });
          expect(
            r.records.filter((r) => r.record === "NetRequest"),
          ).toHaveLength(0);
          expect(r.records.at(-1)?.record).toBe("End");
        } else if (inverse === "replay-global") {
          const r = await record("null-body"),
            count = requests.length,
            out = await replay("null-body", r, mutated, true);
          expect(out.witnessed).toBe(true);
          expect(out.raw).toBe(0);
          expect(out.error).toMatchObject({
            name: "ReplayDivergence",
            divergence: {
              kind: "ExtraRead",
              seq: "1",
              actual: "TaskReg{task_id=1, kind=13, delay_ms=0}",
            },
          });
          expect(out.status.state).toBe("diverged");
          expect(requests.length).toBe(count + 1);
          expect(out.next).toMatchObject({ kind: "NetRequest", seq: "1" });
        } else {
          const r = await record("null-body"),
            out = await replay("null-body", r, mutated);
          expect(out.witnessed).toBe(true);
          expect(out.raw).toBe(1);
          expect(out.error).toMatchObject({
            name: "Error",
            message: "raw replay fetch",
          });
          expect(out.next).toMatchObject({ kind: "NetRequest", seq: "1" });
        }
      },
      TIMEOUT,
    );
});

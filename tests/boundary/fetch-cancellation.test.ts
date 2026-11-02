/** Real HTTP and Chromium, untouched native controls followed by actual owner
 * Record/strict decoder/owned Replay. The existing genuine timer bridge is
 * reused. Application cancellation reasons/getters are deliberate inputs;
 * no transport, Response, codec, allocator or scheduler is mocked.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { build } from "esbuild";
import { beforeAll, afterAll, afterEach, expect, it } from "vitest";
import {
  loadPlaywright,
  type Browser,
  type BrowserContext,
} from "./harness.js";

let browser: Browser, server: http.Server, origin: string, bundle: string;
let recordInverse: string, replayInverse: string;
let requests = 0;
const contexts: BrowserContext[] = [];
const pendingResponses = new Set<http.ServerResponse>();
beforeAll(async () => {
  const directory = path.join(__dirname, "fixtures");
  bundle = (
    await build({
      stdin: {
        contents:
          fs.readFileSync(path.join(directory, "fetch-factories.js"), "utf8") +
          "\n" +
          fs.readFileSync(
            path.join(directory, "fetch-cancellation.inc.js"),
            "utf8",
          ),
        resolveDir: directory,
      },
      bundle: true,
      platform: "browser",
      format: "iife",
      write: false,
      define: { __FETCH_LEGACY__: "false" },
    })
  ).outputFiles[0].text;
  const mutation = async (file: string, from: string, to: string) => {
    let hits = 0;
    const target = path.resolve(__dirname, "../../", file);
    const result = await build({
      stdin: {
        contents:
          fs.readFileSync(path.join(directory, "fetch-factories.js"), "utf8") +
          "\n" +
          fs.readFileSync(
            path.join(directory, "fetch-cancellation.inc.js"),
            "utf8",
          ),
        resolveDir: directory,
      },
      bundle: true,
      platform: "browser",
      format: "iife",
      write: false,
      define: { __FETCH_LEGACY__: "false" },
      plugins: [
        {
          name: "actual-production-cancellation-inverse",
          setup(plugin) {
            plugin.onLoad({ filter: /\.(ts|js)$/ }, (args) => {
              if (args.path !== target) return;
              const stat = fs.lstatSync(args.path);
              expect(
                stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1,
              ).toBe(true);
              expect(fs.realpathSync(args.path)).toBe(target);
              const source = fs.readFileSync(args.path, "utf8");
              expect(
                source.split(from),
                "production inverse must have exactly one real anchor",
              ).toHaveLength(2);
              hits++;
              return { contents: source.replace(from, to), loader: "ts" };
            });
          },
        },
      ],
    });
    expect(hits).toBe(1);
    return result.outputFiles[0].text;
  };
  recordInverse = await mutation(
    "packages/boundary-shim/src/browser/fetch-cancellation.ts",
    "if (error === token && pageSignal !== undefined) {",
    "if (false && error === token && pageSignal !== undefined) {",
  );
  replayInverse = await mutation(
    "packages/boundary-shim/src/browser/replay/net.ts",
    "? signalReason()\n",
    '? (signalReason() ?? new w.DOMException("lost null", "AbortError"))\n',
  );
  server = http.createServer((request, response) => {
    if (request.url === "/") {
      response.end('<!doctype html><main id="out"></main>');
      return;
    }
    requests++;
    if (request.url === "/api/fail") {
      request.socket.destroy();
      return;
    }
    if (request.url === "/api/empty") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.url === "/api/head") {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.flushHeaders();
      pendingResponses.add(response);
      response.on("close", () => pendingResponses.delete(response));
      return;
    }
    if (request.url === "/api/late-head") {
      pendingResponses.add(response);
      response.on("close", () => pendingResponses.delete(response));
      return;
    }
    response.end("successful control");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin =
    "http://127.0.0.1:" +
    (server.address() as import("node:net").AddressInfo).port;
  browser = await loadPlaywright().chromium.launch({ headless: true });
}, 60_000);
afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close();
});
afterAll(async () => {
  await browser?.close();
  for (const response of pendingResponses) response.destroy();
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
});
async function page(source = bundle) {
  const context = await browser.newContext();
  contexts.push(context);
  const result = await context.newPage();
  await result.goto(origin);
  await result.evaluate((source) => (0, eval)(source), source);
  return result;
}
async function qualify(mode: string) {
  const nativePage = await page();
  const native: any = await nativePage.evaluate(
    (mode) => (window as any).factoryPlain(mode),
    mode,
  );
  expect(native.value.sameReason, "untouched native reason identity").toBe(
    true,
  );
  expect(
    native.trace,
    "native does not read arbitrary own reason/signal getters",
  ).toEqual([]);
  expect(native.abortEvents).toBe(1);
  expect(native.signalAborted).toBe(true);
  if (mode.includes(":pending:") || mode.includes(":stopped-event:"))
    expect(native.pendingBeforeAbort).toBe(true);

  const recordPage = await page();
  const recorded: any = await recordPage.evaluate(
    (mode) => (window as any).factoryRecord(mode),
    mode,
  );
  expect(
    recorded.records.filter((record: any) => record.record === "Refusal"),
  ).toEqual([]);
  expect(recorded.records.at(-1).record).toBe("End");
  expect(JSON.stringify(recorded.records)).not.toContain(
    "private fetch cancellation",
  );
  expect(JSON.stringify(recorded.records)).not.toContain("page cancellation");
  expect(JSON.stringify(recorded.records)).not.toContain("page timeout");
  const response = recorded.records.find(
    (record: any) => record.record === "NetResponse",
  );
  const timed = mode.endsWith(":timeout") || mode.endsWith(":native-timeout");

  const replayPage = await page();
  const pageErrors: string[] = [];
  replayPage.on("pageerror", (error) => pageErrors.push(error.message));
  const beforeRequests = requests;
  await replayPage.evaluate(
    ({ mode, log }) => void (window as any).factoryReplay({ mode, log }),
    { mode, log: recorded.log },
  );
  let replay: any;
  for (let i = 0; i < 200; i++) {
    replay = await replayPage.evaluate(() => (window as any).factoryFinal());
    if (replay.error || ["done", "diverged"].includes(replay.status.state))
      break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(pageErrors).toEqual([]);
  expect(requests).toBe(beforeRequests);
  expect(replay.raw).toBe(0);
  expect(replay.witnessed).toBe(true);
  console.log(
    JSON.stringify({
      mode,
      native,
      record: recorded.result,
      outcome: response.outcome,
      replay: {
        result: replay.result,
        error: replay.error,
        status: replay.status,
        next: replay.next,
      },
    }),
  );
  expect(
    recorded.result,
    "actual Record preserves native page cancellation observation",
  ).toEqual(native);
  expect(replay.error).toBeUndefined();
  expect(
    replay.status.state,
    "real owned Replay must complete, deadline is not success",
  ).toBe("done");
  expect(replay.next.kind).toBe("End");
  expect(replay.status.checkpoints).toBe(1);
  expect(replay.result).toEqual(native);
  expect(response.outcome).toBe(timed ? 4 : 3);
}
for (const timing of ["pre-aborted", "pending"])
  for (const reason of [
    "default",
    "error",
    "dom",
    "timeout",
    "string",
    "number",
    "null",
    "name-getter",
  ])
    it(
      timing +
        " preserves " +
        reason +
        " cancellation through actual owned replay",
      async () => {
        await qualify("cancellation:" + timing + ":" + reason);
      },
      60_000,
    );
for (const [timing, reason] of [
  ["stopped-event", "error"],
  ["own-signal-getters", "null"],
  ["native-timeout", "native-timeout"],
  ["expired-timeout", "native-timeout"],
])
  it(
    timing + " preserves actual native signal behavior",
    async () => {
      await qualify("cancellation:" + timing + ":" + reason);
    },
    60_000,
  );

for (const timing of ["failure-equal", "getter-error"])
  it(
    timing +
      " remains a noncausal failure despite signal equality or AbortError name",
    async () => {
      const mode = "cancellation:" + timing + ":dom";
      const nativePage = await page();
      const native: any = await nativePage.evaluate(
        ({ mode, timing }) =>
          timing === "failure-equal"
            ? (window as any).factoryCancellationNative(mode)
            : (window as any).factoryPlain(mode),
        { mode, timing },
      );
      expect(native.value).toMatchObject(
        timing === "failure-equal"
          ? {
              name: "TypeError",
              message: "Failed to fetch",
              sameReason: true,
              sameThrown: false,
            }
          : {
              name: "AbortError",
              message: "page cancellation",
              sameReason: false,
              sameThrown: true,
            },
      );
      expect(native.abortEvents).toBe(timing === "failure-equal" ? 1 : 0);
      expect(native.signalAborted).toBe(timing === "failure-equal");
      expect(native.trace).toEqual(
        timing === "getter-error" ? ["init.headers"] : [],
      );
      const recordPage = await page();
      const recorded: any = await recordPage.evaluate(
        ({ mode, timing }) =>
          timing === "failure-equal"
            ? (window as any).factoryCancellationRecord(mode)
            : (window as any).factoryRecord(mode),
        { mode, timing },
      );
      expect(
        recorded.records.filter((record: any) => record.record === "Refusal"),
      ).toEqual([]);
      expect(recorded.records.at(-1).record).toBe("End");
      const replayPage = await page(),
        pageErrors: string[] = [];
      replayPage.on("pageerror", (error) => pageErrors.push(error.message));
      const beforeRequests = requests;
      await replayPage.evaluate(
        ({ mode, log }) => void (window as any).factoryReplay({ mode, log }),
        { mode, log: recorded.log },
      );
      let replay: any;
      for (let i = 0; i < 200; i++) {
        replay = await replayPage.evaluate(() =>
          (window as any).factoryFinal(),
        );
        if (replay.error || ["done", "diverged"].includes(replay.status.state))
          break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      console.log(
        JSON.stringify({
          mode,
          native,
          record: recorded.result,
          replay: {
            result: replay.result,
            status: replay.status,
            error: replay.error,
          },
        }),
      );
      expect(pageErrors).toEqual([]);
      expect(requests).toBe(beforeRequests);
      expect(replay.raw).toBe(0);
      expect(replay.witnessed).toBe(true);
      expect(recorded.result).toEqual(native);
      expect(replay.error).toBeUndefined();
      expect(replay.status.state).toBe("done");
      expect(replay.status.checkpoints).toBe(1);
      expect(replay.next.kind).toBe("End");
      expect(replay.result).toEqual(native);
      expect(
        recorded.records.find((record: any) => record.record === "NetResponse")
          .outcome,
      ).toBe(2);
    },
    60_000,
  );

for (const kind of [
  "reject",
  "null",
  "eof",
  "cancel",
  "clone",
  "body-abort",
  "reader-closed",
  "low-capability",
])
  it(
    kind +
      " releases the private mirror at the actual terminal native boundary",
    async () => {
      const observedPage = await page();
      const observed: any = await observedPage.evaluate(
        (kind) => (window as any).factoryCancellationCleanup(kind),
        kind,
      );
      expect(observed.refusals).toEqual([]);
      expect(observed.last).toBe("End");
      expect(observed.added).toBe(kind === "low-capability" ? 0 : 1);
      expect(observed.removed).toBe(kind === "low-capability" ? 0 : 1);
      expect(observed.sameRegistration).toBe(true);
      expect(observed.privateTarget).toBe(true);
      expect(observed.rawArguments).toBe(kind === "low-capability");
      if (
        ["cancel", "eof", "clone", "body-abort", "reader-closed"].includes(kind)
      )
        expect(
          observed.beforeCompletion,
          "body remains cancellable after headers",
        ).toBe(0);
      if (kind === "null") expect(observed.beforeCompletion).toBe(1);
      if (
        ["reject", "low-capability", "body-abort", "reader-closed"].includes(
          kind,
        )
      )
        expect(observed.error.name).toBe("AbortError");
    },
    60_000,
  );

it("actual native nonnull204 keeps exact Refusal and raw cancellation on its exceptional path", async () => {
  const observedPage = await page();
  const observed: any = await observedPage.evaluate(() =>
    (window as any).factoryCancellationExceptional(),
  );
  expect(observed.native).toMatchObject({ status: 204, bodyNull: false });
  expect(observed.recorded).toEqual(observed.native);
  expect(observed.added).toBe(1);
  expect(
    observed.removed,
    "already-refused raw body retains its once-only mirror until abort",
  ).toBe(0);
  expect(observed.refusals).toEqual([
    {
      record: "Refusal",
      seq: "4",
      feature: "unrecordable-response-body",
      detail: "fetch response basic 204",
    },
  ]);
  expect(observed.last).toBe("End");
}, 60_000);

for (const inverse of ["cause", "null"])
  it(
    "compiled " +
      inverse +
      " production inverse breaks the same qualified cancellation path",
    async () => {
      const mode =
        inverse === "cause"
          ? "cancellation:pre-aborted:error"
          : "cancellation:pre-aborted:null";
      // Genuine same-path success first, with all native/Record/Replay checks.
      await qualify(mode);
      const recordPage = await page(
        inverse === "cause" ? recordInverse : bundle,
      );
      const recorded: any = await recordPage.evaluate(
        (mode) => (window as any).factoryRecord(mode),
        mode,
      );
      expect(
        recorded.records.filter((record: any) => record.record === "Refusal"),
      ).toEqual([]);
      expect(recorded.records.at(-1).record).toBe("End");
      if (inverse === "cause") {
        expect(recorded.result.value).toMatchObject({
          name: "AbortError",
          message: "private fetch cancellation",
          sameReason: false,
        });
        expect(
          recorded.records.find(
            (record: any) => record.record === "NetResponse",
          ).outcome,
        ).toBe(2);
      } else
        expect(recorded.result.value).toMatchObject({
          isNull: true,
          primitive: null,
          sameReason: true,
        });
      const replayPage = await page(
          inverse === "null" ? replayInverse : bundle,
        ),
        pageErrors: string[] = [];
      replayPage.on("pageerror", (error) => pageErrors.push(error.message));
      const beforeRequests = requests;
      await replayPage.evaluate(
        ({ mode, log }) => void (window as any).factoryReplay({ mode, log }),
        { mode, log: recorded.log },
      );
      let replay: any;
      for (let i = 0; i < 200; i++) {
        replay = await replayPage.evaluate(() =>
          (window as any).factoryFinal(),
        );
        if (replay.error || ["done", "diverged"].includes(replay.status.state))
          break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(pageErrors).toEqual([]);
      expect(requests).toBe(beforeRequests);
      expect(replay.raw).toBe(0);
      expect(replay.witnessed).toBe(true);
      expect(replay.error).toBeUndefined();
      expect(replay.status.state).toBe("diverged");
      expect(replay.status.divergence.kind).toBe("CheckpointMismatch");
      expect(replay.status.divergence.seq).toBe(
        inverse === "cause" ? "5" : "4",
      );
      expect(replay.status.checkpoints).toBe(0);
      expect(replay.next.kind).toBe("Checkpoint");
      expect(replay.result.value).toMatchObject(
        inverse === "cause"
          ? { name: "TypeError", message: "Failed to fetch", sameReason: false }
          : { name: "AbortError", message: "lost null", sameReason: false },
      );
    },
    60_000,
  );

for (const kind of ["normal", "null", "throw"])
  it(
    kind + " Response.body getter retains original count and guard boundary",
    async () => {
      const observedPage = await page();
      const observed: any = await observedPage.evaluate(
        (kind) => (window as any).factoryCancellationBodyObservation(kind),
        kind,
      );
      expect(observed.error).toBeUndefined();
      expect(observed.reads).toBe(kind === "normal" ? 2 : 1);
      expect(observed.sameResponse).toBe(kind !== "normal");
      expect(observed.value).toBe(kind === "null" ? "" : "successful control");
      if (kind === "throw") {
        expect(observed.records.map((record: any) => record.record)).toEqual([
          "Header",
          "Env",
          "NetRequest",
          "TaskReg",
          "Task",
          "Refusal",
        ]);
        expect(observed.records.at(-1)).toMatchObject({
          record: "Refusal",
          feature: "recorder-fault",
        });
      } else {
        expect(
          observed.records.filter((record: any) => record.record === "Refusal"),
        ).toEqual([]);
        expect(observed.records.at(-1).record).toBe("End");
      }
    },
    60_000,
  );

it("an own null body getter cannot detach cancellation from a real pending native body", async () => {
  const observedPage = await page();
  const observed: any = await observedPage.evaluate(() =>
    (window as any).factoryCancellationShadowNull(),
  );
  console.log(JSON.stringify({ shadowNull: observed }));
  expect(observed.native.internalBodyNull).toBe(false);
  expect(observed.native.deadline).toBe(false);
  expect(observed.native.error).toEqual({
    name: "AbortError",
    message: "The user aborted a request.",
    sameReason: false,
  });
  expect(observed.nativeReads).toBe(0);
  expect(observed.recordReads).toBe(1);
  expect(observed.recorded).toEqual(observed.native);
  expect(
    observed.records.filter((record: any) => record.record === "Refusal"),
  ).toEqual([]);
  expect(observed.records.at(-1).record).toBe("End");
}, 60_000);

it("a page-created body EOF cannot detach cancellation from the distinct native body", async () => {
  const observedPage = await page();
  const observed: any = await observedPage.evaluate(() =>
    (window as any).factoryCancellationForeignBody(),
  );
  console.log(JSON.stringify({ foreignBody: observed }));
  expect(observed.native.shadowText).toBe("page-created shadow body");
  expect(observed.native.deadline).toBe(false);
  expect(observed.native.error).toEqual({
    name: "AbortError",
    message: "BodyStreamBuffer was aborted",
    sameReason: false,
  });
  expect(observed.nativeReads).toBe(1);
  expect(observed.recordReads).toBe(2);
  expect(observed.recorded).toEqual(observed.native);
  expect(
    observed.records.filter((record: any) => record.record === "Refusal"),
  ).toEqual([]);
  expect(observed.records.at(-1).record).toBe("End");
}, 60_000);

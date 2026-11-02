/**
 * Real Chromium, HTTP, native conversion and actual owner Record/strict decode/
 * owned replay. The shared fixture's timer bridge is unchanged. Application
 * getters and changing/throwing values are intentional observation probes;
 * no transport, Response, allocator, codec or scheduler is replaced.
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
const baseline = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "fixtures/fetch-arguments-baseline.json"),
    "utf8",
  ),
);
const contexts: BrowserContext[] = [];
let requests = 0;
beforeAll(async () => {
  const directory = path.join(__dirname, "fixtures");
  const contents =
    fs.readFileSync(path.join(directory, "fetch-factories.js"), "utf8") +
    "\n" +
    fs.readFileSync(path.join(directory, "fetch-arguments.inc.js"), "utf8");
  bundle = (
    await build({
      stdin: { contents, resolveDir: directory },
      bundle: true,
      platform: "browser",
      format: "iife",
      write: false,
      define: { __FETCH_LEGACY__: "false" },
    })
  ).outputFiles[0].text;
  server = http.createServer((req, res) => {
    if (req.url === "/") {
      res.end('<!doctype html><main id="out"></main>');
      return;
    }
    requests++;
    let body = "";
    req.on("data", (bytes) => (body += bytes));
    req.on("end", () => {
      res.end(JSON.stringify({ method: req.method, body }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin =
    "http://127.0.0.1:" +
    (server.address() as import("node:net").AddressInfo).port;
  browser = await loadPlaywright().chromium.launch({ headless: true });
}, 60_000);
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.close();
});
afterAll(async () => {
  await browser?.close();
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
});
async function page(source = bundle) {
  const ctx = await browser.newContext();
  contexts.push(ctx);
  const p = await ctx.newPage();
  await p.goto(origin);
  await p.evaluate((source) => (0, eval)(source), source);
  return p;
}
async function ownedReplay(mode: string, log: string, source = bundle) {
  const replayPage = await page(source),
    beforeRequests = requests;
  const pageErrors: string[] = [];
  replayPage.on("pageerror", (e) => pageErrors.push(e.message));
  await replayPage.evaluate(
    ({ mode, log }) => void (window as any).factoryReplay({ mode, log }),
    { mode, log },
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
  return replay;
}
it("RequestInit observations agree in actual Record and owned Replay", async () => {
  const mode = "argument:getters",
    nativePage = await page();
  const native: any = await nativePage.evaluate(
    (mode) => (window as any).factoryArgumentNative(mode),
    mode,
  );
  expect(native.trace).toEqual(["body", "headers", "method", "signal"]);
  expect(native.value).toMatchObject({ name: "AbortError", sameReason: true });
  const recordPage = await page();
  const recorded: any = await recordPage.evaluate(
    (mode) => (window as any).factoryRecord(mode),
    mode,
  );
  expect(recorded.records.filter((r: any) => r.record === "Refusal")).toEqual(
    [],
  );
  expect(recorded.records.at(-1).record).toBe("End");
  const replay = await ownedReplay(mode, recorded.log);
  expect(replay.status.state, "RequestInit Record-to-Replay consistency").toBe(
    "done",
  );
  expect(replay.next.kind).toBe("End");
  expect(replay.status.checkpoints).toBe(1);
  expect(replay.result).toEqual(recorded.result);
  expect(recorded.result).toEqual(baseline.cases.getters.record);
}, 60_000);
for (const kind of [
  "getters",
  "changing",
  "coercions",
  "request-missing",
  "request-signal-shadow",
  "request-undefined",
  "request-null",
  "throw-headers",
  "throw-signal",
  "throw-headers-typeerror",
  "throw-signal-typeerror",
  "throw-headers-null",
  "throw-signal-undefined",
  "body-string",
  "body-params",
  "body-buffer",
  "body-view",
])
  it(
    kind + " preserves actual argument observations and owned replay",
    async () => {
      const mode = "argument:" + kind,
        nativePage = await page(),
        native: any = await nativePage.evaluate(
          (mode) => (window as any).factoryArgumentNative(mode),
          mode,
        );
      expect(native, "independent native control").toEqual(
        baseline.cases[kind].native,
      );
      expect(native.returnedPromise, "native Promise positive").toBe(true);
      expect(native.receivers.every(Boolean), "native getter receivers").toBe(
        true,
      );
      if (kind === "getters") {
        expect(native.trace).toEqual(["body", "headers", "method", "signal"]);
        expect(native.value).toMatchObject({
          name: "AbortError",
          sameReason: true,
        });
      }
      if (kind.startsWith("throw-"))
        expect(native.value.sameThrown, "native thrown identity").toBe(true);
      if (kind.startsWith("body-")) {
        expect(native.trace).toEqual([]);
        expect(JSON.parse(native.value.body)).toEqual({
          method: "POST",
          body: "field=value",
        });
      }
      const recordPage = await page(),
        recorded: any = await recordPage.evaluate(
          (mode) => (window as any).factoryRecord(mode),
          mode,
        );
      expect(recorded.result, "exact preserved Record567 observation").toEqual(
        baseline.cases[kind].record,
      );
      expect(
        recorded.records.filter((r: any) => r.record === "Refusal"),
      ).toEqual([]);
      expect(recorded.records.at(-1).record).toBe("End");
      const replay = await ownedReplay(mode, recorded.log);
      expect(replay.status.state, "actual owned replay endpoint").toBe("done");
      expect(replay.next.kind).toBe("End");
      expect(replay.status.checkpoints).toBe(1);
      expect(replay.result).toEqual(recorded.result);
      expect(replay.error).toBeUndefined();
      expect(replay.status.pageErrors).toEqual([]);
      expect(replay.raw).toBe(0);
      expect(replay.witnessed).toBe(true);
    },
    60_000,
  );

for (const kind of ["throw-body", "throw-method", "request-shadow"])
  it(
    kind + " retains exact metadata-fault terminal and native fallback",
    async () => {
      const nativePage = await page();
      const native = await nativePage.evaluate(
        (mode) => (window as any).factoryArgumentNative(mode),
        "argument:" + kind,
      );
      expect(native).toEqual(baseline.cases[kind].native);
      const p = await page();
      const observed: any = await p.evaluate(
        (mode) => (window as any).factoryArgumentFault(mode),
        "argument:" + kind,
      );
      const expected = baseline.cases[kind].record;
      expect(observed.result).toEqual(expected.result);
      expect(observed.identity).toBe(true);
      expect(observed.receiver).toBe(true);
      expect(observed.args).toBe(true);
      expect(observed.records.at(-1)).toEqual(expected.terminal);
      expect(observed.records.map((r: any) => r.record)).toEqual([
        "Header",
        "Env",
        "Refusal",
      ]);
    },
  );

for (const validation of ["signal", "url", "method", "body", "header"])
  it(
    "native-generated validation " +
      validation +
      " keeps its existing mapping, distinct from a user TypeError",
    async () => {
      const kind = "validation-" + validation,
        mode = "argument:" + kind,
        p = await page();
      const native: any = await p.evaluate(
        (mode) => (window as any).factoryArgumentNative(mode),
        mode,
      );
      expect(native).toEqual(baseline.cases[kind].native);
      expect(native.value.name).toBe("TypeError");
      const q = await page();
      const recorded: any = await q.evaluate(
        (mode) => (window as any).factoryRecord(mode),
        mode,
      );
      expect(recorded.result).toEqual(baseline.cases[kind].record);
      expect(recorded.result).toEqual(native);
      const replay = await ownedReplay(mode, recorded.log);
      // Explicit retained counterexample, not native diagnostic parity or DONE.
      expect(replay.status.state).toBe("diverged");
      expect(replay.status.divergence).toMatchObject({
        kind: "CheckpointMismatch",
        seq: "5",
      });
      expect(replay.result.value).toEqual({
        name: "TypeError",
        message: "Failed to fetch",
        sameReason: false,
        sameThrown: false,
      });
      expect(
        recorded.records.filter((r: any) => r.record === "Refusal"),
      ).toEqual([]);
    },
  );

for (const inverse of ["prefix", "signal-shadow"])
  it(
    "compiled " + inverse + " inverse breaks only its observation oracle",
    async () => {
      const directory = path.join(__dirname, "fixtures");
      const contents =
        fs.readFileSync(path.join(directory, "fetch-factories.js"), "utf8") +
        "\n" +
        fs.readFileSync(path.join(directory, "fetch-arguments.inc.js"), "utf8");
      let hits = 0;
      const mutated = (
        await build({
          stdin: { contents, resolveDir: directory },
          bundle: true,
          platform: "browser",
          format: "iife",
          write: false,
          define: { __FETCH_LEGACY__: "false" },
          plugins: [
            {
              name: "actual-replay-prefix-inverse",
              setup(plugin) {
                plugin.onLoad(
                  { filter: /\/replay\/net\.ts$/ },
                  async (args) => {
                    const source = await fs.promises.readFile(
                        args.path,
                        "utf8",
                      ),
                      anchor =
                        inverse === "prefix"
                          ? "const { method, url, digest } = fetchRequestMetadata(w, ctx, input, init);"
                          : "signal = orig.requestSignal?.descriptor.get?.call(request);";
                    expect(source.split(anchor)).toHaveLength(2);
                    hits++;
                    return {
                      contents: source.replace(
                        anchor,
                        inverse === "prefix"
                          ? 'const { method, url, digest } = {method:"GET",url:absoluteUrl(w,input),digest:""};'
                          : anchor +
                              " if (input instanceof w.Request) void (input as Request).signal;",
                      ),
                      loader: "ts",
                      resolveDir: path.dirname(args.path),
                    };
                  },
                );
              },
            },
          ],
        })
      ).outputFiles[0].text;
      expect(hits).toBe(1);
      // A real successful companion first: this call has no observable prefix.
      const positive = await page();
      const companion: any = await positive.evaluate(() =>
        (window as any).factoryRecord("argument:plain-abort"),
      );
      const success = await ownedReplay(
        "argument:plain-abort",
        companion.log,
        mutated,
      );
      expect(success.status.state).toBe("done");
      expect(success.next.kind).toBe("End");
      expect(success.result).toEqual(companion.result);
      const targetMode =
        inverse === "prefix"
          ? "argument:getters"
          : "argument:request-signal-shadow";
      const p = await page(),
        recorded: any = await p.evaluate(
          (mode) => (window as any).factoryRecord(mode),
          targetMode,
        );
      const rejected = await ownedReplay(targetMode, recorded.log, mutated);
      expect(rejected.result.value).toEqual(recorded.result.value);
      expect(rejected.result.trace).toEqual(
        inverse === "prefix"
          ? baseline.cases.getters.native.trace
          : ["request.signal"],
      );
      expect(rejected.status.state).toBe("diverged");
      expect(rejected.status.divergence).toMatchObject({
        kind: "CheckpointMismatch",
        seq: "4",
      });
    },
    60000,
  );

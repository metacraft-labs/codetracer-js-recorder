/**
 * The record leg of the conformance suite (CodeTracer's
 * JS-Boundary-Recording specification §9.9): run a build's page of every
 * fixture in headless Chromium against the harness's server, perform the
 * fixture's scripted interaction, stop the session, collect its log, and
 * run the checks of `checks.ts`.
 *
 * How the log leaves the page depends on the level:
 *
 * - **level 0**, the generic shim: through its control surface,
 *   `__ctBoundaryShim.stop()` then `log()` (the shim keeps its log in the
 *   page until it has a batch transport);
 * - **level 1**, a cooperating framework: `await
 *   __ctBoundaryProtocol.record.stop()`, after which the framework has
 *   uploaded every batch to the harness's batch route, the last one
 *   `final`; the harness joins them.
 *
 * At level 1 every fixture is also recorded on its perturbed page, for the
 * `targets` check. Nothing here is a mock: a real server, a real browser,
 * the build's own pages.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { decodeLog } from "@codetracer/boundary-format";
import { buildBundleManifest } from "@codetracer/boundary-shim";

import {
  type CheckResult,
  type DeclarationSnapshot,
  type FixtureRun,
  type Recording,
  runRecordChecks,
} from "./checks.js";
import { checkBatches } from "./envelope.js";
import { type Fixture, FIXTURES, fixtureNamed, type Step } from "./fixtures.js";
import { type Browser, loadPlaywright, type Page } from "./playwright.js";
import {
  FIXTURE_ATTRIBUTE,
  fixturePage,
  PROTOCOL_VERSION,
  type ProtocolLevel,
} from "./protocol.js";
import { type HarnessServer, startHarnessServer } from "./server.js";

/** This suite's package version, written into every report. */
export const SUITE_VERSION = "0.1.0";

/** The probe bundle (`scripts/bundle.mjs` builds it). */
export const PROBE_PATH = path.join(__dirname, "..", "dist", "probe.iife.js");

export interface RecordLegOptions {
  /** The build: `/<fixture>/index.html` (and `perturbed.html` at level 1). */
  build: string;
  level: ProtocolLevel;
  /** Only these fixtures (default: all). */
  fixtures?: string[];
  /** Fixtures recorded at once (default 4). */
  concurrency?: number;
  /** A browser to use instead of launching one. */
  browser?: Browser;
  /** The limit on each step, wait and stop, in ms (default 15000). */
  timeoutMs?: number;
}

export interface FixtureReport {
  name: string;
  title: string;
  checks: CheckResult[];
}

export interface RecordLegReport {
  suite: "@codetracer/boundary-conformance";
  suiteVersion: string;
  protocol: number;
  leg: "record";
  level: ProtocolLevel;
  build: string;
  buildHash: string;
  fixtures: FixtureReport[];
  summary: { pass: number; fail: number; notApplicable: number };
  /** No check failed. */
  passed: boolean;
}

export interface RecordLegResult {
  report: RecordLegReport;
  /** What each fixture's checks were run on (the batches among it). */
  runs: FixtureRun[];
}

const selectorOf = (fx: string) => `[${FIXTURE_ATTRIBUTE}="${fx}"]`;

/** `p`, or a rejection naming `what` after `ms`. */
async function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} within ${ms} ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The trimmed text of the element `fx` names, read from Node with
 * `evaluate` (never `waitForFunction`, whose in-page polling would use
 * the page's timers and be recorded as the page's).
 */
async function textOf(page: Page, fx: string): Promise<string | null> {
  return page.evaluate(
    (sel: string) => document.querySelector(sel)?.textContent?.trim() ?? null,
    selectorOf(fx),
  );
}

async function waitForText(
  page: Page,
  fx: string,
  text: string,
  ms: number,
): Promise<string | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const actual = await textOf(page, fx);
    if (actual === text || Date.now() > deadline) return actual;
    await sleep(25);
  }
}

async function runStep(
  page: Page,
  server: HarnessServer,
  step: Step,
  ms: number,
): Promise<void> {
  switch (step.op) {
    case "click":
      await page.click(selectorOf(step.fx), { timeout: ms });
      return;
    case "type":
      await page.type(selectorOf(step.fx), step.text, { timeout: ms });
      return;
    case "waitFor": {
      const actual = await waitForText(page, step.fx, step.text, ms);
      if (actual !== step.text) {
        throw new Error(
          `${step.fx} shows ${JSON.stringify(actual)}, not ${JSON.stringify(step.text)}`,
        );
      }
      return;
    }
    case "goBack":
      await page.goBack({ timeout: ms, waitUntil: "commit" });
      return;
    case "waitForGateRequest":
      await within(
        server.gateRequested,
        ms,
        "the page did not ask for the hydration gate",
      );
      return;
    case "releaseGate":
      server.releaseGate();
      return;
  }
}

function describeStep(step: Step): string {
  return step.op + ("fx" in step ? ` ${step.fx}` : "");
}

/** Record one page of one fixture. */
async function recordPage(
  browser: Browser,
  build: string,
  fixture: Fixture,
  level: ProtocolLevel,
  perturbed: boolean,
  probeSource: string,
  ms: number,
): Promise<Recording> {
  const server = await startHarnessServer(build);
  const pagePath = fixturePage(fixture.name, perturbed);
  const problems: string[] = [];
  const recording: Recording = {
    interactionProblems: problems,
    targets: {},
    pageUrl: server.origin + pagePath,
  };
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page.goto(server.origin + pagePath, { timeout: ms });

    let stepsRan = true;
    for (const step of fixture.steps) {
      try {
        await runStep(page, server, step, ms);
      } catch (e) {
        problems.push(
          `step "${describeStep(step)}" failed: ${(e as Error).message}`,
        );
        stepsRan = false;
        break;
      }
    }
    if (stepsRan) {
      for (const f of fixture.final) {
        const actual = await waitForText(page, f.fx, f.text, ms);
        if (actual !== f.text) {
          problems.push(
            `${f.fx} shows ${JSON.stringify(actual)} at the end, expected ${JSON.stringify(f.text)}`,
          );
        }
      }
    }

    if (level === 1)
      recording.declaration = await page.evaluate(snapshotDeclaration);
    try {
      if (level === 0) {
        recording.log = Uint8Array.from(
          await within(page.evaluate(stopShim), ms, "the shim did not stop"),
        );
      } else {
        await within(
          page.evaluate(stopFramework),
          ms,
          "record.stop() did not resolve",
        );
        await within(server.finalBatch, ms, "no final batch arrived").catch(
          () => undefined,
        );
        recording.batches = server.batches.slice();
        recording.envelope = checkBatches(recording.batches);
        recording.log = recording.envelope.log;
      }
    } catch (e) {
      recording.collectError = (e as Error).message;
      if (level === 1 && server.batches.length > 0) {
        recording.batches = server.batches.slice();
        recording.envelope = checkBatches(recording.batches);
      }
    }
    for (const e of pageErrors) problems.push(`the page threw: ${e}`);

    await page.evaluate(probeSource);
    // The probe serialises the document by its own reading of dom-v1;
    // the hash is taken here, by Node, not by any recorder-side SHA-256.
    const domText = await page.evaluate(() =>
      (
        globalThis as unknown as {
          __ctConformanceProbe: { domV1Text(): string };
        }
      ).__ctConformanceProbe.domV1Text(),
    );
    recording.finalDomV1 = createHash("sha256")
      .update(domText, "utf8")
      .digest("hex");
    const targets = targetsOf(recording.log);
    recording.targets = await page.evaluate(
      (arg: { targets: string[]; level: number }) =>
        (
          globalThis as unknown as {
            __ctConformanceProbe: {
              resolve(
                t: string[],
                l: number,
              ): Record<string, { resolved: boolean; fx: string | null }>;
            };
          }
        ).__ctConformanceProbe.resolve(arg.targets, arg.level),
      { targets, level },
    );
  } catch (e) {
    problems.push(
      `the harness could not drive the page: ${(e as Error).message}`,
    );
  } finally {
    await context.close();
    await server.close();
  }
  return recording;
}

/** Every target string a log names, if it decodes far enough. */
function targetsOf(log: Uint8Array | undefined): string[] {
  if (log === undefined) return [];
  try {
    const set = new Set<string>();
    for (const r of decodeLog(log, { inlineBodies: "batch" }).records) {
      if (
        r.record === "Input" ||
        r.record === "DomEffect" ||
        r.record === "LayoutRead"
      ) {
        set.add(r.target);
      }
    }
    return [...set];
  } catch {
    return [];
  }
}

// These run in the page: no closure over anything outside them.

function snapshotDeclaration(): DeclarationSnapshot {
  const d = (globalThis as unknown as Record<string, unknown>)
    .__ctBoundaryProtocol as
    | {
        protocol?: unknown;
        framework?: unknown;
        capabilities?: unknown;
        record?: Record<string, unknown>;
      }
    | undefined;
  if (d === undefined || d === null) return { present: false };
  let capabilities: unknown;
  try {
    capabilities = JSON.parse(JSON.stringify(d.capabilities ?? null));
  } catch {
    capabilities = String(d.capabilities);
  }
  return {
    present: true,
    protocol: typeof d.protocol === "number" ? d.protocol : String(d.protocol),
    framework:
      typeof d.framework === "string" ? d.framework : String(d.framework),
    capabilities,
    hasStop: typeof d.record?.stop === "function",
    hasResolveTarget: typeof d.record?.resolveTarget === "function",
  };
}

function stopShim(): number[] {
  const shim = (globalThis as unknown as Record<string, unknown>)
    .__ctBoundaryShim as { stop(): void; log(): Uint8Array } | undefined;
  if (shim === undefined)
    throw new Error("the generic shim is not installed (no __ctBoundaryShim)");
  shim.stop();
  return Array.from(shim.log());
}

async function stopFramework(): Promise<void> {
  const d = (globalThis as unknown as Record<string, unknown>)
    .__ctBoundaryProtocol as { record?: { stop?: () => unknown } } | undefined;
  if (typeof d?.record?.stop !== "function") {
    throw new Error("the page declares no __ctBoundaryProtocol.record.stop");
  }
  await d.record.stop();
}

/** Run `f` over `items` with at most `n` at once, keeping their order. */
async function pool<T, R>(
  items: readonly T[],
  n: number,
  f: (t: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await f(items[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker),
  );
  return out;
}

/** Run the record leg on `options.build` and report. */
export async function runRecordLeg(
  options: RecordLegOptions,
): Promise<RecordLegResult> {
  const build = path.resolve(options.build);
  if (!fs.existsSync(build) || !fs.statSync(build).isDirectory()) {
    throw new Error(`the build ${build} is not a directory`);
  }
  if (options.level !== 0 && options.level !== 1) {
    throw new Error(`the level is ${String(options.level)}; it is 0 or 1`);
  }
  const fixtures = (options.fixtures ?? FIXTURES.map((f) => f.name)).map(
    fixtureNamed,
  );
  const { buildHash } = buildBundleManifest(build);
  const probeSource = fs.readFileSync(PROBE_PATH, "utf-8");
  const ms = options.timeoutMs ?? 15000;
  const browser =
    options.browser ??
    (await loadPlaywright().chromium.launch({ headless: true }));
  let runs: FixtureRun[];
  try {
    runs = await pool(fixtures, options.concurrency ?? 4, async (fixture) => {
      const [recording, perturbed] = await Promise.all([
        recordPage(
          browser,
          build,
          fixture,
          options.level,
          false,
          probeSource,
          ms,
        ),
        options.level === 1
          ? recordPage(
              browser,
              build,
              fixture,
              options.level,
              true,
              probeSource,
              ms,
            )
          : Promise.resolve(undefined),
      ]);
      return { fixture, level: options.level, buildHash, recording, perturbed };
    });
  } finally {
    if (options.browser === undefined) await browser.close();
  }
  const reports = runs.map((run) => ({
    name: run.fixture.name,
    title: run.fixture.title,
    checks: runRecordChecks(run),
  }));
  const all = reports.flatMap((r) => r.checks);
  const summary = {
    pass: all.filter((c) => c.status === "pass").length,
    fail: all.filter((c) => c.status === "fail").length,
    notApplicable: all.filter((c) => c.status === "not-applicable-at-level-0")
      .length,
  };
  return {
    report: {
      suite: "@codetracer/boundary-conformance",
      suiteVersion: SUITE_VERSION,
      protocol: PROTOCOL_VERSION,
      leg: "record",
      level: options.level,
      build,
      buildHash,
      fixtures: reports,
      summary,
      passed: summary.fail === 0,
    },
    runs,
  };
}

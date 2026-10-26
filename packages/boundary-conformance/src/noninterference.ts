/**
 * The non-interference leg of the conformance suite (CodeTracer's
 * JS-Boundary-Recording specification §11.3.6, §9.9): the claim that
 * nothing in a boundary log depends on a sensitive value except the outputs
 * of declared declassifiers, tested on every fixture with sensitive fields.
 *
 * For each fixture the leg records the scripted session twice against one
 * server origin, with the page's clocks and random sources pinned (an init
 * script that runs before the recorder captures them) and the server's
 * answers the same, typing secret X in the first session and Y in the
 * second, then checks, in report order:
 *
 * | check                        | levels | passes when |
 * |------------------------------|--------|-------------|
 * | `recordings`                 | 0, 1   | both sessions ran their interaction and their logs decode, ending with `End` |
 * | `declaration`                | 1      | the framework declares the `sensitive` capability, and `Header.capabilities` carries it (§9.2) |
 * | `vacuity`                    | 0, 1   | the two logs are not byte-identical (at least one `Declassify.output` differs), and the string typed into the public field is found in both sessions' batches, so the scan below reads them |
 * | `differs-only-in-declassify` | 0, 1   | the two decoded logs are identical record for record except `Declassify.output`; otherwise the first record that differs is named |
 * | `no-secret-in-batches`       | 0, 1   | neither secret occurs in any uploaded batch of either session, raw, URL-encoded (`encodeURIComponent` and form encoding) or JSON-escaped |
 * | `replay-a`, `replay-b`       | 0, 1   | each log replays with placeholders to its `End`, every checkpoint compared and matched |
 *
 * The sessions are driven without the pointer, and a pair that differs is
 * recorded again, up to {@link MAX_ATTEMPTS} pairs, because the browser
 * schedules some tasks by its own timing (see there); the report gives each
 * fixture's attempts and every discarded pair's first difference, and the
 * secret scan reads every session's batches.
 *
 * Nothing here is a mock: real pages, a real server, headless Chromium, the
 * shipped replay runner.
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import {
  type BoundaryRecord,
  decodeLog,
  recordToJson,
} from "@codetracer/boundary-format";
import {
  launchReplayBrowser,
  logBytes,
  replaySession,
  type ReplayReport,
} from "@codetracer/boundary-replay";
import { buildBundleManifest } from "@codetracer/boundary-shim";

import {
  DEFAULT_SECRETS,
  type Fixture,
  FIXTURES,
  fixtureNamed,
  PUBLIC_PROBE,
} from "./fixtures.js";
import type { Recording } from "./checks.js";
import { PROBE_PATH, recordPage, SUITE_VERSION } from "./harness.js";
import type { Browser } from "./playwright.js";
import {
  type CheckStatus,
  PROTOCOL_VERSION,
  type ProtocolLevel,
} from "./protocol.js";

/** The checks of the non-interference leg, in report order. */
export const NONINTERFERENCE_CHECKS = [
  "recordings",
  "declaration",
  "vacuity",
  "differs-only-in-declassify",
  "no-secret-in-batches",
  "replay-a",
  "replay-b",
] as const;

export type NoninterferenceCheckName = (typeof NONINTERFERENCE_CHECKS)[number];

/** The capability a level-1 framework declares for sensitive inputs (§9.2). */
export const SENSITIVE_CAPABILITY = "sensitive";

export interface NoninterferenceOptions {
  build: string;
  level: ProtocolLevel;
  /** Only these fixtures (default: every fixture with sensitive fields). */
  fixtures?: string[];
  /** Secret X (default {@link DEFAULT_SECRETS}[0]). */
  secretA?: string;
  /** Secret Y (default {@link DEFAULT_SECRETS}[1]). */
  secretB?: string;
  /** Fixtures run at once (default 2). */
  concurrency?: number;
  /** The limit on each step, wait, stop and replay, in ms (default 15000). */
  timeoutMs?: number;
  /** A browser to use instead of launching one (launched as the replay runner launches its own). */
  browser?: Browser;
}

export interface NoninterferenceCheckResult {
  name: NoninterferenceCheckName;
  status: CheckStatus;
  detail: string[];
}

export interface NoninterferenceFixtureReport {
  name: string;
  title: string;
  /**
   * How many pairs of sessions were recorded (at most
   * {@link MAX_ATTEMPTS}); the checks read the last, and every earlier one's
   * first difference is in `discarded`.
   */
  attempts: number;
  discarded: string[];
  checks: NoninterferenceCheckResult[];
}

export interface NoninterferenceReport {
  suite: "@codetracer/boundary-conformance";
  suiteVersion: string;
  protocol: number;
  leg: "noninterference";
  level: ProtocolLevel;
  build: string;
  buildHash: string;
  fixtures: NoninterferenceFixtureReport[];
  summary: { pass: number; fail: number; notApplicable: number };
  passed: boolean;
}

/** One session of a fixture's pair, as the checks read it. */
export interface Session {
  secret: string;
  recording: Recording;
  records?: BoundaryRecord[];
  decodeError?: string;
  replay?: ReplayReport;
}

/** What one fixture's two sessions produced. */
export interface FixturePair {
  fixture: Fixture;
  a: Session;
  b: Session;
  /** The first difference of each earlier pair, which was recorded again. */
  discarded: string[];
  /** Every session of the earlier pairs: their batches are scanned too. */
  earlier: Session[];
}

/**
 * How many pairs of sessions a fixture is recorded as, at most. The
 * browser schedules some of a page's tasks by its own timing, which no
 * pinning reaches: a small response's end arrives with its last piece or in
 * a network task of its own (`Task` kind 4). Two sessions can then differ in
 * that order alone, so a pair that differs is recorded again; a difference
 * that depends on the secret is in every pair, so the leg still fails on it,
 * naming each pair's first difference. Hover events, the other such source,
 * are kept out by driving the page without the pointer
 * (`RecordPageOptions.keyboardOnly`).
 */
export const MAX_ATTEMPTS = 3;

/**
 * The first record of two logs that differs beyond `Declassify.output`, as
 * the check reports it, or `undefined` when there is none: the one
 * predicate of the comparison (§11.3.6 step 2), used to decide whether a
 * pair is recorded again and by the check itself.
 */
export function firstDifference(
  ra: readonly BoundaryRecord[],
  rb: readonly BoundaryRecord[],
): string | undefined {
  const n = Math.max(ra.length, rb.length);
  for (let i = 0; i < n; i++) {
    const x = ra[i] === undefined ? "(none)" : comparable(ra[i]);
    const y = rb[i] === undefined ? "(none)" : comparable(rb[i]);
    if (x !== y) {
      return `record ${i} differs beyond Declassify.output: with X ${x}, with Y ${y}`;
    }
  }
  return undefined;
}

/** Why a pair of secrets cannot test non-interference, or `undefined`. */
export function secretsProblem(a: string, b: string): string | undefined {
  if (a === b) return "the two secrets are the same";
  if (a.length !== b.length) {
    return `the secrets differ in UTF-16 length (${a.length} and ${b.length})`;
  }
  if (a.length < 4) {
    return "a secret must be at least 4 UTF-16 code units, the shortest value a recorder holes (§5.2.1)";
  }
  // The same keystroke shape: every character is one printable key, typed
  // as one keystroke, so the two sessions press the same named keys (none)
  // at the same positions.
  for (const s of [a, b]) {
    for (const c of s) {
      if (c.length !== 1 || /[\u0000-\u001f\u007f]/.test(c)) {
        return `the secret ${JSON.stringify(s)} holds a character that is not one printable key`;
      }
    }
  }
  return undefined;
}

/**
 * Pins what a page reads of the clock and of the random sources, so two
 * sessions differ only in what was typed (§11.3.6 step 1). Runs before any
 * page script, so the recorder captures these as its originals.
 */
export const PIN_SCRIPT = `(() => {
  const define = (o, k, v) =>
    Object.defineProperty(o, k, { value: v, configurable: true, writable: true });
  define(Date, "now", function now() { return 1761000000000; });
  define(Performance.prototype, "now", function now() { return 1000; });
  define(Math, "random", function random() { return 0.5; });
  define(Crypto.prototype, "getRandomValues", function getRandomValues(a) {
    new Uint8Array(a.buffer, a.byteOffset, a.byteLength).fill(7);
    return a;
  });
  define(Crypto.prototype, "randomUUID", function randomUUID() {
    return "07070707-0707-4707-8707-070707070707";
  });
})();`;

/** A free loopback port, for the two sessions' one origin. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

/** The forms of `s` a page or a recorder may write it in (§5.2.1). */
export function encodedForms(s: string): string[] {
  return [
    ...new Set([
      s,
      encodeURIComponent(s),
      new URLSearchParams({ v: s }).toString().slice(2),
      JSON.stringify(s).slice(1, -1),
    ]),
  ];
}

/** Whether any form of `s` occurs in any of `bodies`. */
export function occursIn(bodies: readonly Uint8Array[], s: string): boolean {
  const needles = encodedForms(s).map((f) => Buffer.from(f, "utf8"));
  return bodies.some((b) => {
    const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
    return needles.some((n) => buf.includes(n));
  });
}

/** A record's canonical JSON with `Declassify.output` left out. */
function comparable(r: BoundaryRecord): string {
  const j = recordToJson(r) as Record<string, unknown>;
  if (r.record === "Declassify") delete j.output;
  return JSON.stringify(j);
}

/** Record one session of `fixture` typing `secret`. */
async function recordSession(
  browser: Browser,
  build: string,
  fixture: Fixture,
  level: ProtocolLevel,
  probeSource: string,
  ms: number,
  port: number,
  secret: string,
): Promise<Session> {
  const recording = await recordPage(
    browser,
    build,
    fixture,
    level,
    false,
    probeSource,
    ms,
    { secret, initScript: PIN_SCRIPT, port, keyboardOnly: true },
  );
  const session: Session = { secret, recording };
  if (recording.log === undefined) {
    session.decodeError = `no log was collected (${recording.collectError ?? "no reason given"})`;
    return session;
  }
  try {
    const log = decodeLog(recording.log, { inlineBodies: "batch" });
    session.records = log.records;
    if (log.termination !== "Complete") {
      session.decodeError = `the log ends ${log.termination}, not with End`;
    }
  } catch (e) {
    session.decodeError = `the log does not decode: ${(e as Error).message}`;
  }
  return session;
}

/** Replay one session's log with placeholders against the build. */
async function replaySessionLog(
  browser: Browser,
  build: string,
  dir: string,
  name: string,
  session: Session,
  ms: number,
): Promise<void> {
  if (session.records === undefined || session.decodeError !== undefined)
    return;
  const file = path.join(dir, `${name}.jsbound.log`);
  fs.writeFileSync(file, logBytes(session.records));
  session.replay = await replaySession({
    log: file,
    build,
    browser,
    timeoutMs: ms,
  });
}

function describeReplay(r: ReplayReport): string {
  if (r.status === "diverged" && r.divergence !== undefined) {
    const d = r.divergence;
    return `${d.kind} at seq ${d.seq} (cause ${d.cause}: ${d.detail})`;
  }
  if (r.status === "error") return `an error: ${r.error}`;
  return "a complete replay";
}

/** The checks of one fixture's pair, in report order. */
export function runNoninterferenceChecks(
  pair: FixturePair,
  level: ProtocolLevel,
): NoninterferenceCheckResult[] {
  const { a, b } = pair;
  const both = [a, b] as const;
  const usable = () => {
    const out: string[] = [];
    for (const [s, n] of [
      [a, "X"],
      [b, "Y"],
    ] as const) {
      if (s.recording.interactionProblems.length > 0) {
        out.push(
          `the session typing ${n} did not run: ${s.recording.interactionProblems.join("; ")}`,
        );
      }
      if (s.decodeError !== undefined) {
        out.push(`the session typing ${n}: ${s.decodeError}`);
      }
    }
    return out;
  };
  const replayCheck = (s: Session, n: string): string[] => {
    const problems = usable();
    if (problems.length > 0) return problems;
    const r = s.replay;
    if (r === undefined) return [`the session typing ${n} was not replayed`];
    if (r.status !== "replayed") {
      return [
        `replaying the session typing ${n} ended in ${describeReplay(r)}`,
      ];
    }
    const logged = s.records!.filter((x) => x.record === "Checkpoint").length;
    if (logged === 0) return [`the session typing ${n} has no Checkpoint`];
    if (r.checkpoints !== logged) {
      return [`${r.checkpoints} of ${logged} checkpoint(s) were compared`];
    }
    return [];
  };
  const checks: Record<NoninterferenceCheckName, () => string[]> = {
    recordings: usable,
    declaration() {
      const problems: string[] = [];
      for (const s of both) {
        const caps = s.recording.declaration?.capabilities;
        if (!Array.isArray(caps) || !caps.includes(SENSITIVE_CAPABILITY)) {
          problems.push(
            `the framework does not declare the ${JSON.stringify(SENSITIVE_CAPABILITY)} capability (§9.2)`,
          );
        }
        const header = s.records?.[0];
        if (
          header?.record !== "Header" ||
          !header.capabilities.includes(`"${SENSITIVE_CAPABILITY}"`)
        ) {
          problems.push(
            `Header.capabilities does not carry ${JSON.stringify(SENSITIVE_CAPABILITY)}`,
          );
        }
      }
      return [...new Set(problems)];
    },
    vacuity() {
      const problems = usable();
      if (problems.length > 0) return problems;
      const ra = a.records!;
      const rb = b.records!;
      const outputsDiffer = ra.some((r, i) => {
        const o = rb[i];
        return (
          r.record === "Declassify" &&
          o?.record === "Declassify" &&
          r.output !== o.output
        );
      });
      if (!outputsDiffer) {
        problems.push(
          "no Declassify.output differs between the two sessions: the secrets do not exercise a declassifier, so the comparison would prove nothing",
        );
      }
      const bytesA = Buffer.concat(
        (a.recording.batches ?? []).map((x) => Buffer.from(x)),
      );
      const bytesB = Buffer.concat(
        (b.recording.batches ?? []).map((x) => Buffer.from(x)),
      );
      if (bytesA.equals(bytesB)) {
        problems.push("the two sessions' batches are byte-identical");
      }
      for (const [s, n] of [
        [a, "X"],
        [b, "Y"],
      ] as const) {
        if (!occursIn(s.recording.batches ?? [], PUBLIC_PROBE)) {
          problems.push(
            `the public probe ${JSON.stringify(PUBLIC_PROBE)} typed into ${pair.fixture.sensitive!.publicField} is not in the batches of the session typing ${n}: the scan does not read what the recorder uploads`,
          );
        }
      }
      return problems;
    },
    "differs-only-in-declassify"() {
      const problems = usable();
      if (problems.length > 0) return problems;
      const d = firstDifference(a.records!, b.records!);
      if (d === undefined) return [];
      // Each pair's first difference, every one recorded: a difference that
      // depends on the secret is in each.
      return [
        d,
        ...pair.discarded.map(
          (x, i) => `(pair ${i + 1} of ${pair.discarded.length + 1}) ${x}`,
        ),
      ];
    },
    "no-secret-in-batches"() {
      const problems: string[] = [];
      // The earlier pairs' sessions uploaded too: their batches are scanned.
      for (const s of [...both, ...pair.earlier]) {
        const bodies = s.recording.batches ?? [];
        if (bodies.length === 0) {
          problems.push("a session uploaded no batch to scan");
          continue;
        }
        for (const secret of [a.secret, b.secret]) {
          if (occursIn(bodies, secret)) {
            problems.push(
              `a secret occurs in the batches of the session typing ${s === a ? "X" : "Y"}`,
            );
          }
        }
      }
      return [...new Set(problems)];
    },
    "replay-a": () => replayCheck(a, "X"),
    "replay-b": () => replayCheck(b, "Y"),
  };
  return NONINTERFERENCE_CHECKS.map((name) => {
    if (level === 0 && name === "declaration") {
      return {
        name,
        status: "not-applicable-at-level-0" as const,
        detail: [
          "the generic shim declares nothing; every free-text field is sensitive unless marked public (§11.3.1)",
        ],
      };
    }
    let detail: string[];
    try {
      detail = checks[name]();
    } catch (e) {
      detail = [`the check itself failed: ${String(e)}`];
    }
    return { name, status: detail.length === 0 ? "pass" : "fail", detail };
  });
}

/** The fixtures the leg runs: the named ones, or every sensitive one. */
export function noninterferenceFixtures(names?: string[]): Fixture[] {
  const fixtures =
    names === undefined
      ? FIXTURES.filter((f) => f.sensitive !== undefined)
      : names.map(fixtureNamed);
  for (const f of fixtures) {
    if (f.sensitive === undefined) {
      throw new Error(
        `the fixture ${JSON.stringify(f.name)} has no sensitive fields; the non-interference leg runs ${FIXTURES.filter(
          (x) => x.sensitive !== undefined,
        )
          .map((x) => x.name)
          .join(", ")}`,
      );
    }
  }
  return fixtures;
}

/** Run the non-interference leg on `options.build` and report. */
export async function runNoninterferenceLeg(
  options: NoninterferenceOptions,
): Promise<{ report: NoninterferenceReport; pairs: FixturePair[] }> {
  const build = path.resolve(options.build);
  if (!fs.existsSync(build) || !fs.statSync(build).isDirectory()) {
    throw new Error(`the build ${build} is not a directory`);
  }
  if (options.level !== 0 && options.level !== 1) {
    throw new Error(`the level is ${String(options.level)}; it is 0 or 1`);
  }
  const secretA = options.secretA ?? DEFAULT_SECRETS[0];
  const secretB = options.secretB ?? DEFAULT_SECRETS[1];
  const problem = secretsProblem(secretA, secretB);
  if (problem !== undefined) throw new Error(problem);
  const fixtures = noninterferenceFixtures(options.fixtures);
  const { buildHash } = buildBundleManifest(build);
  const probeSource = fs.readFileSync(PROBE_PATH, "utf-8");
  const ms = options.timeoutMs ?? 15000;
  const browser = options.browser ?? (await launchReplayBrowser());
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "ct-conformance-ni-"));
  const pairs: FixturePair[] = new Array(fixtures.length);
  try {
    let next = 0;
    const worker = async () => {
      while (next < fixtures.length) {
        const i = next++;
        const fixture = fixtures[i];
        const port = await freePort();
        const discarded: string[] = [];
        const earlier: Session[] = [];
        let a: Session;
        let b: Session;
        for (let attempt = 1; ; attempt++) {
          // One after the other, at one origin: the two sessions' URLs
          // are the same, and the server answers them alike.
          a = await recordSession(
            browser,
            build,
            fixture,
            options.level,
            probeSource,
            ms,
            port,
            secretA,
          );
          b = await recordSession(
            browser,
            build,
            fixture,
            options.level,
            probeSource,
            ms,
            port,
            secretB,
          );
          if (
            attempt >= MAX_ATTEMPTS ||
            a.records === undefined ||
            b.records === undefined ||
            a.decodeError !== undefined ||
            b.decodeError !== undefined
          ) {
            break;
          }
          const d = firstDifference(a.records, b.records);
          if (d === undefined) break;
          discarded.push(d);
          earlier.push(a, b);
        }
        const dir = fs.mkdtempSync(path.join(work, `${fixture.name}-`));
        await replaySessionLog(browser, build, dir, "a", a, ms);
        await replaySessionLog(browser, build, dir, "b", b, ms);
        pairs[i] = { fixture, a, b, discarded, earlier };
      }
    };
    await Promise.all(
      Array.from(
        {
          length: Math.max(
            1,
            Math.min(options.concurrency ?? 2, fixtures.length),
          ),
        },
        worker,
      ),
    );
  } finally {
    if (options.browser === undefined) await browser.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
  const reports = pairs.map((p) => ({
    name: p.fixture.name,
    title: p.fixture.title,
    attempts: p.discarded.length + 1,
    discarded: p.discarded,
    checks: runNoninterferenceChecks(p, options.level),
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
      leg: "noninterference",
      level: options.level,
      build,
      buildHash,
      fixtures: reports,
      summary,
      passed: summary.fail === 0,
    },
    pairs,
  };
}

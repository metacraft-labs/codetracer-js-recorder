/**
 * The replay leg of the conformance suite (CodeTracer's
 * JS-Boundary-Recording specification §9.9): record every fixture as the
 * record leg does, replay each recording with CodeTracer's replay runner
 * (`@codetracer/boundary-replay`) against the same build, and check:
 *
 * | check        | levels | passes when |
 * |--------------|--------|-------------|
 * | `replay`     | 0, 1   | the recording replays to its `End` with no divergence, and every `Checkpoint` of the log was compared and matched (at least one) |
 * | `inject`     | 1      | every input task's `Input` was injected through `__ctBoundaryProtocol.replay.inject`, and no DOM event of the input's type reached the window while `inject` ran: the framework called the registered handler directly (§9.5) |
 * | `divergence` | 0, 1   | three seeded edits of the recording each replay to the divergence kind the edit must cause, at the edit's `seq`: the first checkpoint's hash altered (`CheckpointMismatch`), a `Refusal` before the first task (`NonReplayable`), the first boundary read removed (`ExtraRead`) |
 *
 * Nothing here is a mock: the recordings are real, made by the build in
 * headless Chromium, and replayed by the shipped runner in headless
 * Chromium.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { type BoundaryRecord, decodeLog } from "@codetracer/boundary-format";
import {
  logBytes,
  isPageRead,
  launchReplayBrowser,
  replaySession,
  type ReplayReport,
  seqAt,
  withoutRecord,
  withRecordBefore,
  withRecordReplaced,
} from "@codetracer/boundary-replay";

import type { FixtureRun } from "./checks.js";
import {
  type RecordLegOptions,
  runRecordLeg,
  SUITE_VERSION,
} from "./harness.js";
import {
  type CheckStatus,
  PROTOCOL_VERSION,
  type ProtocolLevel,
  REPLAY_CHECKS,
  REPLAY_LEVEL_1_ONLY,
  type ReplayCheckName,
} from "./protocol.js";

export type ReplayLegOptions = RecordLegOptions;

export interface ReplayCheckResult {
  name: ReplayCheckName;
  status: CheckStatus;
  detail: string[];
}

export interface ReplayFixtureReport {
  name: string;
  title: string;
  checks: ReplayCheckResult[];
}

export interface ReplayLegReport {
  suite: "@codetracer/boundary-conformance";
  suiteVersion: string;
  protocol: number;
  leg: "replay";
  level: ProtocolLevel;
  build: string;
  buildHash: string;
  fixtures: ReplayFixtureReport[];
  summary: { pass: number; fail: number; notApplicable: number };
  passed: boolean;
}

/** One seeded edit of a recording and the divergence it must cause. */
export interface SeededFault {
  name: "checkpoint" | "refusal" | "extra-read";
  records: BoundaryRecord[];
  kind: string;
  seq: string;
}

/** What one fixture's replays found. */
export interface FixtureReplay {
  run: FixtureRun;
  /** Why the recording could not be replayed at all, if it could not. */
  unusable?: string;
  records?: BoundaryRecord[];
  clean?: ReplayReport;
  faults: { fault: SeededFault; report: ReplayReport }[];
  /** Why no seeded fault could be made, if none could. */
  faultProblems: string[];
}

/**
 * The seeded edits of `records` (see the module comment), or the reasons a
 * recording offers none of them.
 */
export function seededFaults(records: BoundaryRecord[]): {
  faults: SeededFault[];
  problems: string[];
} {
  const faults: SeededFault[] = [];
  const problems: string[] = [];
  const cp = records.findIndex((r) => r.record === "Checkpoint");
  if (cp < 0) {
    problems.push("the recording has no Checkpoint to alter");
  } else {
    const c = records[cp] as Extract<BoundaryRecord, { record: "Checkpoint" }>;
    const flipped =
      (c.state_hash[0] === "0" ? "1" : "0") + c.state_hash.slice(1);
    faults.push({
      name: "checkpoint",
      records: withRecordReplaced(records, cp, { ...c, state_hash: flipped }),
      kind: "CheckpointMismatch",
      seq: seqAt(records, cp),
    });
  }
  const task = records.findIndex((r) => r.record === "Task");
  if (task < 0) {
    problems.push("the recording has no Task to put a Refusal before");
  } else {
    faults.push({
      name: "refusal",
      records: withRecordBefore(records, task, {
        record: "Refusal",
        seq: 0n,
        feature: "conformance-seeded-refusal",
        detail: "inserted by the conformance suite's replay leg",
      }),
      kind: "NonReplayable",
      seq: seqAt(records, task),
    });
  }
  const read = records.findIndex(
    (r, i) =>
      isPageRead(r) &&
      records[i + 1] !== undefined &&
      records[i + 1].record !== r.record,
  );
  if (read < 0) {
    problems.push("the recording has no boundary read to remove");
  } else {
    faults.push({
      name: "extra-read",
      records: withoutRecord(records, read),
      kind: "ExtraRead",
      seq: seqAt(records, read),
    });
  }
  return { faults, problems };
}

/** Replay one fixture's recording, clean and with each seeded fault. */
async function replayFixture(
  run: FixtureRun,
  build: string,
  work: string,
  options: ReplayLegOptions,
  browser: NonNullable<ReplayLegOptions["browser"]>,
): Promise<FixtureReplay> {
  const out: FixtureReplay = { run, faults: [], faultProblems: [] };
  const log = run.recording.log;
  if (log === undefined) {
    out.unusable = `the record leg collected no log (${run.recording.collectError ?? "no reason given"})`;
    return out;
  }
  let records: BoundaryRecord[];
  try {
    records = decodeLog(log, { inlineBodies: "batch" }).records;
  } catch (e) {
    out.unusable = `the recording does not decode: ${(e as Error).message}`;
    return out;
  }
  out.records = records;
  const dir = fs.mkdtempSync(path.join(work, `${run.fixture.name}-`));
  const replay = async (name: string, rs: BoundaryRecord[]) => {
    const file = path.join(dir, `${name}.jsbound.log`);
    fs.writeFileSync(file, logBytes(rs));
    return replaySession({
      log: file,
      build,
      browser,
      timeoutMs: options.timeoutMs ?? 15000,
    });
  };
  out.clean = await replay("clean", records);
  const { faults, problems } = seededFaults(records);
  out.faultProblems = problems;
  for (const fault of faults) {
    out.faults.push({ fault, report: await replay(fault.name, fault.records) });
  }
  return out;
}

function describeOutcome(r: ReplayReport): string {
  if (r.status === "diverged" && r.divergence !== undefined) {
    return `${r.divergence.kind} at seq ${r.divergence.seq} (${r.divergence.detail})`;
  }
  if (r.status === "error") return `an error: ${r.error}`;
  return "a complete replay";
}

/** The replay leg's checks of one fixture, in report order. */
export function runReplayChecks(
  f: FixtureReplay,
  level: ProtocolLevel,
): ReplayCheckResult[] {
  const checks: Record<ReplayCheckName, () => string[]> = {
    replay() {
      if (f.unusable !== undefined) return [f.unusable];
      const r = f.clean!;
      const problems: string[] = [];
      if (r.status !== "replayed")
        problems.push(`the replay ended in ${describeOutcome(r)}`);
      const logged = f.records!.filter((x) => x.record === "Checkpoint").length;
      if (logged === 0)
        problems.push("the recording has no Checkpoint to compare");
      if (r.status === "replayed" && r.checkpoints !== logged) {
        problems.push(
          `${r.checkpoints} of ${logged} checkpoint(s) were compared`,
        );
      }
      return problems;
    },
    inject() {
      if (f.unusable !== undefined) return [f.unusable];
      const r = f.clean!;
      const problems: string[] = [];
      if (r.status !== "replayed")
        problems.push(`the replay ended in ${describeOutcome(r)}`);
      const inputTasks = f.records!.filter(
        (x) => x.record === "Task" && x.kind === 5,
      ).length;
      if (r.status === "replayed" && r.injections !== inputTasks) {
        problems.push(
          `${r.injections} of ${inputTasks} input task(s) were injected`,
        );
      }
      if (r.dispatchedDuringInject.length > 0) {
        problems.push(
          `inject dispatched DOM events instead of calling the registered handler: ${r.dispatchedDuringInject.join(", ")}`,
        );
      }
      return problems;
    },
    divergence() {
      if (f.unusable !== undefined) return [f.unusable];
      const problems = f.faultProblems.slice();
      for (const { fault, report } of f.faults) {
        const d = report.divergence;
        if (
          report.status !== "diverged" ||
          d?.kind !== fault.kind ||
          d.seq !== fault.seq
        ) {
          problems.push(
            `${fault.name}: expected ${fault.kind} at seq ${fault.seq}, got ${describeOutcome(report)}`,
          );
        }
      }
      return problems;
    },
  };
  return REPLAY_CHECKS.map((name) => {
    if (level === 0 && REPLAY_LEVEL_1_ONLY.has(name)) {
      return {
        name,
        status: "not-applicable-at-level-0" as const,
        detail: [
          "the generic shim injects synthetic events (§10.3); replay covers it",
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

/** Run the replay leg on `options.build` and report. */
export async function runReplayLeg(options: ReplayLegOptions): Promise<{
  report: ReplayLegReport;
  replays: FixtureReplay[];
}> {
  const build = path.resolve(options.build);
  // The replay browser (WebRTC kept to the context's proxy, §7.4); the
  // record leg runs in it too, and no fixture uses WebRTC.
  const browser = options.browser ?? (await launchReplayBrowser());
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "ct-conformance-replay-"));
  try {
    const recorded = await runRecordLeg({ ...options, browser });
    const replays: FixtureReplay[] = [];
    const runs = recorded.runs;
    let next = 0;
    const worker = async () => {
      while (next < runs.length) {
        const i = next++;
        replays[i] = await replayFixture(
          runs[i],
          build,
          work,
          options,
          browser,
        );
      }
    };
    await Promise.all(
      Array.from(
        {
          length: Math.max(1, Math.min(options.concurrency ?? 4, runs.length)),
        },
        worker,
      ),
    );
    const fixtures = replays.map((f) => ({
      name: f.run.fixture.name,
      title: f.run.fixture.title,
      checks: runReplayChecks(f, options.level),
    }));
    const all = fixtures.flatMap((f) => f.checks);
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
        leg: "replay",
        level: options.level,
        build,
        buildHash: recorded.report.buildHash,
        fixtures,
        summary,
        passed: summary.fail === 0,
      },
      replays,
    };
  } finally {
    if (options.browser === undefined) await browser.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
}

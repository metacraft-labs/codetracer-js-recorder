#!/usr/bin/env node
/**
 * `ct-boundary-conformance`: the cooperation protocol's conformance suite
 * on the command line (CodeTracer's JS-Boundary-Recording specification
 * §9.9).
 *
 * ```text
 * ct-boundary-conformance record --build <dir> --level <0|1>
 *                                [--fixture <name>]... [--out <report.json>]
 *                                [--concurrency <n>] [--timeout-ms <n>]
 * ct-boundary-conformance replay --build <dir> --level <0|1>
 *                                [--fixture <name>]... [--out <report.json>]
 *                                [--concurrency <n>] [--timeout-ms <n>]
 * ct-boundary-conformance noninterference --build <dir> --level <0|1>
 *                                [--fixture <name>]... [--secret-a <X> --secret-b <Y>]
 *                                [--out <report.json>] [--concurrency <n>] [--timeout-ms <n>]
 * ct-boundary-conformance fixtures
 * ```
 *
 * `record` runs the record leg and writes its JSON report to `--out` (or to
 * stdout), with a one-line verdict per failed check on stderr. Exit status:
 * 0 when every check passed or is not applicable, 1 when one failed, 2 for
 * a usage error or a harness that could not run (no browser, no build).
 * `replay` records every fixture the same way, replays each recording with
 * CodeTracer's replay runner, and reports the replay leg's checks
 * (`replay-leg.ts`), with the same output and exit status.
 * `noninterference` records every fixture with sensitive fields twice, with
 * the two secrets, and checks that the two logs differ only in the
 * declassifiers' outputs, that neither secret reaches a batch, and that each
 * log replays with placeholders (`noninterference.ts`, §11.3.6); the same
 * output and exit status.
 * `fixtures` prints every fixture's contract as JSON, for a framework
 * writing its own build of them.
 */

import * as fs from "node:fs";

import { FIXTURES } from "./fixtures.js";
import { runRecordLeg, SUITE_VERSION } from "./harness.js";
import { runReplayLeg } from "./replay-leg.js";
import {
  noninterferenceFixtures,
  runNoninterferenceLeg,
  secretsProblem,
} from "./noninterference.js";
import { DEFAULT_SECRETS } from "./fixtures.js";
import type { ProtocolLevel } from "./protocol.js";

const USAGE = `usage: ct-boundary-conformance record --build <dir> --level <0|1> [--fixture <name>]... [--out <report.json>] [--concurrency <n>] [--timeout-ms <n>]
       ct-boundary-conformance replay --build <dir> --level <0|1> [--fixture <name>]... [--out <report.json>] [--concurrency <n>] [--timeout-ms <n>]
       ct-boundary-conformance noninterference --build <dir> --level <0|1> [--fixture <name>]... [--secret-a <X> --secret-b <Y>] [--out <report.json>] [--concurrency <n>] [--timeout-ms <n>]
       ct-boundary-conformance fixtures
       ct-boundary-conformance --version`;

class UsageError extends Error {}

interface RecordArgs {
  build: string;
  level: ProtocolLevel;
  fixtures?: string[];
  out?: string;
  concurrency?: number;
  timeoutMs?: number;
  secretA?: string;
  secretB?: string;
}

function positiveInt(flag: string, v: string): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 1)
    throw new UsageError(
      `${flag} ${JSON.stringify(v)} is not a positive integer`,
    );
  return n;
}

function parseRecordArgs(argv: string[], secrets = false): RecordArgs {
  let build: string | undefined;
  let level: ProtocolLevel | undefined;
  const fixtures: string[] = [];
  const args: Partial<RecordArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case "--build":
        build = value();
        break;
      case "--level": {
        const v = value();
        if (v !== "0" && v !== "1")
          throw new UsageError(`--level ${JSON.stringify(v)} is not 0 or 1`);
        level = Number(v) as ProtocolLevel;
        break;
      }
      case "--fixture":
        fixtures.push(value());
        break;
      case "--out":
        args.out = value();
        break;
      case "--concurrency":
        args.concurrency = positiveInt(flag, value());
        break;
      case "--timeout-ms":
        args.timeoutMs = positiveInt(flag, value());
        break;
      case "--secret-a":
      case "--secret-b":
        if (!secrets) throw new UsageError(`${flag} is for noninterference`);
        if (flag === "--secret-a") args.secretA = value();
        else args.secretB = value();
        break;
      default:
        throw new UsageError(`unknown argument ${JSON.stringify(flag)}`);
    }
  }
  if (build === undefined) throw new UsageError("--build is required");
  if (level === undefined) throw new UsageError("--level is required");
  const known = new Set(FIXTURES.map((f) => f.name));
  for (const f of fixtures) {
    if (!known.has(f))
      throw new UsageError(`no fixture named ${JSON.stringify(f)}`);
  }
  if ((args.secretA === undefined) !== (args.secretB === undefined)) {
    throw new UsageError("--secret-a and --secret-b go together");
  }
  if (args.secretA !== undefined) {
    const problem = secretsProblem(args.secretA, args.secretB!);
    if (problem !== undefined) throw new UsageError(problem);
  } else if (secrets) {
    args.secretA = DEFAULT_SECRETS[0];
    args.secretB = DEFAULT_SECRETS[1];
  }
  if (secrets) {
    try {
      noninterferenceFixtures(fixtures.length > 0 ? fixtures : undefined);
    } catch (e) {
      throw new UsageError((e as Error).message);
    }
  }
  return {
    ...args,
    build,
    level,
    fixtures: fixtures.length > 0 ? fixtures : undefined,
  };
}

/** Run the CLI on `argv` (without the node and script paths); the exit status. */
export async function main(argv: string[]): Promise<number> {
  try {
    const [command, ...rest] = argv;
    if (command === "--version") {
      process.stdout.write(`${SUITE_VERSION}\n`);
      return 0;
    }
    if (command === "--help" || command === "-h") {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }
    if (command === "fixtures") {
      if (rest.length > 0) throw new UsageError("fixtures takes no arguments");
      process.stdout.write(`${JSON.stringify(FIXTURES, null, 2)}\n`);
      return 0;
    }
    if (
      command !== "record" &&
      command !== "replay" &&
      command !== "noninterference"
    )
      throw new UsageError(
        command === undefined
          ? "no command"
          : `unknown command ${JSON.stringify(command)}`,
      );
    const args = parseRecordArgs(rest, command === "noninterference");
    const { report } =
      command === "record"
        ? await runRecordLeg(args)
        : command === "replay"
          ? await runReplayLeg(args)
          : await runNoninterferenceLeg(args);
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (args.out !== undefined) fs.writeFileSync(args.out, json);
    else process.stdout.write(json);
    for (const f of report.fixtures) {
      for (const c of f.checks) {
        if (c.status === "fail")
          process.stderr.write(
            `FAIL ${f.name} ${c.name}: ${c.detail.join("; ")}\n`,
          );
      }
    }
    const { pass, fail, notApplicable } = report.summary;
    process.stderr.write(
      `${report.leg} leg, level ${report.level}: ${pass} passed, ${fail} failed, ${notApplicable} not applicable at level 0\n`,
    );
    return report.passed ? 0 : 1;
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`ct-boundary-conformance: ${e.message}\n${USAGE}\n`);
      return 2;
    }
    process.stderr.write(`ct-boundary-conformance: ${(e as Error).message}\n`);
    return 2;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      process.stderr.write(`ct-boundary-conformance: ${String(e)}\n`);
      process.exitCode = 2;
    },
  );
}

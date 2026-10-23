#!/usr/bin/env node
/**
 * `ct-boundary-replay`: replay a recorded browser boundary log against the
 * build it ran (CodeTracer's JS-Boundary-Recording specification §7, §12).
 *
 * ```text
 * ct-boundary-replay --log <recording.ct|jsbound.log> --build <dir>
 *                    [--out <trace.ct>] [--session-manager <bin>]
 *                    [--report <report.json>] [--timeout-ms <n>]
 * ```
 *
 * Writes the JSON report to `--report` (or stdout) and one line naming the
 * divergence to stderr. With `--out` the materialised JavaScript trace is
 * written there, and only when the replay reached the log's end: a
 * divergence writes no trace. Exit status: 0 replayed, 1 diverged, 2 a usage
 * error or a replay that could not run.
 */

import * as fs from "node:fs";

import { replaySession, type ReplayOptions } from "./runner.js";

const USAGE = `usage: ct-boundary-replay --log <recording.ct|jsbound.log> --build <dir> [--out <trace.ct>] [--session-manager <bin>] [--report <report.json>] [--timeout-ms <n>]`;

class UsageError extends Error {}

function parse(argv: string[]): ReplayOptions & { report?: string } {
  const o: Partial<ReplayOptions & { report?: string }> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case "--log":
        o.log = value();
        break;
      case "--build":
        o.build = value();
        break;
      case "--out":
        o.out = value();
        break;
      case "--session-manager":
        o.sessionManager = value();
        break;
      case "--report":
        o.report = value();
        break;
      case "--timeout-ms": {
        const v = value();
        const n = Number(v);
        if (!Number.isSafeInteger(n) || n < 1) {
          throw new UsageError(
            `--timeout-ms ${JSON.stringify(v)} is not a positive integer`,
          );
        }
        o.timeoutMs = n;
        break;
      }
      default:
        throw new UsageError(`unknown argument ${JSON.stringify(flag)}`);
    }
  }
  if (o.log === undefined) throw new UsageError("--log is required");
  if (o.build === undefined) throw new UsageError("--build is required");
  return o as ReplayOptions & { report?: string };
}

async function main(argv: string[]): Promise<number> {
  let options: ReplayOptions & { report?: string };
  try {
    options = parse(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`${e.message}\n${USAGE}\n`);
      return 2;
    }
    throw e;
  }
  const report = await replaySession(options);
  const json = JSON.stringify(report, null, 2) + "\n";
  if (options.report !== undefined) fs.writeFileSync(options.report, json);
  else process.stdout.write(json);
  if (report.status === "diverged" && report.divergence !== undefined) {
    const d = report.divergence;
    process.stderr.write(`divergence ${d.kind} at seq ${d.seq}: ${d.detail}\n`);
    return 1;
  }
  if (report.status === "error") {
    process.stderr.write(`the replay could not run: ${report.error}\n`);
    return 2;
  }
  if (report.metadata.uaMajorMismatch) {
    process.stderr.write(
      `note: recorded on Chromium ${report.metadata.recordedUaMajor}, replayed on ${report.metadata.replayUaMajor}\n`,
    );
  }
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stderr.write(
      `the replay could not run: ${(e as Error).message ?? String(e)}\n`,
    );
    process.exit(2);
  },
);

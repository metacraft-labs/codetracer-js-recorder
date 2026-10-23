/**
 * The record leg of the cooperation protocol's conformance suite
 * (`@codetracer/boundary-conformance`, CodeTracer's JS-Boundary-Recording
 * specification §9.9): the harness passes the test-only reference
 * micro-framework at level 1 and the generic shim at level 0, rejects four
 * seeded broken frameworks each for exactly its defect, and its envelope
 * check rejects malformed batch sequences.
 *
 * No mocks. Every recording is made by real headless Chromium (from the dev
 * shell, PLAYWRIGHT_CORE_PATH) against the harness's real HTTP server and
 * the suite's real builds: the generic build with the shim installed by the
 * shipped deploy route (`codetracer-js-recorder bundle-manifest`, then
 * `boundary-shim --build-hash`), and the reference framework's build, which
 * is the suite's own test-only level-1 implementation rather than a stand-in
 * for one. Two tests drive the shipped `ct-boundary-conformance` command as
 * a child process; the others call the same harness as a library, sharing
 * one browser, so they can read what it collected. The envelope test edits
 * batches the reference framework really uploaded.
 */

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type BatchEnvelope,
  decodeLog,
  encodeBatch,
  parseBatch,
} from "../../packages/boundary-format/src/index.js";
import {
  type Browser,
  type RecordLegReport,
  type ReferenceDefects,
  buildGenericFixtures,
  buildReferenceFixtures,
  checkBatches,
  FIXTURES,
  LEVEL_1_ONLY,
  loadPlaywright,
  RECORD_CHECKS,
  runRecordLeg,
} from "../../packages/boundary-conformance/src/index.js";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const RECORDER_CLI = path.join(REPO_ROOT, "packages/cli/dist/index.js");
const CONFORMANCE_CLI = path.join(
  REPO_ROOT,
  "packages/boundary-conformance/dist/cli.js",
);
const TIMEOUT = 240_000;

let browser: Browser;
const tmpDirs: string[] = [];

function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

beforeAll(async () => {
  browser = await loadPlaywright().chromium.launch({ headless: true });
}, TIMEOUT);

afterAll(async () => {
  await browser?.close();
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

/** Run the shipped `ct-boundary-conformance record`; its status and report. */
function runCli(
  build: string,
  level: 0 | 1,
): { status: number | null; report: RecordLegReport; stderr: string } {
  const out = path.join(tmp("ct-conformance-report-"), "report.json");
  const r = spawnSync(
    process.execPath,
    [
      CONFORMANCE_CLI,
      "record",
      "--build",
      build,
      "--level",
      String(level),
      "--out",
      out,
    ],
    { encoding: "utf-8", timeout: TIMEOUT },
  );
  if (!fs.existsSync(out)) {
    throw new Error(
      `the CLI wrote no report (status ${r.status}): ${r.stderr}`,
    );
  }
  return {
    status: r.status,
    report: JSON.parse(fs.readFileSync(out, "utf-8")) as RecordLegReport,
    stderr: r.stderr,
  };
}

/** `fixture check status` for every check of a report. */
function verdicts(report: RecordLegReport): string[] {
  return report.fixtures.flatMap((f) =>
    f.checks.map((c) => `${f.name} ${c.name} ${c.status}`),
  );
}

/** The `fixture check` pairs that failed, with their details. */
function failures(report: RecordLegReport): string[] {
  return report.fixtures.flatMap((f) =>
    f.checks
      .filter((c) => c.status === "fail")
      .map((c) => `${f.name} ${c.name}: ${c.detail.join("; ")}`),
  );
}

/** The generic build with the shim installed by the shipped deploy route. */
async function genericShimBuild(): Promise<string> {
  const site = path.join(tmp("ct-conformance-generic-"), "site");
  await buildGenericFixtures(site);
  const hash = execFileSync(
    process.execPath,
    [RECORDER_CLI, "bundle-manifest", site],
    { encoding: "utf-8" },
  ).trim();
  execFileSync(
    process.execPath,
    [RECORDER_CLI, "boundary-shim", site, "--build-hash", hash],
    { stdio: "pipe" },
  );
  return site;
}

async function referenceBuild(defects: ReferenceDefects = {}): Promise<string> {
  const site = path.join(tmp("ct-conformance-reference-"), "site");
  await buildReferenceFixtures(site, defects);
  return site;
}

describe("the conformance suite's record leg", () => {
  it(
    "conformance_record_leg_passes_reference_framework",
    async () => {
      expect(FIXTURES.length).toBeGreaterThanOrEqual(8);
      const { status, report, stderr } = runCli(await referenceBuild(), 1);
      expect(failures(report)).toEqual([]);
      expect(status, stderr).toBe(0);
      expect(report.level).toBe(1);
      expect(report.fixtures.map((f) => f.name)).toEqual(
        FIXTURES.map((f) => f.name),
      );
      // Every check of every fixture ran and passed: none is skipped at
      // level 1.
      const expected = FIXTURES.flatMap((f) =>
        RECORD_CHECKS.map((c) => `${f.name} ${c} pass`),
      );
      expect(verdicts(report)).toEqual(expected);
    },
    TIMEOUT,
  );

  it(
    "conformance_record_leg_passes_generic_shim_at_level_0",
    async () => {
      const { status, report, stderr } = runCli(await genericShimBuild(), 0);
      expect(failures(report)).toEqual([]);
      expect(status, stderr).toBe(0);
      expect(report.fixtures.map((f) => f.name)).toEqual(
        FIXTURES.map((f) => f.name),
      );
      for (const f of report.fixtures) {
        const applicable = f.checks.filter(
          (c) => c.status !== "not-applicable-at-level-0",
        );
        // Vacuity guard: the level-0 run is a run of at least five checks
        // per fixture, not a report of skips.
        expect(applicable.length, f.name).toBeGreaterThanOrEqual(5);
        for (const c of f.checks) {
          // A level-1-only check is never reported as passing at level 0,
          // and every other check is applicable and passes.
          expect(`${f.name} ${c.name} ${c.status}`).toBe(
            `${f.name} ${c.name} ${
              LEVEL_1_ONLY.has(c.name) ? "not-applicable-at-level-0" : "pass"
            }`,
          );
        }
      }
    },
    TIMEOUT,
  );

  it(
    "conformance_record_leg_rejects_broken_frameworks",
    async () => {
      // Each seeded defect, the check it must fail, and the fixtures it
      // reaches (the unwrapped handler is the counter's alone).
      const variants: {
        defects: ReferenceDefects;
        check: string;
        fixtures: string[];
      }[] = [
        {
          defects: { unwrappedHandler: "counter/inc" },
          check: "inputs",
          fixtures: ["counter"],
        },
        {
          defects: { positionalIds: true },
          check: "targets",
          fixtures: FIXTURES.map((f) => f.name),
        },
        {
          defects: { noCheckpoints: true },
          check: "checkpoints",
          fixtures: FIXTURES.map((f) => f.name),
        },
        {
          defects: { omitCapability: "inject" },
          check: "declaration",
          fixtures: FIXTURES.map((f) => f.name),
        },
      ];
      const builds = await Promise.all([
        referenceBuild(),
        ...variants.map((v) => referenceBuild(v.defects)),
      ]);
      const [control, ...broken] = await Promise.all(
        builds.map((build) =>
          runRecordLeg({ build, level: 1, browser, concurrency: 2 }),
        ),
      );
      // Negative control: the unmodified framework, in the same run, passes
      // the four checks the variants fail, so each failure below is the
      // seeded defect's.
      expect(failures(control.report)).toEqual([]);
      const named = new Set(variants.map((v) => v.check));
      for (const f of control.report.fixtures) {
        for (const c of f.checks.filter((c) => named.has(c.name))) {
          expect(`${f.name} ${c.name} ${c.status}`).toBe(
            `${f.name} ${c.name} pass`,
          );
        }
      }
      variants.forEach((v, i) => {
        const failed = broken[i].report.fixtures.flatMap((f) =>
          f.checks
            .filter((c) => c.status === "fail")
            .map((c) => `${f.name} ${c.name}`),
        );
        expect(failed, JSON.stringify(v.defects)).toEqual(
          v.fixtures.map((f) => `${f} ${v.check}`),
        );
      });
    },
    TIMEOUT,
  );

  it(
    "conformance_envelope_check_rejects_bad_batches",
    async () => {
      // Batches the reference framework really uploaded for one session.
      const { runs } = await runRecordLeg({
        build: await referenceBuild(),
        level: 1,
        fixtures: ["password-form"],
        browser,
      });
      const bodies = runs[0].recording.batches ?? [];
      // Vacuity guard: enough batches that the one after the first can be
      // removed with another after it, and two swapped after the first.
      expect(bodies.length).toBeGreaterThanOrEqual(3);
      const parsed = bodies.map(parseBatch);

      // Negative control: the batches as uploaded pass, and their joined
      // log decodes strictly.
      const clean = checkBatches(bodies);
      expect(clean.problems).toEqual([]);
      expect(decodeLog(clean.log!).termination).toBe("Complete");

      const reencode = (i: number, change: Partial<BatchEnvelope>) =>
        encodeBatch({ ...parsed[i].envelope, ...change }, parsed[i].frames);
      // Re-encoding an unchanged envelope gives the uploaded bytes, so the
      // edits below change only what they name.
      expect(reencode(1, {})).toEqual(bodies[1]);

      // A wrong magic.
      const badMagic = bodies.map((b) => b.slice());
      badMagic[1][0] = 0x58;
      expect(checkBatches(badMagic).problems.join("\n")).toMatch(
        /batch #1 \(in arrival order\) is refused: BadMagic/,
      );

      // A batch_seq that goes backwards: batches 1 and 2 arrive swapped.
      const swapped = [bodies[0], bodies[2], bodies[1], ...bodies.slice(3)];
      expect(checkBatches(swapped).problems.join("\n")).toMatch(
        /batch_seq goes backwards: arrival #2 carries batch_seq 1 after 2/,
      );

      // first_seq not following the previous last_seq: batch 1 is gone and
      // the rest renumbered, so batch_seq is continuous and seq is not.
      const lost = parsed[1].envelope;
      const renumbered = (dropped: [number, number][]) => [
        bodies[0],
        ...parsed.slice(2).map((b, j) =>
          encodeBatch(
            {
              ...b.envelope,
              batch_seq: b.envelope.batch_seq - 1,
              dropped: j === 0 ? dropped : [],
            },
            b.frames,
          ),
        ),
      ];
      expect(checkBatches(renumbered([])).problems.join("\n")).toMatch(
        new RegExp(
          `first seq ${lost.last_seq + 1} does not follow the previous batch's last seq ${lost.first_seq - 1}, and no dropped range covers ${lost.first_seq}\\.\\.${lost.last_seq}`,
        ),
      );
      // Negative control: the same hole, declared as dropped, conforms, and
      // the joined log carries the Gap the assembler would write.
      const declared = checkBatches(
        renumbered([[lost.first_seq, lost.last_seq]]),
      );
      expect(declared.problems).toEqual([]);
      const gaps = decodeLog(declared.log!).records.filter(
        (r) => r.record === "Gap",
      );
      expect(gaps).toEqual([
        {
          record: "Gap",
          first_seq: BigInt(lost.first_seq),
          last_seq: BigInt(lost.last_seq),
          reason: 1,
        },
      ]);
    },
    TIMEOUT,
  );

  it("the ct-boundary-conformance command refuses bad usage", () => {
    for (const args of [
      ["record", "--level", "1"],
      ["record", "--build", ".", "--level", "2"],
      ["record", "--build", ".", "--level", "1", "--fixture", "nope"],
      ["replay"],
    ]) {
      const r = spawnSync(process.execPath, [CONFORMANCE_CLI, ...args], {
        encoding: "utf-8",
      });
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.stderr).toMatch(/^ct-boundary-conformance: /);
    }
    const listed = spawnSync(process.execPath, [CONFORMANCE_CLI, "fixtures"], {
      encoding: "utf-8",
    });
    expect(listed.status).toBe(0);
    expect(
      (JSON.parse(listed.stdout) as { name: string }[]).map((f) => f.name),
    ).toEqual(FIXTURES.map((f) => f.name));
  });
});

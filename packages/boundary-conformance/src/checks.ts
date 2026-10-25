/**
 * The checks of the record leg (CodeTracer's JS-Boundary-Recording
 * specification §9.9), as pure functions of what the harness collected
 * from one fixture's recording. Each returns the problems it found; a check
 * passes when there are none.
 *
 * | check         | levels | what it asks |
 * |---------------|--------|--------------|
 * | `interaction` | 0, 1   | the build ran the scripted interaction: every step succeeded, the page threw nothing, and the named elements show the fixture's final text |
 * | `decode`      | 0, 1   | the log decodes strictly (§5.3) and ends with `End` |
 * | `header`      | 0, 1   | `Header` names the level, the build's hash and a session id; at level 0 no framework, and no capability but `import-seam`; `Env.url` is the page |
 * | `declaration` | 1      | `__ctBoundaryProtocol` declares protocol 1, a framework and the four required capabilities, has the record hooks, and `Header` copies it |
 * | `inputs`      | 0, 1   | every handler invocation produced one `Input` (exactly one at level 1, at least one at level 0) whose target resolves to the element; each `Input` follows its own `Task`; the declared `DomEffect`s; labels when declared |
 * | `targets`     | 1      | every target is a stable id, `ord:`, `doc` or `win`, and the targets are the same in the perturbed page |
 * | `checkpoints` | 0, 1   | §7.3's cadence, the level's scheme, and the final checkpoint's `dom-v1` equal to the document's |
 * | `reads`       | 0, 1   | the log holds at least the fixture's declared multiset of boundary reads |
 * | `envelope`    | 0, 1   | the uploaded batches conform to the batch envelope (`envelope.ts`) |
 */

import {
  type BoundaryRecord,
  type DecodedLog,
  BoundaryFormatError,
  decodeLog,
} from "@codetracer/boundary-format";

import { IMPORT_SEAM_CAPABILITY } from "@codetracer/boundary-shim";

import { checkpointCadence } from "./cadence.js";
import type { EnvelopeResult } from "./envelope.js";
import type { Fixture } from "./fixtures.js";
import {
  type CheckStatus,
  LEVEL_1_ONLY,
  type ProtocolLevel,
  RECORD_CHECKS,
  type RecordCheckName,
  REQUIRED_CAPABILITIES,
} from "./protocol.js";

/**
 * The one `Header.capabilities` a level-0 recorder may write besides `[]`:
 * the generic shim installed with the dynamic `import()` seam (§8.1).
 */
const LEVEL0_IMPORT_SEAM = JSON.stringify([IMPORT_SEAM_CAPABILITY]);

/** What a target string resolved to in the page at the end of the run. */
export interface TargetResolution {
  /** It named a node (an element, the document or the window). */
  resolved: boolean;
  /** The element's `data-fx`, or `null` (no element, or none on it). */
  fx: string | null;
}

/** What the harness read of the page's declaration (§9.2), level 1. */
export interface DeclarationSnapshot {
  present: boolean;
  protocol?: unknown;
  framework?: unknown;
  capabilities?: unknown;
  hasStop?: boolean;
  hasResolveTarget?: boolean;
}

/** Everything the harness collected from one recording of one page. */
export interface Recording {
  /** Problems running the scripted interaction (empty when it ran). */
  interactionProblems: string[];
  /** Why the log could not be collected, if it could not. */
  collectError?: string;
  /** The log: the uploaded batches, joined as the assembler joins them. */
  log?: Uint8Array;
  /** The batch bodies the page uploaded, in arrival order. */
  batches?: Uint8Array[];
  /** The uploaded batches' check. */
  envelope?: EnvelopeResult;
  declaration?: DeclarationSnapshot;
  /** Every target string the log names, resolved in the page. */
  targets: Record<string, TargetResolution>;
  /** The page's `dom-v1` hash after the session stopped, by the harness's own oracle. */
  finalDomV1?: string;
  /** `origin + pathname` of the page. */
  pageUrl: string;
}

/** The inputs of every check for one fixture. */
export interface FixtureRun {
  fixture: Fixture;
  level: ProtocolLevel;
  buildHash: string;
  recording: Recording;
  /** The perturbed page's recording (level 1). */
  perturbed?: Recording;
}

export interface CheckResult {
  name: RecordCheckName;
  status: CheckStatus;
  /** The problems found (`fail`), or why the check does not apply. */
  detail: string[];
}

/** A log decoded for the checks, or why it does not decode. */
type Decoded = { log: DecodedLog } | { error: string };

/** Decode a collected log with the batch rule for inline bodies (§5.2). */
export function decodeRecording(r: Recording): Decoded {
  if (r.log === undefined) {
    return { error: r.collectError ?? "no log was collected" };
  }
  try {
    return { log: decodeLog(r.log, { inlineBodies: "batch" }) };
  } catch (e) {
    return {
      error:
        e instanceof BoundaryFormatError
          ? `refused: ${e.message}`
          : `refused: ${String(e)}`,
    };
  }
}

const isLowerHex = (s: string, len: number): boolean =>
  s.length === len && /^[0-9a-f]+$/.test(s);

/** The records of a run's log, or `undefined` with a problem noted. */
function recordsOf(
  d: Decoded,
  problems: string[],
): readonly BoundaryRecord[] | undefined {
  if ("error" in d) {
    problems.push(`the log does not decode (${d.error})`);
    return undefined;
  }
  return d.log.records;
}

// ── The reads multiset ──────────────────────────────────────────────────

/**
 * The key a record counts under in a fixture's read multiset, or
 * `undefined` for records that are not reads the `reads` check counts
 * (input records belong to `inputs`, checkpoints to `checkpoints`):
 *
 * `Clock:<src>`, `Random:<src>`, `StorageRead:<area>:<key>`,
 * `LayoutRead:<prop>@<data-fx of its target>`, `NetRequest:<api>:<METHOD>:<path>`,
 * `NetResponse:<path of its request>`, `TaskReg:<kind>`, `Task:<kind>`
 * (not kind 5), `Navigation:<kind>`, `Refusal:<feature>`.
 */
export function readKeyOf(
  r: BoundaryRecord,
  requestPaths: ReadonlyMap<bigint, string>,
  targets: Readonly<Record<string, TargetResolution>>,
): string | undefined {
  switch (r.record) {
    case "Clock":
      return `Clock:${r.src}`;
    case "Random":
      return `Random:${r.src}`;
    case "StorageRead":
      return `StorageRead:${r.area}:${r.key}`;
    case "LayoutRead":
      return `LayoutRead:${r.prop}@${targets[r.target]?.fx ?? "?"}`;
    case "NetRequest":
      return `NetRequest:${r.api}:${r.method}:${pathOf(r.url)}`;
    case "NetResponse":
      return `NetResponse:${requestPaths.get(r.req_id) ?? "?"}`;
    case "TaskReg":
      return `TaskReg:${r.kind}`;
    case "Task":
      return r.kind === 5 ? undefined : `Task:${r.kind}`;
    case "Navigation":
      return `Navigation:${r.kind}`;
    case "Refusal":
      return `Refusal:${r.feature}`;
    default:
      return undefined;
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** The multiset of read keys of `records`. */
export function readMultiset(
  records: readonly BoundaryRecord[],
  targets: Readonly<Record<string, TargetResolution>>,
): Map<string, number> {
  const paths = new Map<bigint, string>();
  const counts = new Map<string, number>();
  for (const r of records) {
    if (r.record === "NetRequest") paths.set(r.req_id, pathOf(r.url));
    const key = readKeyOf(r, paths, targets);
    if (key !== undefined) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

// ── The checks ──────────────────────────────────────────────────────────

type Check = (run: FixtureRun, decoded: Decoded) => string[];

const interaction: Check = (run) => run.recording.interactionProblems;

const decode: Check = (_run, decoded) => {
  if ("error" in decoded) return [`the log does not decode: ${decoded.error}`];
  if (decoded.log.termination !== "Complete") {
    return [`the log ends ${decoded.log.termination}, not with End`];
  }
  return [];
};

const header: Check = (run, decoded) => {
  const problems: string[] = [];
  const records = recordsOf(decoded, problems);
  if (records === undefined) return problems;
  const h = records[0];
  const env = records[1];
  if (h?.record !== "Header" || env?.record !== "Env") {
    return ["the log does not begin with Header and Env"];
  }
  if (h.protocol_level !== run.level) {
    problems.push(
      `Header.protocol_level is ${h.protocol_level}, the run is level ${run.level}`,
    );
  }
  if (h.recorder_id === "") problems.push("Header.recorder_id is empty");
  if (h.build_hash !== run.buildHash) {
    problems.push(
      `Header.build_hash is ${JSON.stringify(h.build_hash)}, the build's hash is ${run.buildHash}`,
    );
  }
  if (!isLowerHex(h.session_id, 32)) {
    problems.push(
      `Header.session_id ${JSON.stringify(h.session_id)} is not 32 lowercase hex digits`,
    );
  }
  if (run.level === 0) {
    if (h.framework !== "")
      problems.push(
        `Header.framework is ${JSON.stringify(h.framework)} at level 0`,
      );
    // The generic shim declares one capability, and only when the deploy
    // step was asked to install the dynamic import() seam (§8.1).
    if (h.capabilities !== "[]" && h.capabilities !== LEVEL0_IMPORT_SEAM)
      problems.push(`Header.capabilities is ${h.capabilities} at level 0`);
  } else if (h.framework === "") {
    problems.push("Header.framework is empty at level 1");
  }
  if (env.url !== run.recording.pageUrl) {
    problems.push(
      `Env.url is ${JSON.stringify(env.url)}, the page is ${run.recording.pageUrl}`,
    );
  }
  return problems;
};

const declaration: Check = (run, decoded) => {
  const d = run.recording.declaration;
  if (d === undefined || !d.present) {
    return ["the page declares no globalThis.__ctBoundaryProtocol"];
  }
  const problems: string[] = [];
  if (d.protocol !== 1)
    problems.push(`protocol is ${JSON.stringify(d.protocol)}, not 1`);
  if (typeof d.framework !== "string" || d.framework === "") {
    problems.push(
      `framework ${JSON.stringify(d.framework)} is not a name/version string`,
    );
  }
  const caps = d.capabilities;
  if (!Array.isArray(caps) || !caps.every((c) => typeof c === "string")) {
    problems.push(
      `capabilities ${JSON.stringify(caps)} is not an array of strings`,
    );
  } else {
    for (const c of REQUIRED_CAPABILITIES) {
      if (!caps.includes(c))
        problems.push(`capabilities lacks ${JSON.stringify(c)}`);
    }
  }
  if (!d.hasStop) problems.push("record.stop is not a function");
  if (!d.hasResolveTarget)
    problems.push("record.resolveTarget is not a function");
  const records = recordsOf(decoded, problems);
  const h = records?.[0];
  if (h?.record === "Header") {
    if (h.framework !== d.framework) {
      problems.push(
        `Header.framework ${JSON.stringify(h.framework)} differs from the declaration's ${JSON.stringify(d.framework)}`,
      );
    }
    let headerCaps: unknown;
    try {
      headerCaps = JSON.parse(h.capabilities);
    } catch {
      headerCaps = h.capabilities;
    }
    if (JSON.stringify(headerCaps) !== JSON.stringify(caps)) {
      problems.push(
        `Header.capabilities ${h.capabilities} differs from the declaration's ${JSON.stringify(caps)}`,
      );
    }
  }
  return problems;
};

const inputs: Check = (run, decoded) => {
  const problems: string[] = [];
  const records = recordsOf(decoded, problems);
  if (records === undefined) return problems;
  const targets = run.recording.targets;
  const fxOf = (t: string) => targets[t]?.fx ?? null;
  // Which task each Input belongs to: its own Task{5} right before it, or
  // the hydration task it was replayed in (§9.5).
  const hydrationInputs = new Set<number>();
  let lastTask: Extract<BoundaryRecord, { record: "Task" }> | undefined;
  let lastTaskIndex = -1;
  records.forEach((r, i) => {
    if (r.record === "Task") {
      lastTask = r;
      lastTaskIndex = i;
    }
    if (r.record === "Input" || r.record === "DomEffect") {
      if (!targets[r.target]?.resolved) {
        problems.push(
          `${r.record} at seq ${r.seq}: target ${JSON.stringify(r.target)} resolves to nothing`,
        );
      }
    }
    if (r.record !== "Input") return;
    if (lastTask === undefined || lastTask.task_id !== r.task_id) {
      problems.push(
        `Input at seq ${r.seq} (task ${r.task_id}) does not follow a Task of its task_id`,
      );
    } else if (lastTask.kind === 11) {
      hydrationInputs.add(i);
    } else if (lastTask.kind !== 5 || lastTaskIndex !== i - 1) {
      problems.push(
        `Input at seq ${r.seq} is not directly after its Task{kind: 5}`,
      );
    }
    if (run.level === 1 && declaredLabels(run) && r.label === "") {
      problems.push(
        `Input at seq ${r.seq} has no label, though the framework declares "labels"`,
      );
    }
  });
  const inputsAt = records
    .map((r, i) => [r, i] as const)
    .filter(([r]) => r.record === "Input") as [
    Extract<BoundaryRecord, { record: "Input" }>,
    number,
  ][];
  let expectedTotal = 0;
  for (const h of run.fixture.handlers) {
    expectedTotal += h.count;
    const matching = inputsAt.filter(
      ([r]) => r.type === h.type && fxOf(r.target) === h.fx,
    );
    const n = matching.length;
    if (run.level === 1 ? n !== h.count : n < h.count) {
      problems.push(
        `${h.count} ${h.type} handler invocation(s) on ${h.fx}, ${n} matching Input(s)` +
          (run.level === 1 ? " (exactly one each at level 1)" : ""),
      );
    }
    if (run.level === 1 && h.prehydration !== undefined) {
      const replayed = matching.filter(([, i]) =>
        hydrationInputs.has(i),
      ).length;
      if (replayed !== h.prehydration) {
        problems.push(
          `${h.prehydration} ${h.type} on ${h.fx} arrived before hydration, ${replayed} Input(s) were recorded in the hydration task`,
        );
      }
    }
  }
  if (run.level === 1 && inputsAt.length !== expectedTotal) {
    problems.push(
      `${inputsAt.length} Input record(s), but the interaction invokes ${expectedTotal} handler(s)`,
    );
  }
  for (const e of run.fixture.domEffects ?? []) {
    const n = records.filter(
      (r) =>
        r.record === "DomEffect" &&
        r.effect === e.effect &&
        fxOf(r.target) === e.fx,
    ).length;
    if (n < e.min) {
      problems.push(
        `${n} DomEffect{effect: ${e.effect}} on ${e.fx}, at least ${e.min} expected`,
      );
    }
  }
  return problems;
};

function declaredLabels(run: FixtureRun): boolean {
  const caps = run.recording.declaration?.capabilities;
  return Array.isArray(caps) && caps.includes("labels");
}

/** The level-1 target forms (§9.1, §9.3). */
const STABLE_TARGET = /^(iid:.+|ord:[1-9][0-9]*|doc|win)$/;

/** The targets of a log, in order, each with what names it there. */
function targetSequence(
  records: readonly BoundaryRecord[],
): { what: string; target: string }[] {
  const out: { what: string; target: string }[] = [];
  for (const r of records) {
    if (r.record === "Input")
      out.push({ what: `Input ${r.type}`, target: r.target });
    else if (r.record === "DomEffect")
      out.push({ what: `DomEffect ${r.effect}`, target: r.target });
    else if (r.record === "LayoutRead")
      out.push({ what: `LayoutRead ${r.prop}`, target: r.target });
  }
  return out;
}

const targetsCheck: Check = (run, decoded) => {
  const problems: string[] = [];
  const records = recordsOf(decoded, problems);
  if (records === undefined) return problems;
  const seq = targetSequence(records);
  for (const t of new Set(seq.map((s) => s.target))) {
    if (!STABLE_TARGET.test(t)) {
      problems.push(
        `target ${JSON.stringify(t)} is not a stable id, ord:, doc or win`,
      );
    }
  }
  if (run.perturbed === undefined) {
    problems.push("the perturbed page was not recorded");
    return problems;
  }
  if (run.perturbed.interactionProblems.length > 0) {
    problems.push(
      `the perturbed page did not run: ${run.perturbed.interactionProblems.join("; ")}`,
    );
    return problems;
  }
  const other = decodeRecording(run.perturbed);
  if ("error" in other) {
    problems.push(`the perturbed page's log does not decode (${other.error})`);
    return problems;
  }
  const seqB = targetSequence(other.log.records);
  const n = Math.max(seq.length, seqB.length);
  const show = (e: { what: string; target: string } | undefined) =>
    e === undefined ? "(none)" : `${e.what} on ${e.target}`;
  for (let i = 0; i < n; i++) {
    if (show(seq[i]) !== show(seqB[i])) {
      problems.push(
        `with an unrelated element inserted above, target #${i} changed from ${show(seq[i])} to ${show(seqB[i])}`,
      );
      break;
    }
  }
  return problems;
};

const checkpoints: Check = (run, decoded) => {
  const problems: string[] = [];
  const records = recordsOf(decoded, problems);
  if (records === undefined) return problems;
  const cadence = checkpointCadence(records);
  problems.push(...cadence.violations);
  const cps = records.filter(
    (r): r is Extract<BoundaryRecord, { record: "Checkpoint" }> =>
      r.record === "Checkpoint",
  );
  if (cps.length === 0) {
    problems.push("the log holds no checkpoint");
    return problems;
  }
  const h = records[0];
  const fwName = h?.record === "Header" ? h.framework.split("/")[0] : "";
  for (const c of cps) {
    if (run.level === 0) {
      if (c.scheme !== "dom-v1" || c.dom_digest !== "") {
        problems.push(
          `checkpoint ${c.ordinal}: scheme ${c.scheme} with dom_digest ${JSON.stringify(c.dom_digest)}, expected dom-v1 and none`,
        );
      }
    } else {
      if (
        !new RegExp(`^${escapeRegExp(fwName)}-state-v[1-9][0-9]*$`).test(
          c.scheme,
        )
      ) {
        problems.push(
          `checkpoint ${c.ordinal}: scheme ${c.scheme} is not ${fwName}-state-v<n>`,
        );
      }
      if (!isLowerHex(c.dom_digest, 64)) {
        problems.push(
          `checkpoint ${c.ordinal}: dom_digest ${JSON.stringify(c.dom_digest)} is not a dom-v1 hash`,
        );
      }
    }
    if (!isLowerHex(c.state_hash, 64)) {
      problems.push(
        `checkpoint ${c.ordinal}: state_hash ${JSON.stringify(c.state_hash)} is not 64 lowercase hex digits`,
      );
    }
  }
  const last = cps[cps.length - 1];
  const lastIndex = records.lastIndexOf(last);
  if (
    records[lastIndex + 1]?.record === "End" &&
    run.recording.finalDomV1 !== undefined
  ) {
    const dom = run.level === 0 ? last.state_hash : last.dom_digest;
    if (dom !== run.recording.finalDomV1) {
      problems.push(
        `the final checkpoint's dom-v1 is ${dom}, the document's is ${run.recording.finalDomV1}`,
      );
    }
  }
  if (
    run.fixture.midSessionCheckpoint &&
    cadence.dueByCount.length + cadence.dueByTime.length === 0
  ) {
    problems.push(
      "no checkpoint fell due before the end, though the fixture runs past §7.3's 2 s",
    );
  }
  return problems;
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const reads: Check = (run, decoded) => {
  const problems: string[] = [];
  const records = recordsOf(decoded, problems);
  if (records === undefined) return problems;
  const counts = readMultiset(records, run.recording.targets);
  const expected = [
    ...run.fixture.reads,
    ...(run.level === 1 ? (run.fixture.readsAtLevel1 ?? []) : []),
  ];
  for (const e of expected) {
    const n = counts.get(e.key) ?? 0;
    if (n < e.min)
      problems.push(`${e.key}: ${n} in the log, at least ${e.min} expected`);
  }
  return problems;
};

const envelope: Check = (run) => {
  const e = run.recording.envelope;
  if (e === undefined) return ["no batch was collected"];
  return e.problems;
};

const CHECKS: Record<RecordCheckName, Check> = {
  interaction,
  decode,
  header,
  declaration,
  inputs,
  targets: targetsCheck,
  checkpoints,
  reads,
  envelope,
};

/** Run every record-leg check on one fixture's run, in report order. */
export function runRecordChecks(run: FixtureRun): CheckResult[] {
  const decoded = decodeRecording(run.recording);
  return RECORD_CHECKS.map((name) => {
    if (run.level === 0 && LEVEL_1_ONLY.has(name)) {
      return {
        name,
        status: "not-applicable-at-level-0" as const,
        detail: [`${name} is a level-1 property`],
      };
    }
    let detail: string[];
    try {
      detail = CHECKS[name](run, decoded);
    } catch (e) {
      detail = [`the check itself failed: ${String(e)}`];
    }
    return { name, status: detail.length === 0 ? "pass" : "fail", detail };
  });
}

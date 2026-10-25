/**
 * The codetracer sibling binaries the replay tests run, and the assembly of a
 * recorded log into a boundary recording (`.ct`) the way the ingest does it
 * (CodeTracer's JS-Boundary-Recording specification §5.6, §12).
 *
 * `session-manager` (`cargo build --bin session-manager` in
 * codetracer/src/backend-manager) hosts `record-web`, which writes a
 * materialised trace; `ct-jsbound` (`cargo build --bin ct-jsbound` in
 * codetracer/libs/jsbound) assembles uploaded batches into a recording. Each
 * is found through its environment variable or in the sibling checkout; a
 * missing one fails the test that needs it, naming the build command, rather
 * than skip it.
 *
 * No mocks: the batches are encoded with the shared batch codec and assembled
 * by the real `ct-jsbound assemble`.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  type BoundaryRecord,
  encodeBatch,
  encodeFrame,
  seqOf,
} from "../../packages/boundary-format/src/index.js";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const WORKSPACE = path.dirname(REPO_ROOT);

/** A canonical UUIDv7, the recording id the assembler requires. */
export const RECORDING_ID = "01890a5d-ac96-774b-bcce-b302099a8057";

/** A sibling binary: `env` when set, else the first candidate that exists. */
export function locateSibling(
  env: string,
  candidates: string[],
  build: string,
): string {
  const fromEnv = process.env[env];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  for (const c of candidates) {
    const p = path.join(WORKSPACE, c);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`${candidates[0]} is not built: ${build} (or set ${env})`);
}

/** codetracer's `session-manager`, whose `record-web` writes the trace. */
export function sessionManagerPath(): string {
  return locateSibling(
    "CODETRACER_SESSION_MANAGER",
    [
      "codetracer/src/backend-manager/target/release/session-manager",
      "codetracer/src/backend-manager/target/debug/session-manager",
    ],
    "cargo build --bin session-manager in codetracer/src/backend-manager",
  );
}

/** codetracer's `ct-jsbound`, the recording assembler. */
export function ctJsboundPath(): string {
  return locateSibling(
    "CT_JSBOUND",
    [
      "codetracer/libs/jsbound/target/release/ct-jsbound",
      "codetracer/libs/jsbound/target/debug/ct-jsbound",
    ],
    "cargo build --bin ct-jsbound in codetracer/libs/jsbound",
  );
}

/**
 * Assemble `records` into `<outDir>/session.ct` with the real `ct-jsbound
 * assemble` (`ctJsbound`), as the ingest would: uploaded as batches of 64
 * frames, or, with `omit`, as three batches whose middle one (the records at
 * `omit[0]..omit[1]`) never arrives, which the assembler turns into a `Gap`.
 * The batches are staged in `batchDir`. Returns the recording's path.
 */
export function assembleRecording(
  ctJsbound: string,
  records: BoundaryRecord[],
  batchDir: string,
  outDir: string,
  omit?: [number, number],
): string {
  const header = records[0] as Extract<BoundaryRecord, { record: "Header" }>;
  const ranges: [number, number][] = [];
  if (omit === undefined) {
    for (let i = 0; i < records.length; i += 64) {
      ranges.push([i, Math.min(i + 64, records.length) - 1]);
    }
  } else {
    ranges.push([0, omit[0] - 1], omit, [omit[1] + 1, records.length - 1]);
  }
  let lastSeq = 0;
  ranges.forEach(([a, b], batchSeq) => {
    const slice = records.slice(a, b + 1);
    const seqs = slice
      .map((r) => seqOf(r))
      .filter((s): s is bigint => s !== undefined)
      .map(Number);
    const first = seqs.length > 0 ? seqs[0] : lastSeq + 1;
    const last = seqs.length > 0 ? seqs[seqs.length - 1] : lastSeq;
    lastSeq = last;
    if (omit !== undefined && batchSeq === 1) return; // never arrives
    const frames = slice.map(encodeFrame);
    let size = 0;
    for (const f of frames) size += f.length;
    const run = new Uint8Array(size);
    let at = 0;
    for (const f of frames) {
      run.set(f, at);
      at += f.length;
    }
    const body = encodeBatch(
      {
        session_id: header.session_id,
        batch_seq: batchSeq,
        first_seq: first,
        last_seq: last,
        dropped: [],
        build_hash: header.build_hash,
        final: batchSeq === ranges.length - 1,
      },
      run,
    );
    fs.writeFileSync(path.join(batchDir, String(batchSeq)), body);
  });
  const out = path.join(outDir, "session.ct");
  const r = spawnSync(
    ctJsbound,
    ["assemble", "--recording-id", RECORDING_ID, "--out", out, batchDir],
    { encoding: "utf-8" },
  );
  if (r.status !== 0) {
    throw new Error(`ct-jsbound assemble failed (${r.status}): ${r.stderr}`);
  }
  return out;
}

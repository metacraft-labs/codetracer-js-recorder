/**
 * Unit tests of the §7.3 checkpoint-cadence oracle (`checkpointCadence`) on
 * hand-built record lists. No mocks: the oracle is a pure function of the
 * decoded records, and each list is the shape a recorder writes.
 *
 * The records are built so that a checkpoint is due by record count at the
 * point under test (a `Task` and 255 `Input`s make 256 seq-bearing records),
 * which keeps the cases about placement, not cadence.
 */
import { describe, expect, it } from "vitest";
import { checkpointCadence } from "../../packages/boundary-conformance/src/cadence.js";

type Rec = { record: string; seq: number; [k: string]: unknown };

/** A `Task` at seq 1 and 255 `Input`s: 256 records, so a checkpoint is due. */
function due(): Rec[] {
  const out: Rec[] = [{ record: "Task", seq: 1, kind: 5 }];
  for (let seq = 2; seq <= 256; seq++) out.push({ record: "Input", seq });
  return out;
}

function checkpoint(seq: number, ordinal: number): Rec {
  return {
    record: "Checkpoint",
    seq,
    ordinal,
    scheme: "dom-v1",
    state_hash: "00",
    dom_digest: "00",
  };
}

/** Records after the due point, closed by a final checkpoint and `End`. */
function run(...middle: Rec[]): Rec[] {
  const tail = [...middle, checkpoint(0, 1), { record: "End", seq: 0 }];
  // Renumber so seqs ascend from the due prefix; the final checkpoint takes
  // the seq after the middle records.
  let seq = 257;
  const numbered = tail.map((r) => {
    if (r.record === "End") return r;
    const out = { ...r, seq };
    seq += 1;
    return out;
  });
  return [...due(), ...numbered];
}

describe("checkpointCadence: a checkpoint's place relative to a sensitive input", () => {
  it("accepts a checkpoint before a sensitive input's Scrubbed (§7.2, §11.3.9)", () => {
    // The Scrubbed stands in for the value DomEffect of an input at a sensitive
    // field, so it starts the macrotask as a DomEffect does.
    const records = run(
      checkpoint(0, 0),
      { record: "Scrubbed", seq: 0, target: "t", class: 1, length: 4 },
      { record: "Task", seq: 0, kind: 5 },
      { record: "Input", seq: 0 },
    );
    const { violations } = checkpointCadence(records);
    expect(violations).toEqual([]);
  });

  it("flags a checkpoint between a Scrubbed and the Input it precedes", () => {
    // The Input is not the start of a macrotask, so this checkpoint is in the
    // middle of one.
    const records = run(
      { record: "Scrubbed", seq: 0, target: "t", class: 1, length: 4 },
      checkpoint(0, 0),
      { record: "Input", seq: 0 },
    );
    const { violations } = checkpointCadence(records);
    expect(
      violations.some((v) =>
        /^checkpoint at seq \d+ is not at a task boundary$/.test(v),
      ),
      violations.join("\n"),
    ).toBe(true);
  });
});

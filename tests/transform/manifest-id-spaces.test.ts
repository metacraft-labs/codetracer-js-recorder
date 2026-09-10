/**
 * Regression suite for the manifest id-space contract.
 *
 * The instrumented source carries site and function ids as bare numeric
 * literals (`__ct.step(20)`, `__ct.enter(2)`) and the recorder resolves
 * each one by indexing straight into the MERGED manifest's `sites` /
 * `functions` arrays. The merge therefore cannot renumber them: the
 * emitted code has already been written by then.
 *
 * The defect these tests pin: slices used to be minted from zero
 * regardless of where they would be merged, and the merge "repaired"
 * that by offsetting `fnId` references *inside* the manifest. That made
 * the manifest internally consistent and nothing else — a second file's
 * `__ct.step(k)` still resolved against the FIRST file's site `k`, so
 * every step recorded outside the first instrumented file was
 * attributed to an unrelated line of that first file, with no error
 * anywhere. It is what made
 * `codetracer/src/db-backend/tests/javascript_hcr_ctfs_integration.rs`
 * stop the debugger on a phantom `index.js:23` step that was really a
 * `mymodule.js` step from the initial `require`.
 *
 * No mocks: these run the real SWC instrumenter over real sources and
 * read the ids out of the real emitted code.
 */

import { describe, it, expect } from "vitest";
import {
  instrument,
  mergeManifestSlices,
  nextManifestIdBases,
  ManifestIdBaseMismatchError,
} from "@codetracer/instrumenter";
import type { ManifestSlice, MergedManifest } from "@codetracer/instrumenter";

const FILE_A = "/proj/a.js";
const FILE_B = "/proj/b.js";

const SOURCE_A = `function alpha(n) {
    return n * 2;
}
var x = alpha(1);
var y = x + 1;
`;

// Deliberately longer than A, and with a different shape, so a
// mis-resolved id from B would land somewhere plausible inside A rather
// than out of range.
const SOURCE_B = `function beta(n) {
    var t = n + 1;
    return t * 3;
}
function gamma(a, b) {
    return a - b;
}
var p = beta(2);
var q = gamma(p, 1);
var r = q + p;
`;

/** Every `__ct.<method>(<id>` occurrence in emitted code, in source order. */
function emittedCalls(code: string): Array<{ method: string; id: number }> {
  const out: Array<{ method: string; id: number }> = [];
  const re = /__ct\.(step|enter|ret|write)\((\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    out.push({ method: m[1]!, id: Number(m[2]!) });
  }
  return out;
}

/**
 * Instrument both files the way a merging caller must: ask for the id
 * bases before each file, then merge in the same order.
 */
function instrumentBoth(): {
  merged: MergedManifest;
  codeA: string;
  codeB: string;
  slices: ManifestSlice[];
} {
  const slices: ManifestSlice[] = [];
  const a = instrument(SOURCE_A, {
    filename: FILE_A,
    idBases: nextManifestIdBases(slices),
  });
  slices.push(a.manifestSlice);
  const b = instrument(SOURCE_B, {
    filename: FILE_B,
    idBases: nextManifestIdBases(slices),
  });
  slices.push(b.manifestSlice);
  return {
    merged: mergeManifestSlices(slices),
    codeA: a.code,
    codeB: b.code,
    slices,
  };
}

describe("manifest id spaces across files", () => {
  it("resolves every id emitted by a non-first file to that file's own sites", () => {
    const { merged, codeB } = instrumentBoth();
    const pathIndexB = merged.paths.indexOf(FILE_B);
    expect(pathIndexB).toBeGreaterThanOrEqual(0);

    const calls = emittedCalls(codeB);
    // The fixture has functions, returns, assignments and plain steps,
    // so all four `__ct` entry points are exercised.
    expect(new Set(calls.map((c) => c.method))).toEqual(
      new Set(["step", "enter", "ret", "write"]),
    );

    for (const call of calls) {
      if (call.method === "enter" || call.method === "ret") {
        const fn = merged.functions[call.id];
        expect(
          fn,
          `functions[${call.id}] missing for __ct.${call.method}`,
        ).toBeDefined();
        expect(
          fn!.pathIndex,
          `__ct.${call.method}(${call.id}) resolves to ${merged.paths[fn!.pathIndex]}`,
        ).toBe(pathIndexB);
      } else {
        const site = merged.sites[call.id];
        expect(
          site,
          `sites[${call.id}] missing for __ct.${call.method}`,
        ).toBeDefined();
        expect(
          site!.pathIndex,
          `__ct.${call.method}(${call.id}) resolves to ${merged.paths[site!.pathIndex]}`,
        ).toBe(pathIndexB);
      }
    }
  });

  it("resolves every id emitted by the first file to that file's own sites", () => {
    const { merged, codeA } = instrumentBoth();
    const pathIndexA = merged.paths.indexOf(FILE_A);
    for (const call of emittedCalls(codeA)) {
      const entry =
        call.method === "enter" || call.method === "ret"
          ? merged.functions[call.id]
          : merged.sites[call.id];
      expect(entry).toBeDefined();
      expect(entry!.pathIndex).toBe(pathIndexA);
    }
  });

  it("keeps a call site's fnId pointing at the function it opens", () => {
    const { merged } = instrumentBoth();
    for (const site of merged.sites) {
      if (site.fnId === undefined) continue;
      const fn = merged.functions[site.fnId];
      expect(fn, `site fnId ${site.fnId} out of range`).toBeDefined();
      // A call/return site and the function it refers to are always in
      // the same file. Before the fix the merge re-offset `fnId` a
      // second time on top of an already-global id, which broke exactly
      // this.
      expect(fn!.pathIndex).toBe(site.pathIndex);
    }
  });

  it("refuses to merge a slice that was minted for a different position", () => {
    // What every consumer used to do: instrument each file from zero and
    // hope the merge could fix it. It cannot — so it must refuse.
    const a = instrument(SOURCE_A, { filename: FILE_A });
    const b = instrument(SOURCE_B, { filename: FILE_B });
    expect(() =>
      mergeManifestSlices([a.manifestSlice, b.manifestSlice]),
    ).toThrow(ManifestIdBaseMismatchError);
  });

  it("merges a single slice unchanged, with no bases supplied", () => {
    const a = instrument(SOURCE_A, { filename: FILE_A });
    const merged = mergeManifestSlices([a.manifestSlice]);
    expect(merged.sites).toEqual(a.manifestSlice.sites);
    expect(merged.functions).toEqual(a.manifestSlice.functions);
    expect(merged.paths).toEqual([FILE_A]);
  });

  it("reports the id bases a slice was minted with", () => {
    const { slices } = instrumentBoth();
    expect(slices[0]!.functionIdBase).toBe(0);
    expect(slices[0]!.siteIdBase).toBe(0);
    expect(slices[1]!.functionIdBase).toBe(slices[0]!.functions.length);
    expect(slices[1]!.siteIdBase).toBe(slices[0]!.sites.length);
  });
});

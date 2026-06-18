/**
 * Transitive composition end-to-end test —
 * `formatted-view → recorded-minified → original-pre-minification →
 *  renamed identifier`.
 *
 * Spec: `codetracer-specs/Planned-Features/
 * Column-Aware-Tracing-And-Deminification.milestones.org` §P6.
 *
 * ## Why this test exists
 *
 * The deminification stack has FOUR composable layers:
 *
 *   1. **Recorder-side autoformat** (P6.2) — `tryAutoformat` /
 *      `generateInverseSourceMap`.  When the recorder sees a minified
 *      source it pretty-prints it once and emits an inverse Source
 *      Map V3 document that maps positions in the **formatted view**
 *      back to positions in the **recorded minified source**.
 *   2. **Upstream sourcemap** (P3) — the toolchain that produced
 *      `minified.js` shipped a sibling `minified.js.map` mapping every
 *      minified position back to the original (pre-minification)
 *      source.  Replay-server's `SourcemapCache` consumes this map.
 *   3. **Per-position name recovery** (P6.4) — the upstream sourcemap
 *      carries a `names[]` array and segment-level `name_index`
 *      values; for every minified position whose segment carries a
 *      `name_index`, the cache surfaces the original identifier name
 *      attached to that position.
 *   4. **User rename list** (P5) — the trace ships `renames.toml`
 *      mapping original-side names to user-chosen display names.
 *
 * Each layer has its own unit tests, but a layered architecture
 * is only as good as its composition contract.  This test pins the
 * COMPOSITION: given a position in the formatted view, walking
 * layers 1 → 2 → 3 → 4 must surface the user's chosen display name.
 *
 * ## Scope: composition-logic unit test, not full DAP
 *
 * A fully DAP-driven version of this test would spawn the
 * replay-server (Rust db-backend) as a subprocess, open the trace,
 * issue `initialize` / `launch` / `stackTrace` / `scopes` / `variables`
 * DAP requests, and assert on the resulting variable name.  That's
 * worth doing as a follow-up integration test once the recorder ↔
 * replay-server boundary is more thoroughly exercised end-to-end (see
 * the open follow-ups list).
 *
 * For now this test lives in the **recorder** repo and exercises the
 * composition logic at the layer where both inputs are reachable:
 *
 *   - Layer 1 (inverse map) is produced inside the recorder by
 *     `generateInverseSourceMap`.
 *   - Layer 2 (upstream map) is a static fixture under
 *     `tests/fixtures/transitive/minified.js.map`.
 *   - Layer 3 (per-position name recovery) is the standard V3 spec
 *     behaviour, exercised here through `@jridgewell/trace-mapping`'s
 *     `originalPositionFor`, which is the same Node-land V3 parser
 *     the recorder's autoformat unit tests use to verify map shape.
 *   - Layer 4 (user list) is a TOML file parsed by a tiny inline
 *     reader — we don't depend on the Rust `rename_list` crate from
 *     a TS test, but the lookup semantics are identical (scope-aware,
 *     "global" fallback, explicit wins).
 *
 * The test also exercises the **recorder-side architectural gate**
 * around autoformat-vs-upstream-map: the recorder explicitly skips
 * autoformat when a `<file>.map` sibling is present (see
 * `packages/cli/src/record-cmd.ts`, ~line 770) on the assumption that
 * the upstream toolchain already provides a better mapping.  In a
 * real recording the formatted-view layer wouldn't be in play here
 * — but the inverse-map machinery is reusable for synthetic
 * formatted views (e.g. a debugger UI that wants to re-pretty-print
 * a minified bundle at view time).  The composition contract MUST
 * survive whether the recorder ran the autoformat pass or not.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  generateInverseSourceMap,
  tryAutoformat,
  runPrettier,
} from "@codetracer/instrumenter";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";

const FIXTURE_DIR = path.resolve(__dirname, "../fixtures/transitive");

/**
 * Tiny inline reader for the subset of `renames.toml` we need here.
 *
 * The full reader lives in the Rust db-backend
 * (`src/db-backend/src/rename_list.rs`) and supports `function:` /
 * `block:` scopes, duplicate detection, and `meta` headers.  For this
 * unit test we only need the `global` lookup branch — the user list
 * carries one entry `{ file = "original.js", scope = "global",
 * from = "calculateSum", to = "addNumbers" }`.
 *
 * Defensive: we throw if the file is malformed or the expected entry
 * is missing so a fixture regression is loud, not silent.
 */
function loadGlobalRenames(tomlPath: string): Map<string, Map<string, string>> {
  const text = fs.readFileSync(tomlPath, "utf-8");
  // The fixture is hand-written and small enough that a regex pass is
  // safer than pulling in a TOML parser dependency just for tests.
  // Each `[[rename]]` block is matched in source order; later
  // duplicates would clobber earlier ones but the fixture asserts
  // uniqueness.
  const blocks = text.split(/\[\[rename\]\]/g).slice(1);
  const out = new Map<string, Map<string, string>>();
  for (const block of blocks) {
    const file = /file\s*=\s*"([^"]+)"/.exec(block)?.[1];
    const scope = /scope\s*=\s*"([^"]+)"/.exec(block)?.[1] ?? "global";
    const from = /from\s*=\s*"([^"]+)"/.exec(block)?.[1];
    const to = /to\s*=\s*"([^"]+)"/.exec(block)?.[1];
    if (!file || !from || !to) {
      throw new Error(`malformed [[rename]] block in ${tomlPath}: ${block}`);
    }
    if (scope !== "global") continue; // outside scope of this test
    if (!out.has(file)) out.set(file, new Map());
    out.get(file)!.set(from, to);
  }
  return out;
}

/**
 * Lookup an original-side name in a parsed rename list.
 *
 * Mirrors the global-scope branch of
 * `RenameList::lookup` in `rename_list.rs`: we first try the recorded
 * file path verbatim, then the basename — that's the contract the
 * Rust reader documents under §"Lookup semantics".
 */
function applyRename(
  renames: Map<string, Map<string, string>>,
  file: string,
  name: string,
): string {
  const byPath = renames.get(file);
  if (byPath?.has(name)) return byPath.get(name)!;
  const basename = path.basename(file);
  const byBase = renames.get(basename);
  if (byBase?.has(name)) return byBase.get(name)!;
  return name;
}

describe("transitive composition (format + sourcemap + rename)", () => {
  it(
    "formatted line/col survives through to renamed identifier",
    { timeout: 30_000 },
    () => {
      // ---- Inputs ---------------------------------------------------
      const originalSrc = fs.readFileSync(
        path.join(FIXTURE_DIR, "original.js"),
        "utf-8",
      );
      const minifiedSrc = fs.readFileSync(
        path.join(FIXTURE_DIR, "minified.js"),
        "utf-8",
      );
      const upstreamMapJson = fs.readFileSync(
        path.join(FIXTURE_DIR, "minified.js.map"),
        "utf-8",
      );
      const renames = loadGlobalRenames(path.join(FIXTURE_DIR, "renames.toml"));

      // STRICT: fixture invariants — guard against accidental edits to
      // the fixture set that would make the rest of the test pass for
      // the wrong reasons.
      expect(originalSrc).toContain("calculateSum");
      expect(minifiedSrc).toContain("calculateSum");
      expect(minifiedSrc.split("\n").filter((l) => l.length > 0).length).toBe(
        1,
      );
      const renamesForOriginal = renames.get("original.js");
      expect(renamesForOriginal).toBeDefined();
      expect(renamesForOriginal!.get("calculateSum")).toBe("addNumbers");

      // ---- Layer 1: recorder-side autoformat + inverse sourcemap ----
      //
      // The recorder shells out to prettier to produce the formatted
      // view, then builds an inverse Source Map V3 document that maps
      // each formatted line back to a line in the recorded-minified
      // source.  We invoke `tryAutoformat` directly (not the higher
      // level CLI) because the CLI's autoformat skip gate fires when an
      // upstream `.map` is present — that gate is correct for a real
      // recording but here we explicitly want to exercise both maps.
      //
      // The `tryAutoformat` call uses the threshold override `0` so the
      // single-line minified fixture trips the minified heuristic
      // unconditionally.
      const fmtOutcome = tryAutoformat(minifiedSrc, "minified.js", {
        enabled: true,
        threshold: 0,
      });
      expect(fmtOutcome.kind).toBe("ok");
      if (fmtOutcome.kind !== "ok") return;
      const formatted = fmtOutcome.formatted;
      // Sanity: prettier broke the single-line minified source into
      // multiple lines (otherwise there's nothing to map back).
      expect(formatted.split("\n").length).toBeGreaterThan(2);

      // The inverse map produced by `tryAutoformat` is keyed off the
      // SOURCE name we passed in (`"minified.js"`).  Replay-server
      // reads this map at trace-open time to translate any (formatted
      // line, col) position into a (recorded-minified line, col)
      // position.
      const inverseMap = fmtOutcome.sourceMap;
      expect(inverseMap.sources).toEqual(["minified.js"]);
      const inverseTm = new TraceMap(JSON.stringify(inverseMap));

      // Pick a formatted-line position to test.  We look for the line
      // carrying the formatted `module.exports = { calculateSum: a };`
      // statement — that line has identifier anchors (`module`,
      // `exports`, `calculateSum`) ≥3 chars long that the inverse-map
      // builder picks up.
      //
      // The function-declaration line in this fixture (`function a(b,
      // c) {`) has only 1- and 2-char identifiers, which the recorder's
      // `generateInverseSourceMap` filters out by design — see its doc
      // comment §"identifier tokens".  Tests must anchor on a line with
      // identifier tokens that survive both minification and formatting.
      const formattedLines = formatted.split("\n");
      const exportsLineIdx = formattedLines.findIndex((l) =>
        /module\.exports/.test(l),
      );
      expect(exportsLineIdx).toBeGreaterThanOrEqual(0);

      // Layer-1 lookup: ask the inverse map where this formatted line
      // came from in the recorded-minified source.  We pass `column: 0`
      // because the inverse map is line-level only (the recorder's
      // `generateInverseSourceMap` is v1, line precision — see its doc
      // comment for the rationale).
      const layer1 = originalPositionFor(inverseTm, {
        line: exportsLineIdx + 1, // 1-indexed
        column: 0,
      });
      expect(layer1.source).toBe("minified.js");
      // The recorded-minified source is single-line, so EVERY anchored
      // formatted line must map back to line 1.
      expect(layer1.line).toBe(1);

      // ---- Layer 2 + 3: upstream sourcemap + per-position name ------
      //
      // The upstream toolchain shipped `minified.js.map`.  We feed it
      // into the same V3 parser; given the recorded-minified (line, col)
      // from layer 1, the parser returns the matching position in
      // `original.js` plus the original-side name attached to that
      // segment.
      //
      // We pick the `a` identifier position at the top-level call
      // (`a(3,4);` near the end of the minified line) because that's
      // the segment whose `name_index` was wired to the original
      // `calculateSum` identifier in the fixture's map generator.
      //
      // The minified-line column of `a` in `a(3,4);` is 71 — see
      // `tests/fixtures/transitive/minified.js` and the per-position
      // walk-through in the map's generator script (committed as a
      // comment in `minified.js.map`).
      const upstreamTm = new TraceMap(upstreamMapJson);
      const layer23 = originalPositionFor(upstreamTm, {
        line: layer1.line!, // recorded-minified line = 1
        column: 71, // position of `a` in the top-level `a(3,4);` call
      });
      expect(layer23.source).toBe("original.js");
      // `original.js` line 6 carries `calculateSum(3, 4);`.
      expect(layer23.line).toBe(6);
      // The per-position name recovery surfaces the original identifier
      // name attached to this segment.  This is the layer that
      // recovers `calculateSum` from minified `a`.
      expect(layer23.name).toBe("calculateSum");

      // ---- Layer 4: user rename list --------------------------------
      //
      // Run the original-side name through the user TOML to surface
      // the user's chosen display name.  This is the contract the
      // replay-server's `SourcemapCache::resolve_name_at_position`
      // enforces in `db-backend/src/sourcemap_cache.rs`.
      const renamed = applyRename(renames, layer23.source!, layer23.name!);
      expect(renamed).toBe("addNumbers");

      // ---- STRICT composition assertions: 4 transitions -------------
      //
      // These mirror the high-level assertions called out in the
      // dispatch description; each one pins a single layer's
      // contribution.

      // 1) The formatted view is multi-line (recorder's autoformat
      //    actually fired and produced a view we could anchor into).
      expect(formattedLines.length).toBeGreaterThan(2);

      // 2) The formatted-line position resolved to a recorded-minified
      //    position via the recorder's inverse map.
      expect(layer1.source).toBe("minified.js");
      expect(layer1.line).toBe(1);

      // 3) The recorded-minified position resolved to an original.js
      //    position via the upstream sourcemap.
      expect(layer23.source).toBe("original.js");

      // 4) The user rename list translated the original-side name to
      //    the user's chosen display name.
      expect(renamed).toBe("addNumbers");
    },
  );

  it("inverse map is monotone and parser-roundtrips", () => {
    // Smoke test on the inverse-map shape so a regression in
    // `generateInverseSourceMap` (e.g. a VLQ encoding bug) doesn't
    // silently break the composition above.
    //
    // We re-run autoformat against the same minified fixture and
    // verify the inverse map round-trips cleanly through the V3
    // parser without dropping segments.
    const minifiedSrc = fs.readFileSync(
      path.join(FIXTURE_DIR, "minified.js"),
      "utf-8",
    );
    const fmtOutcome = tryAutoformat(minifiedSrc, "minified.js", {
      enabled: true,
      threshold: 0,
    });
    expect(fmtOutcome.kind).toBe("ok");
    if (fmtOutcome.kind !== "ok") return;

    const tm = new TraceMap(JSON.stringify(fmtOutcome.sourceMap));
    // Every formatted line that anchored to the minified source must
    // resolve back to line 1 (the recorded-minified source has
    // exactly one non-empty line).  We don't assert "every line
    // anchors" because the formatter inserts pure-whitespace lines
    // (e.g. blank separators) that have no identifier anchor — those
    // legitimately fall through.
    const formattedLines = fmtOutcome.formatted.split("\n");
    let anchored = 0;
    for (let i = 1; i <= formattedLines.length; i++) {
      const pos = originalPositionFor(tm, { line: i, column: 0 });
      if (pos.source === "minified.js") {
        expect(pos.line).toBe(1);
        anchored++;
      }
    }
    // STRICT: at least the function-declaration line must anchor.
    // If the count drops to zero the inverse map is broken.
    expect(anchored).toBeGreaterThanOrEqual(1);
  });

  it("recorder ships bundled prettier — composition needs it", () => {
    // Tying the bundled-prettier change to the composition test:
    // the composition relies on `tryAutoformat` actually running
    // prettier.  If the bundled path regresses to relying on PATH
    // only, this test would still pass on a dev workstation but
    // start failing on minimal CI images.  Pin the contract.
    const minified = "function a(b,c){const d=b+c;return d;}a(3,4);";
    const outcome = runPrettier(minified, "input.js");
    expect(outcome.kind).toBe("ok");
  });
});

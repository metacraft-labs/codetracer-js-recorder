/**
 * What a level-0 page declares for its session's narrative (CodeTracer's
 * JS-Boundary-Recording specification §9.4, §13): the experiment arms the
 * server rendered it for (`data-ct-arms` on the document element, written as
 * `Env.arms`), the labels of the elements the visitor acts on
 * (`data-ct-label`, written as `Input.label`), and the page's marks
 * (`ct.mark`, written as `Mark`), on the record-and-replay route
 * (`record-replay.ts`).
 *
 * No mocks: the page is recorded in real headless Chromium with the shim
 * installed by the shipped CLI step, and replayed by the real runner.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type BoundaryRecord,
  HOLE_TOKEN,
  type RecordOf,
} from "../../packages/boundary-format/src/index.js";

import {
  type Page,
  type RecordReplay,
  expectReplayed,
  startRecordReplay,
} from "./record-replay.js";

const TIMEOUT = 120_000;

/** The slice of Playwright's page the drive below uses. */
interface TypingPage extends Page {
  type(selector: string, text: string): Promise<void>;
  fill(selector: string, text: string): Promise<void>;
  textContent(selector: string): Promise<string | null>;
}

let rr: RecordReplay;

beforeAll(async () => {
  rr = await startRecordReplay((build) => {
    // A page whose `data-ct-arms` is not an object of strings: its arms are
    // ignored as a whole.
    const html = fs.readFileSync(path.join(build, "declarations.html"), "utf8");
    fs.writeFileSync(
      path.join(build, "declarations-bad-arms.html"),
      html.replace(
        `data-ct-arms='{"checkout":"B","banner":"blue"}'`,
        `data-ct-arms='{"checkout":"B","banner":7}'`,
      ),
    );
  });
}, TIMEOUT);

afterAll(async () => {
  await rr?.close();
});

const SECRET = "ada@example.org";

async function drive(p: Page): Promise<void> {
  const page = p as TypingPage;
  await page.click("#open-text");
  await page.type("#email", "not-an-address");
  await page.click("#pay");
  await page.fill("#email", "");
  await page.type("#email", SECRET);
  await page.click("#pay");
  await page.click("#plain");
  expect(await page.textContent("#status")).toBe("refused 4");
  await page.click("#finish");
}

function inputs(records: BoundaryRecord[]): RecordOf<"Input">[] {
  return records.filter((r): r is RecordOf<"Input"> => r.record === "Input");
}

function marks(records: BoundaryRecord[]): RecordOf<"Mark">[] {
  return records.filter((r): r is RecordOf<"Mark"> => r.record === "Mark");
}

describe("narrative declarations of a level-0 page", () => {
  it(
    "shim_records_declared_arms_labels_and_marks",
    async () => {
      const records = await rr.record("declarations.html", drive);
      const env = records.find((r): r is RecordOf<"Env"> => r.record === "Env");
      // Canonical JSON: keys sorted.
      expect(env?.arms).toBe('{"banner":"blue","checkout":"B"}');

      const clicks = inputs(records).filter((r) => r.type === "click");
      // Vacuity guard: the drive's five clicks are all in the log.
      expect(clicks.map((c) => c.target)).toEqual([
        "path:#open-text",
        "path:#pay",
        "path:#pay",
        "path:#plain",
        "path:#finish",
      ]);
      // The label of the nearest labelled ancestor-or-self; none, empty.
      expect(clicks.map((c) => c.label)).toEqual([
        "Cart",
        "Pay now",
        "Pay now",
        "",
        "Finish",
      ]);
      // A keystroke at the (sensitive) e-mail field is labelled too, and
      // still masked.
      const keys = inputs(records).filter(
        (r) => r.type === "keydown" && r.target === "path:#email",
      );
      expect(new Set(keys.map((k) => k.label))).toEqual(new Set(["E-mail"]));
      // Every typed character masked (clearing the field adds a named key).
      expect(
        keys.filter((k) => JSON.parse(k.props).code === "Masked").length,
      ).toBe("not-an-address".length + SECRET.length);

      // The marks the page made outside a declassifier, in order; the one
      // in the declassifier's body is not logged, and the conversion's data
      // has the field's value holed.
      expect(marks(records).map((m) => [m.name, m.data])).toEqual([
        ["exposure:checkout", '{"arm":"B","at":true}'],
        ["conversion:purchase", JSON.stringify({ quoted: "by " + HOLE_TOKEN })],
        ["no-data", "null"],
      ]);
      const declassified = records.filter(
        (r): r is RecordOf<"Declassify"> => r.record === "Declassify",
      );
      expect(declassified.map((d) => d.output)).toEqual(["false", "true"]);
      // The secret is in no record.
      expect(
        JSON.stringify(records, (_k, v: unknown) =>
          typeof v === "bigint" ? v.toString() : v,
        ),
      ).not.toContain(SECRET);

      // Replay skips the marks and the page's `ct.mark` calls do nothing
      // there (the invalid ones throw as they did), so the session replays.
      expectReplayed(await rr.replay(records), records);
    },
    TIMEOUT,
  );

  it(
    "shim_ignores_arms_that_are_not_an_object_of_strings",
    async () => {
      const records = await rr.record("declarations-bad-arms.html", drive);
      const env = records.find((r): r is RecordOf<"Env"> => r.record === "Env");
      expect(env?.arms).toBe("{}");
      // Positive control: the same page's labels and marks are recorded.
      expect(marks(records).length).toBe(3);
    },
    TIMEOUT,
  );
});

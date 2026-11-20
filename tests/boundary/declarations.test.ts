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
import { createHash } from "node:crypto";
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

/**
 * Valid arms whose experiment keys an ordinary object loses or reorders:
 * `__proto__` (assigning a string to it on an ordinary object creates no
 * member), integer-index keys (an object enumerates them first and
 * numerically, whatever the insertion order) and non-ASCII keys, written as
 * JSON escapes so the page's encoding does not matter: U+00E9, U+FF61 and
 * U+1F600, whose UTF-16 order (U+1F600's lead surrogate 0xD83D sorts before
 * 0xFF61) is not their code-point order.
 */
const ODD_ARMS =
  '{"checkout":"A","__proto__":"B","10":"A","2":"B","\\u00e9":"C",' +
  '"\\uff61":"D","\\ud83d\\ude00":"E","banner":"blue"}';

/**
 * `ODD_ARMS`'s canonical JSON: every member kept, keys sorted by their
 * UTF-16 code units (JavaScript's string order), so "10" before "2".
 */
const ODD_ARMS_CANONICAL =
  '{"10":"A","2":"B","__proto__":"B","banner":"blue","checkout":"A",' +
  '"é":"C","\u{1f600}":"E","｡":"D"}';

let rr: RecordReplay;

const fullArms = Array.from(
  { length: 64 },
  (_, i) => `"experiment${String(i).padStart(2, "0")}":"A"`,
);

/** Expected pairs are explicit, never enumerated through an ordinary object. */
const armCases: { name: string; raw: string | null; expected: string }[] = [
  {
    name: "preserves_own_prototype_named_members",
    raw: '{"toString":"T","constructor":"C","__proto__":"B","hasOwnProperty":"H","checkout":"A"}',
    expected:
      '{"__proto__":"B","checkout":"A","constructor":"C","hasOwnProperty":"H","toString":"T"}',
  },
  {
    name: "serializes_integer_looking_keys_in_lexical_order",
    raw: '{"2":"B","10":"A","1":"one","01":"zero-one","4294967294":"index","4294967295":"text"}',
    expected:
      '{"01":"zero-one","1":"one","10":"A","2":"B","4294967294":"index","4294967295":"text"}',
  },
  {
    name: "sorts_ASCII_BMP_and_astral_keys_by_UTF16",
    raw: '{"\uE000":"bmp","😀":"astral","é":"accent","a":"lower","Z":"upper","A":"first"}',
    expected:
      '{"A":"first","Z":"upper","a":"lower","é":"accent","😀":"astral","\uE000":"bmp"}',
  },
  {
    name: "escapes_keys_and_values_as_JSON_strings",
    raw: '{"quote\\\"":"line\\n\\t\\u0000","back\\\\":"quote\\\" and \' & < >","astral":"😀"}',
    expected:
      '{"astral":"😀","back\\\\":"quote\\\" and \' & < >","quote\\\"":"line\\n\\t\\u0000"}',
  },
  {
    name: "accepts_64_members",
    raw: `{${[...fullArms].reverse().join(",")}}`,
    expected: `{${fullArms.join(",")}}`,
  },
  {
    name: "accepts_256_UTF16_units_in_keys_and_arms",
    raw: `{${JSON.stringify("k".repeat(256))}:${JSON.stringify("😀".repeat(128))}}`,
    expected: `{${JSON.stringify("k".repeat(256))}:${JSON.stringify("😀".repeat(128))}}`,
  },
  { name: "defaults_absent_attribute", raw: null, expected: "{}" },
  { name: "accepts_empty_object", raw: "{}", expected: "{}" },
  ...[
    ["65_members", `{${fullArms.join(",")},"extra":"B"}`],
    ["257_unit_key", `{${JSON.stringify("k".repeat(257))}:"A"}`],
    ["257_unit_arm", `{"valid":"A","bad":${JSON.stringify("a".repeat(257))}}`],
    [
      "astral_key_over_256_units",
      `{${JSON.stringify("😀".repeat(128) + "x")}:"A"}`,
    ],
    [
      "astral_arm_over_256_units",
      `{"bad":${JSON.stringify("😀".repeat(129))}}`,
    ],
    ["empty_key", '{"valid":"A","":"B"}'],
    ["empty_arm", '{"valid":"A","bad":""}'],
    ["number_arm", '{"valid":"A","bad":7}'],
    ["null_arm", '{"valid":"A","bad":null}'],
    ["object_arm", '{"valid":"A","bad":{}}'],
    ["array_arm", '{"valid":"A","bad":[]}'],
    ["boolean_arm", '{"valid":"A","bad":true}'],
    ["prototype_named_invalid_arm", '{"valid":"A","__proto__":7}'],
    ["array", '[["key","arm"]]'],
    ["null", "null"],
    ["string", '"value"'],
    ["number", "7"],
    ["boolean", "false"],
    ["malformed_JSON", '{"valid":"A",'],
  ].map(([name, raw]) => ({
    name: `rejects_whole_object_for_${name}`,
    raw,
    expected: "{}",
  })),
  {
    name: "rejects_whole_object_for_late_number_arm_after_valid_prefix",
    raw: '{"a":"A","z":7}',
    expected: "{}",
  },
  {
    name: "rejects_whole_object_for_late_empty_arm_after_valid_prefix",
    raw: '{"a":"A","z":""}',
    expected: "{}",
  },
  {
    name: "preserves_lone_surrogate_JSON_escaping_and_UTF16_order",
    raw: '{"\\udfff":"\\ud800","\\ud800":"\\udfff"}',
    expected: '{"\\ud800":"\\udfff","\\udfff":"\\ud800"}',
  },
];

beforeAll(async () => {
  let preparedBuild = "";
  rr = await startRecordReplay((build) => {
    preparedBuild = build;
    for (const [index, test] of armCases.entries()) {
      // The HTML parser must receive exactly the raw JSON, including quotes,
      // ampersands and prototype-named own properties, before bootstrap runs.
      const attribute =
        test.raw === null
          ? ""
          : ` data-ct-arms="${test.raw
              .replace(/&/g, "&amp;")
              .replace(/"/g, "&quot;")
              .replace(/</g, "&lt;")}"`;
      const rendered = `<!doctype html><html${attribute}><head><meta charset="utf-8"></head><body><button id="finish">Finish</button><script>document.querySelector('#finish').onclick = () => { document.body.dataset.done = '1'; };</script></body></html>`;
      expect(rendered).toContain(`<html${attribute}><head>`);
      fs.writeFileSync(path.join(build, `arms-${index}.html`), rendered);
    }
    const html = fs.readFileSync(path.join(build, "declarations.html"), "utf8");
    const withArms = (name: string, arms: string): void => {
      const page = html.replace(
        `data-ct-arms='{"checkout":"B","banner":"blue"}'`,
        `data-ct-arms='${arms}'`,
      );
      // Vacuity guard: the variant really declares the arms under test.
      expect(page).toContain(`data-ct-arms='${arms}'`);
      fs.writeFileSync(path.join(build, name), page);
    };
    // A page whose `data-ct-arms` is not an object of strings: its arms are
    // ignored as a whole.
    withArms("declarations-bad-arms.html", '{"checkout":"B","banner":7}');
    // Valid arms that an ordinary object accumulator loses or reorders.
    withArms("declarations-odd-arms.html", ODD_ARMS);
    // A prototype-named experiment whose arm is not a string: the whole
    // object is still ignored.
    withArms(
      "declarations-bad-proto-arms.html",
      '{"__proto__":{"checkout":"B"},"banner":"blue"}',
    );
  });
  const actualRecords = rr.record.bind(rr);
  const observed: Record<string, { arms: string[]; records: string[] }> = {};
  rr.record = async (page, ...args) => {
    const records = await actualRecords(page, ...args);
    observed[page] = {
      arms: records
        .filter((record): record is RecordOf<"Env"> => record.record === "Env")
        .map((record) => record.arms),
      records: records.map((record) => record.record),
    };
    if (process.env.CT_DECLARED_ARMS_CASES)
      fs.writeFileSync(
        process.env.CT_DECLARED_ARMS_CASES,
        JSON.stringify(observed, null, 2),
      );
    return records;
  };
  // The shipped CLI inserted this workspace's real compiled bundle, not a
  // genuine bundle from another variant. These checks precede page recording.
  const bundle = fs.readFileSync(
    path.resolve(
      __dirname,
      "../../packages/boundary-shim/dist/boundary-shim.iife.js",
    ),
    "utf8",
  );
  const escaped = bundle.replace(/<\/(script)/gi, "<\\/$1");
  const pages = armCases.map((_, index) => {
    const html = fs.readFileSync(
      path.join(preparedBuild, `arms-${index}.html`),
      "utf8",
    );
    expect(html).toContain(escaped);
    expect(html.indexOf("data-codetracer-boundary-shim")).toBeLessThan(
      html.indexOf('<button id="finish">'),
    );
    return {
      name: `arms-${index}.html`,
      sha256: createHash("sha256").update(html).digest("hex"),
    };
  });
  if (process.env.CT_DECLARED_ARMS_RECEIPT) {
    fs.writeFileSync(
      process.env.CT_DECLARED_ARMS_RECEIPT,
      JSON.stringify(
        {
          bundleSha256: createHash("sha256").update(bundle).digest("hex"),
          pages,
        },
        null,
        2,
      ),
    );
  }
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
  for (const [index, test] of armCases.entries()) {
    it(
      `shim_arms_${test.name}`,
      async () => {
        const records = await rr.record(`arms-${index}.html`, async (page) => {
          const reader = page as Page & {
            locator(selector: string): {
              getAttribute(name: string): Promise<string | null>;
            };
          };
          expect(
            await reader.locator("html").getAttribute("data-ct-arms"),
          ).toBe(test.raw);
          await page.click("#finish");
        });
        const envs = records.filter(
          (r): r is RecordOf<"Env"> => r.record === "Env",
        );
        expect(envs).toHaveLength(1);
        const actual = JSON.parse(envs[0].arms) as Record<string, string>;
        const expected = JSON.parse(test.expected) as Record<string, string>;
        for (const [key, arm] of Object.entries(expected)) {
          expect(Object.prototype.hasOwnProperty.call(actual, key)).toBe(true);
          expect(actual[key]).toBe(arm);
        }
        expect(envs[0].arms).toBe(test.expected);
        expect(Object.keys(actual)).toHaveLength(Object.keys(expected).length);
        expect(
          inputs(records).some(
            (r) => r.type === "click" && r.target === "path:#finish",
          ),
        ).toBe(true);
        expect(records.some((r) => r.record === "Checkpoint")).toBe(true);
        expect(records.at(-1)?.record).toBe("End");
        expectReplayed(await rr.replay(records), records);
      },
      TIMEOUT,
    );
  }

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

  it(
    "shim_keeps_prototype_named_numeric_and_unicode_arms_in_canonical_order",
    async () => {
      const records = await rr.record("declarations-odd-arms.html", drive);
      const env = records.find((r): r is RecordOf<"Env"> => r.record === "Env");
      expect(env?.arms).toBe(ODD_ARMS_CANONICAL);
      // Every member the page declared, and no other (JSON.parse creates
      // `__proto__` as an own member).
      const members = (json: string): [string, unknown][] =>
        Object.entries(JSON.parse(json) as object).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        );
      expect(members(env?.arms ?? "{}")).toEqual(members(ODD_ARMS));
      expect(members(ODD_ARMS).length).toBe(8);
      expectReplayed(await rr.replay(records), records);
    },
    TIMEOUT,
  );

  it(
    "shim_ignores_arms_whose_prototype_named_arm_is_not_a_string",
    async () => {
      const records = await rr.record(
        "declarations-bad-proto-arms.html",
        drive,
      );
      const env = records.find((r): r is RecordOf<"Env"> => r.record === "Env");
      expect(env?.arms).toBe("{}");
      // Positive control: the same page's labels and marks are recorded.
      expect(marks(records).length).toBe(3);
    },
    TIMEOUT,
  );
});

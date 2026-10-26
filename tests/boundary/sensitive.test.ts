/**
 * Sensitive inputs, declassification and scrubbing (CodeTracer's
 * JS-Boundary-Recording specification §11.3, §5.2 `Declassify`, §5.2.1, §7.2
 * `cause`, §9.9's non-interference leg), recorded for real and replayed by the
 * real runner.
 *
 * Two routes record here:
 *
 * - the upload route: `fixtures/sensitive-upload.html` with the shim
 *   installed by the shipped deploy step (`boundary-shim --ingest`), driven
 *   in headless Chromium, uploading to a local stub ingest; what the stub
 *   received (the raw batch bodies) and what codetracer's real `ct-jsbound
 *   assemble` makes of them (the assembled container) are searched;
 * - the record-and-replay route (`record-replay.ts`): `fixtures/sensitive.html`
 *   recorded with the log kept in the page, replayed by `replaySession`.
 *
 * Mocks, each justified:
 * - **The ingest is the local stub** (`stub-ingest.ts`), as for the transport
 *   tests: the real ingest is CodeTracer's service, tested against the
 *   shared batch vectors on its side; the stub's `config` answer here
 *   carries the site's scrub lists as the ingest's does.
 *
 * The non-interference leg runs the conformance suite's command line on the
 * suite's own generic and reference builds, and on the builds that carry the
 * raw-read fault, which it must reject.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type BoundaryRecord,
  HOLE_TOKEN,
  type RecordOf,
} from "../../packages/boundary-format/src/index.js";
import {
  buildGenericFixtures,
  buildReferenceFixtures,
  type NoninterferenceReport,
  ROUTES,
} from "../../packages/boundary-conformance/src/index.js";
import {
  loadBoundaryLog,
  seqAt,
  withoutRecord,
  withRecordBefore,
} from "../../packages/boundary-replay/src/index.js";
import {
  copyFixtures,
  FIXTURE_BUILD_HASH,
  type FixtureServer,
  startFixtureServer,
} from "./harness.js";
import {
  expectDiverged,
  expectReplayed,
  indexWhere,
  isDone,
  type RecordReplay,
  replaced,
  startRecordReplay,
  until,
} from "./record-replay.js";
import { ctJsboundPath, RECORDING_ID } from "./siblings.js";
import { type StubIngest, startStubIngest } from "./stub-ingest.js";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const CLI = path.join(REPO_ROOT, "packages", "cli", "dist", "index.js");
const CONFORMANCE_CLI = path.join(
  REPO_ROOT,
  "packages/boundary-conformance/dist/cli.js",
);
const TIMEOUT = 300_000;

/** The slice of Playwright's page these tests drive. */
interface SPage {
  goto(url: string): Promise<unknown>;
  type(selector: string, text: string): Promise<void>;
  fill(selector: string, text: string): Promise<void>;
  press(selector: string, key: string): Promise<void>;
  click(selector: string): Promise<void>;
  evaluate<T>(fn: () => T): Promise<T>;
  keyboard: { type(text: string): Promise<void> };
}
interface SContext {
  newPage(): Promise<SPage>;
  close(): Promise<void>;
}

let rr: RecordReplay;
let CT_JSBOUND: string;
const tmpDirs: string[] = [];
const closers: { close(): Promise<void> }[] = [];

function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

beforeAll(async () => {
  CT_JSBOUND = ctJsboundPath();
  rr = await startRecordReplay();
}, TIMEOUT);

afterAll(async () => {
  for (const c of closers) await c.close();
  await rr?.close();
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

// ── The upload route ────────────────────────────────────────────────────

/** What one uploaded session left: the bodies, and what they assemble to. */
interface Uploaded {
  /** Every batch body the stub ingest received, as received. */
  bodies: Uint8Array[];
  /** The container `ct-jsbound assemble` made of them. */
  container: Uint8Array;
  /** Its log, decoded strictly by the canonical reader. */
  records: BoundaryRecord[];
  /** Whatever `inspect` read of the page before the session stopped. */
  inspected: unknown;
}

/**
 * Record `sensitive-upload.html?<query>` with the shim uploading to a stub
 * ingest whose `config` is `config`, drive it, wait until it is done, stop
 * the session, and assemble what was uploaded.
 */
async function upload(
  query: string,
  drive: (page: SPage) => Promise<void>,
  config: unknown = { enabled: true },
  inspect: () => unknown = () => null,
): Promise<Uploaded> {
  const stub: StubIngest = await startStubIngest(config);
  closers.push(stub);
  const dir = copyFixtures();
  tmpDirs.push(dir);
  execFileSync(
    process.execPath,
    [
      CLI,
      "boundary-shim",
      path.join(dir, "sensitive-upload.html"),
      "--build-hash",
      FIXTURE_BUILD_HASH,
      "--ingest",
      stub.base,
    ],
    { stdio: "pipe" },
  );
  const server: FixtureServer = await startFixtureServer(dir);
  closers.push(server);
  const context = (await rr.browser.newContext()) as unknown as SContext;
  let inspected: unknown;
  try {
    const page = await context.newPage();
    await page.goto(`${server.origin}/sensitive-upload.html?${query}`);
    await drive(page);
    await until(page, isDone, `sensitive-upload.html?${query} to finish`);
    inspected = await page.evaluate(inspect);
    await page.evaluate(() =>
      (
        globalThis as unknown as { __ctBoundaryShim: { stop(): Promise<void> } }
      ).__ctBoundaryShim.stop(),
    );
  } finally {
    await context.close();
  }
  const bodies = stub.batches.map((b) => b.body);
  expect(bodies.length).toBeGreaterThan(0);
  const batchDir = tmp("ct-sensitive-batches-");
  bodies.forEach((b, i) => fs.writeFileSync(path.join(batchDir, String(i)), b));
  const out = path.join(tmp("ct-sensitive-ct-"), "session.ct");
  const r = spawnSync(
    CT_JSBOUND,
    ["assemble", "--recording-id", RECORDING_ID, "--out", out, batchDir],
    { encoding: "utf-8" },
  );
  if (r.status !== 0) {
    throw new Error(`ct-jsbound assemble failed (${r.status}): ${r.stderr}`);
  }
  return {
    bodies,
    container: new Uint8Array(fs.readFileSync(out)),
    records: loadBoundaryLog(out).records,
    inspected,
  };
}

/** The forms a value may be written in: raw, URL-encoded and JSON-escaped. */
function forms(s: string): string[] {
  return [
    ...new Set([s, encodeURIComponent(s), JSON.stringify(s).slice(1, -1)]),
  ];
}

/**
 * Whether `s`, in any of its {@link forms}, occurs in any of `blobs`: one
 * search, used for what must be absent and, as the vacuity guard, for what
 * must be present (a search that reads nothing passes every "absent"
 * check).
 */
function found(blobs: readonly Uint8Array[], s: string): boolean {
  const needles = forms(s).map((f) => Buffer.from(f, "utf8"));
  return blobs.some((b) => {
    const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
    return needles.some((n) => buf.includes(n));
  });
}

const inputsAt = (records: BoundaryRecord[], target: string, type: string) =>
  records.filter(
    (r): r is RecordOf<"Input"> =>
      r.record === "Input" && r.target === target && r.type === type,
  );

const propsOf = (r: RecordOf<"Input">) =>
  JSON.parse(r.props) as Record<string, unknown>;

const scrubbedAt = (records: BoundaryRecord[], target: string) =>
  records.filter(
    (r): r is RecordOf<"Scrubbed"> =>
      r.record === "Scrubbed" && r.target === target,
  );

const valuesAt = (records: BoundaryRecord[], target: string) =>
  records.filter(
    (r): r is RecordOf<"DomEffect"> =>
      r.record === "DomEffect" && r.target === target && r.effect === 1,
  );

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

describe("sensitive inputs on the upload route", () => {
  it(
    "sensitive_value_never_in_uploaded_bytes",
    async () => {
      // The secret has characters that URL-encoding and JSON-escaping
      // change, so each form is searched for.
      const SECRET = 'Zk9"q&w/m';
      // The vacuity guard's string: typed into the public field, the same
      // search must find it (a distinct unique string: the secret itself is
      // what must be absent from the same bytes).
      const PUBLIC = 'Pb4"x&y/n';
      const sensitive = ["pw", "cc", "ds", "cs", "plain"];
      const up = await upload("case=fields", async (page) => {
        for (const id of sensitive) {
          await page.type(`#${id}`, SECRET);
          // Named keys: Backspace, then the last character again, and Tab.
          await page.press(`#${id}`, "Backspace");
          await page.type(`#${id}`, SECRET.slice(-1));
          await page.press(`#${id}`, "Tab");
        }
        await page.press("#plain", "Enter");
        await page.type("#pub", PUBLIC);
        await page.click("#send");
      });
      const blobs = [...up.bodies, up.container];

      // Vacuity guard: the same search finds the public field's string, in
      // the bodies and in the container, the two things searched below.
      expect(found(up.bodies, PUBLIC)).toBe(true);
      expect(found([up.container], PUBLIC)).toBe(true);
      // The secret, in every form, in no batch and not in the container.
      for (const f of forms(SECRET)) {
        expect(found(blobs, f), f).toBe(false);
      }

      // The keystrokes: printable keys masked, named keys verbatim.
      let masked = 0;
      for (const id of sensitive) {
        const target = `path:#${id}`;
        const downs = inputsAt(up.records, target, "keydown");
        const printable = downs.filter((d) => propsOf(d).key === "*");
        masked += printable.length;
        for (const d of printable) expect(propsOf(d).code).toBe("Masked");
        const named = downs
          .map(propsOf)
          .filter((p) => p.key !== "*")
          .map((p) => `${p.key}/${p.code}`);
        expect(named, id).toEqual(
          id === "plain"
            ? ["Backspace/Backspace", "Tab/Tab", "Enter/Enter"]
            : ["Backspace/Backspace", "Tab/Tab"],
        );
        for (const i of inputsAt(up.records, target, "input")) {
          const data = propsOf(i).data;
          expect(data === null || data === "*", `${id}: ${data}`).toBe(true);
        }
        // The value is never a DomEffect; a Scrubbed of its length is.
        expect(valuesAt(up.records, target), id).toEqual([]);
        const scrubbed = scrubbedAt(up.records, target);
        expect(scrubbed.at(-1)?.length, id).toBe(SECRET.length);
        expect(scrubbed.at(-1)?.class, id).toBe(
          { pw: 1, cc: 2, ds: 4, cs: 4, plain: 4 }[id],
        );
      }
      // Vacuity guard: the masked-key count is the scripted printable count.
      expect(masked).toBe(sensitive.length * (SECRET.length + 1));

      // What the page sent is logged in holed form (§5.2.1).
      const requests = up.records.filter(
        (r): r is RecordOf<"NetRequest"> => r.record === "NetRequest",
      );
      expect(requests.map((r) => r.url)).toEqual(
        expect.arrayContaining([
          expect.stringContaining(`/api/data?q=${HOLE_TOKEN}`),
        ]),
      );
      const post = requests.find((r) => r.method === "POST")!;
      expect(post.body_digest).toBe(
        sha256(JSON.stringify({ pw: HOLE_TOKEN, cc: HOLE_TOKEN })),
      );
    },
    TIMEOUT,
  );

  it(
    "sensitive_text_in_shadow_trees_and_editable_regions_never_uploaded",
    async () => {
      // No character that URL-encoding, JSON-escaping or the error
      // template changes: an unholed copy would be found verbatim.
      const SECRET = "Qx7tz-mirror";
      // One secret per shadow-tree field, so that each is holed in the URL
      // only if its own field was found (not by another field's value).
      const OPEN = "Ow5kd-opened";
      const CLOSED = "Cj8rv-closed";
      const PUBLIC = "Pv3wy-public";
      const up = await upload(
        "case=shadow",
        async (page) => {
          // A password in an open shadow root: Playwright's selector
          // pierces it, the window's listeners see the host.
          await page.type("#spw", OPEN);
          // An undeclared text field in a closed shadow root.
          await page.evaluate(() =>
            (
              globalThis as unknown as { __closedInput: HTMLElement }
            ).__closedInput.focus(),
          );
          await page.keyboard.type(CLOSED);
          await page.type("#ed", SECRET);
          await page.type("#edpub", PUBLIC);
          await page.type("#mir", SECRET);
          await page.type("#ta", SECRET);
          await page.click("#send");
        },
        { enabled: true },
        () => (globalThis as unknown as { __mutations: number }).__mutations,
      );
      const blobs = [...up.bodies, up.container];

      // Vacuity guards: the page's observer was handed records, and what was
      // typed into the public region (its mutation records' text) is found
      // by the same search, in the bodies and in the container.
      expect(up.inspected).toBeGreaterThan(SECRET.length);
      expect(found(up.bodies, PUBLIC)).toBe(true);
      expect(found([up.container], PUBLIC)).toBe(true);
      // The secrets, in every form, in no batch and not in the container.
      for (const secret of [SECRET, OPEN, CLOSED]) {
        for (const f of forms(secret)) {
          expect(found(blobs, f), f).toBe(false);
        }
      }

      // The keystrokes behind both shadow roots are masked, though their
      // events reach the window at the hosts.
      for (const host of ["path:#openhost", "path:#closedhost"]) {
        const keys = inputsAt(up.records, host, "keydown").map(
          (r) => propsOf(r).key,
        );
        expect(keys, host).toEqual(Array(OPEN.length).fill("*"));
      }
      // The editable region's text: a Scrubbed of its length, no value.
      expect(scrubbedAt(up.records, "path:#ed").at(-1)).toMatchObject({
        class: 4,
        length: SECRET.length,
      });
      expect(scrubbedAt(up.records, "path:#edpub")).toEqual([]);
      // The observer's records of the sensitive fields are written, holed.
      const mutations = up.records.filter(
        (r): r is RecordOf<"PlatformValue"> =>
          r.record === "PlatformValue" && r.src === 3,
      );
      expect(mutations.some((r) => r.value.includes(HOLE_TOKEN))).toBe(true);
      // What the page sent and the error it raised hold the hole.
      const request = up.records.find(
        (r): r is RecordOf<"NetRequest"> =>
          r.record === "NetRequest" && r.url.includes("/api/data"),
      )!;
      expect(request.url).toContain(
        `?e=${HOLE_TOKEN}&o=${HOLE_TOKEN}&c=${HOLE_TOKEN}`,
      );
      expect(
        up.records
          .filter((r): r is RecordOf<"Error"> => r.record === "Error")
          .map((e) => e.message),
      ).toEqual([`Uncaught Error: rejected ${HOLE_TOKEN}`]);
    },
    TIMEOUT,
  );

  it(
    "shim_public_opt_out_and_credential_refusal",
    async () => {
      const up = await upload(
        "case=optout",
        async (page) => {
          await page.type("#pub", "pubtextone");
          await page.type("#pubattr", "pubtexttwo");
          await page.type("#cc2", "4111111111111111");
          await page.type("#neg", "negtextfour");
          await page.click("#check");
          await page.evaluate(() =>
            document.body.setAttribute("data-done", "1"),
          );
        },
        { enabled: true },
        () =>
          (globalThis as unknown as { __publicThrew: unknown }).__publicThrew,
      );
      // ct.public() on a password and on a one-time-code field throws.
      expect(up.inspected).toEqual({ pw2: true, otp: true });

      // The public fields: verbatim values, unmasked keys, no Scrubbed.
      for (const [id, text] of [
        ["pub", "pubtextone"],
        ["pubattr", "pubtexttwo"],
      ]) {
        const target = `path:#${id}`;
        expect(
          valuesAt(up.records, target)
            .map((r) => JSON.parse(r.value))
            .at(-1),
        ).toBe(text);
        expect(scrubbedAt(up.records, target)).toEqual([]);
        const keys = inputsAt(up.records, target, "keydown").map(
          (r) => propsOf(r).key,
        );
        expect(keys.join("")).toBe(text);
        const codes = inputsAt(up.records, target, "keydown").map(
          (r) => propsOf(r).code,
        );
        expect(codes).not.toContain("Masked");
        const data = inputsAt(up.records, target, "input").map(
          (r) => propsOf(r).data,
        );
        expect(data.join("")).toBe(text);
      }

      // data-ct-public on a card field is ignored; the field with no marking
      // is masked and scrubbed (the negative control): the marking is what
      // changed the public fields' records.
      for (const [id, cls, text] of [
        ["cc2", 2, "4111111111111111"],
        ["neg", 4, "negtextfour"],
      ] as const) {
        const target = `path:#${id}`;
        expect(valuesAt(up.records, target)).toEqual([]);
        expect(scrubbedAt(up.records, target).at(-1)).toMatchObject({
          class: cls,
          length: text.length,
        });
        const keys = inputsAt(up.records, target, "keydown").map(
          (r) => propsOf(r).key,
        );
        expect(keys).toEqual(Array(text.length).fill("*"));
        expect(found(up.bodies, text)).toBe(false);
      }

      // A checkbox with no declaration: its checked state verbatim.
      const checked = up.records.filter(
        (r): r is RecordOf<"DomEffect"> =>
          r.record === "DomEffect" &&
          r.target === "path:#check" &&
          r.effect === 2,
      );
      expect(checked.map((r) => r.value)).toContain("true");
      expect(scrubbedAt(up.records, "path:#check")).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    "scrubbed_headers_and_url_tokens_never_uploaded",
    async () => {
      const JWT1 =
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvbmUifQ.c2lnbmF0dXJlLW9uZS1hYmM";
      const JWT2 =
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0d28ifQ.c2lnbmF0dXJlLXR3by14eXo";
      const JWT3 =
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0aHJlZSJ9.c2lnbmF0dXJlLXRocmVlLXE";
      const up = await upload(
        // The page's own URL carries a JWT and a value of a key only the
        // site lists (`sid`): `Env` is written before the configuration
        // arrives, so its scrubbing by the site's list is the transport's
        // rewrite of the frames it held.
        `case=headers&access_token=${JWT1}&sid=plainsid123`,
        async (page) => {
          await page.click("#send");
        },
        {
          enabled: true,
          scrub_headers: ["X-Site-Secret"],
          scrub_query_keys: ["sid"],
        },
      );
      const blobs = [...up.bodies, up.container];
      // Positive control: a header nobody lists is uploaded, so the search
      // reads the headers.
      expect(found(up.bodies, "plain-header-value-77")).toBe(true);
      for (const secret of [
        JWT1,
        JWT2,
        JWT3,
        "plainsid123",
        // The request's own Authorization and Cookie are never logged.
        "req-authz-91c3d7",
        "cookie-val-5544e1",
        // The response's credential, proxy and site-listed headers.
        "resp-authz-6f2b9c41",
        "7d3e0a55",
        "proxy-realm-8a1c",
        "site-secret-4e9d21",
      ]) {
        expect(found(blobs, secret), secret).toBe(false);
      }
      const env = up.records[1] as RecordOf<"Env">;
      expect(env.url).toContain("access_token=<scrubbed>&sid=<scrubbed>");
      const response = up.records.find(
        (r): r is RecordOf<"NetResponse"> =>
          r.record === "NetResponse" && r.url.includes("/api/headers"),
      )!;
      expect(response.url).toContain("token=<scrubbed>");
      const names = (JSON.parse(response.headers) as [string, string][]).map(
        ([n]) => n,
      );
      expect(names).toContain("x-plain");
      for (const n of [
        "authorization",
        "cookie",
        "proxy-authenticate",
        "x-site-secret",
      ]) {
        expect(names).not.toContain(n);
      }
      const nav = up.records.find(
        (r): r is RecordOf<"Navigation"> =>
          r.record === "Navigation" && r.kind === 1,
      )!;
      expect(nav.url).toContain("jwt=<scrubbed>");
    },
    TIMEOUT,
  );

  it(
    "error_messages_are_templated_before_upload",
    async () => {
      const up = await upload("case=error", async (page) => {
        await page.click("#send");
      });
      const errors = up.records.filter(
        (r): r is RecordOf<"Error"> => r.record === "Error",
      );
      expect(errors.map((e) => e.message)).toEqual([
        "Uncaught Error: Login failed for <email> after <num> attempts",
      ]);
      expect(errors[0].kind).toBe(1);
      expect(found(up.bodies, "ada@example.com")).toBe(false);
      expect(found(up.bodies, "after 3 attempts")).toBe(false);
      // Vacuity guard: the template's own words are in the bodies.
      expect(found(up.bodies, "Login failed for <email>")).toBe(true);
    },
    TIMEOUT,
  );
});

// ── The record-and-replay route ────────────────────────────────────────

/** The e-mail case, recorded once for the two declassifier tests. */
let emailSession:
  | { records: BoundaryRecord[]; recordCalls: number }
  | undefined;

async function recordEmail(): Promise<{
  records: BoundaryRecord[];
  recordCalls: number;
}> {
  if (emailSession !== undefined) return emailSession;
  let recordCalls = -1;
  const records = await rr.record("sensitive.html?case=email", async (p) => {
    const page = p as unknown as SPage;
    // Not an address, then one: the declassifier answers false, then true.
    // The first is long enough that its placeholder (`x…x@x.invalid`, the
    // e-mail class's) is itself an address.
    await page.type("#email", "ada-at-example.org");
    await page.click("#check");
    await page.fill("#email", "");
    await page.type("#email", "ada@example.org");
    await page.click("#check");
    recordCalls = await page.evaluate(() =>
      (
        globalThis as unknown as { __declassifierCalls(): number }
      ).__declassifierCalls(),
    );
    await page.click("#finish");
  });
  emailSession = { records, recordCalls };
  return emailSession;
}

describe("sensitive inputs on the record-and-replay route", () => {
  it(
    "declassify_replays_logged_output_not_function",
    async () => {
      const { records, recordCalls } = await recordEmail();
      const declassified = records.filter(
        (r): r is RecordOf<"Declassify"> => r.record === "Declassify",
      );
      expect(declassified.map((d) => [d.fn_id, d.output])).toEqual([
        ["isValidEmail", "false"],
        ["isValidEmail", "true"],
      ]);
      // The record side ran the body once per Declassify record.
      expect(recordCalls).toBe(declassified.length);
      // The field's values were never logged: Scrubbed, e-mail class.
      expect(valuesAt(records, "path:#email")).toEqual([]);
      expect(scrubbedAt(records, "path:#email").at(-1)).toMatchObject({
        class: 3,
        length: "ada@example.org".length,
      });

      const report = await rr.replay(records);
      expectReplayed(report, records);
      // The replay-side count, raised by the page in its last task: the
      // body never ran. The log holds the message as a template, so the
      // replay's message matched it whatever the count.
      expect(report.pageErrors).toContain("declassifier-calls=0");
      const error = records.find(
        (r): r is RecordOf<"Error"> => r.record === "Error",
      );
      expect(error?.message).toBe("Uncaught Error: declassifier-calls=<num>");
    },
    TIMEOUT,
  );

  it(
    "declassify_identity_and_order_are_asserted",
    async () => {
      const { records } = await recordEmail();
      const at = indexWhere(records, "Declassify");
      const seq = seqAt(records, at);

      // Negative control: the unedited log replays clean in this run.
      expectReplayed(await rr.replay(records), records);

      // Its identity changed: the page's call names another declassifier.
      expectDiverged(
        await rr.replay(
          replaced<"Declassify">(records, at, { fn_id: "isValidEmail2" }),
        ),
        "ArgumentMismatch",
        seq,
      );
      // Removed: the page calls a declassifier where the log has the next
      // record.
      expectDiverged(
        await rr.replay(withoutRecord(records, at)),
        "ExtraRead",
        seq,
      );
      // Duplicated: a Declassify the page never makes comes due.
      expectDiverged(
        await rr.replay(withRecordBefore(records, at + 1, records[at])),
        "MissingRead",
        (BigInt(seq) + 1n).toString(),
      );
    },
    TIMEOUT,
  );

  it(
    "placeholder_request_matches_holed_digest",
    async () => {
      const records = await rr.record(
        "sensitive.html?case=login",
        async (p) => {
          const page = p as unknown as SPage;
          await page.type("#pw", "hunter2!x");
          await page.click("#login");
        },
      );
      // Replayed with a placeholder in the field: the request it makes holes
      // to the same form, so no ArgumentMismatch.
      expectReplayed(await rr.replay(records), records);
      // The form both sides hole to: the token in the query, the digest
      // over the holed JSON body.
      const request = records.find(
        (r): r is RecordOf<"NetRequest"> => r.record === "NetRequest",
      )!;
      expect(request.url).toContain(`/api/data?pin=${HOLE_TOKEN}`);
      expect(request.body_digest).toBe(
        sha256(JSON.stringify({ user: "ada", pass: HOLE_TOKEN })),
      );
    },
    TIMEOUT,
  );

  it(
    "mirrored_and_editable_sensitive_text_replays_with_placeholders",
    async () => {
      // A value the page mirrors into the DOM (a field's `value` attribute,
      // a textarea's text) and the text of an editable region: never in the
      // log, so the checkpoints and the page's mutation records must hold
      // them as holes for a replay with placeholders to match.
      const SECRET = "Qx7tz-mirror";
      const records = await rr.record(
        "sensitive.html?case=mirror",
        async (p) => {
          const page = p as unknown as SPage;
          await page.type("#mir", SECRET);
          await page.type("#ta", SECRET);
          await page.type("#ed", SECRET);
          await page.click("#finish");
        },
      );
      const text = records
        .map((r) =>
          JSON.stringify(r, (_k, v: unknown) =>
            typeof v === "bigint" ? v.toString() : v,
          ),
        )
        .join("\n");
      // Vacuity guard: the page's observer records of the mirrored fields
      // are in the log (holed) ...
      expect(
        records.some(
          (r) =>
            r.record === "PlatformValue" &&
            r.src === 3 &&
            r.value.includes(HOLE_TOKEN),
        ),
      ).toBe(true);
      // ... and the secret is in no record.
      expect(text.includes(SECRET)).toBe(false);
      expect(scrubbedAt(records, "path:#ed").at(-1)).toMatchObject({
        class: 4,
        length: SECRET.length,
      });
      // Replayed with placeholders: every checkpoint and every mutation
      // record matches.
      expectReplayed(await rr.replay(records), records);
    },
    TIMEOUT,
  );

  it(
    "divergence_cause_distinguishes_substituted_sensitive",
    async () => {
      // A branch on the raw value's first character: replay substitutes a
      // placeholder, takes the other branch, and misses the Random read.
      const branch = await rr.record(
        "sensitive.html?case=branch",
        async (p) => {
          const page = p as unknown as SPage;
          await page.type("#pin", "7123");
          await page.click("#go");
          await page.click("#finish");
        },
      );
      const random = indexWhere(branch, "Random");
      const click = indexWhere(
        branch,
        "Input",
        (r) => r.type === "click" && r.target === "path:#go",
      );
      const report = await rr.replay(branch);
      expectDiverged(report, "MissingRead", seqAt(branch, random));
      expect(report.divergence?.cause).toBe("substituted-sensitive");
      expect(report.divergence?.sensitiveRead).toMatchObject({
        target: "path:#pin",
        what: "value",
        afterSeq: seqAt(branch, click),
      });
      expect(report.divergence?.sensitiveRead?.frames.length).toBeGreaterThan(
        0,
      );

      // An edited Random with no sensitive read: a real mismatch.
      const roll = await rr.record("sensitive.html?case=roll", async (p) => {
        const page = p as unknown as SPage;
        await page.click("#roll");
        await page.click("#finish");
      });
      const r = indexWhere(roll, "Random");
      const edited = replaced<"Random">(roll, r, {
        bytes: new Uint8Array(8).fill(0x3f),
      });
      const mismatch = await rr.replay(edited);
      expect(mismatch.status).toBe("diverged");
      expect(mismatch.divergence?.kind).toBe("CheckpointMismatch");
      expect(mismatch.divergence?.cause).toBe("mismatch");
      expect(mismatch.divergence?.sensitiveRead).toBeNull();
    },
    TIMEOUT,
  );
});

// ── The conformance suite's non-interference leg ────────────────────────

/** Run `ct-boundary-conformance noninterference` on `build`. */
function runNoninterference(
  build: string,
  level: 0 | 1,
): { status: number | null; report: NoninterferenceReport; stderr: string } {
  const out = path.join(tmp("ct-ni-report-"), "report.json");
  const r = spawnSync(
    process.execPath,
    [
      CONFORMANCE_CLI,
      "noninterference",
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
    report: JSON.parse(fs.readFileSync(out, "utf-8")) as NoninterferenceReport,
    stderr: r.stderr,
  };
}

/** The suite's generic build, installed by the shipped deploy route. */
async function genericBuild(leakRawRead: boolean): Promise<string> {
  const dir = path.join(tmp("ct-ni-generic-"), "site");
  await buildGenericFixtures(dir, { leakRawRead });
  const hash = execFileSync(process.execPath, [CLI, "bundle-manifest", dir], {
    encoding: "utf-8",
  }).trim();
  execFileSync(
    process.execPath,
    [
      CLI,
      "boundary-shim",
      dir,
      "--build-hash",
      hash,
      "--ingest",
      ROUTES.ingest,
    ],
    { stdio: "pipe" },
  );
  return dir;
}

const statusOf = (report: NoninterferenceReport) =>
  report.fixtures.flatMap((f) =>
    f.checks.map((c) => `${f.name} ${c.name} ${c.status}`),
  );

describe("the non-interference leg", () => {
  it(
    "conformance_noninterference_passes_shim_and_reference",
    async () => {
      const fixtures = ["sensitive-login", "sensitive-email", "sensitive-pin"];
      const passing = (level: 0 | 1) =>
        fixtures.flatMap((f) => [
          `${f} recordings pass`,
          `${f} declaration ${level === 0 ? "not-applicable-at-level-0" : "pass"}`,
          // The vacuity guard: the two logs are not byte-identical (some
          // Declassify.output differs) and the public probe is found.
          `${f} vacuity pass`,
          `${f} differs-only-in-declassify pass`,
          `${f} no-secret-in-batches pass`,
          `${f} replay-a pass`,
          `${f} replay-b pass`,
        ]);

      const generic = runNoninterference(await genericBuild(false), 0);
      expect(statusOf(generic.report), generic.stderr).toEqual(passing(0));
      expect(generic.status).toBe(0);
      const reference = path.join(tmp("ct-ni-reference-"), "site");
      await buildReferenceFixtures(reference);
      const ref = runNoninterference(reference, 1);
      expect(statusOf(ref.report), ref.stderr).toEqual(passing(1));
      expect(ref.status).toBe(0);

      // The falsifier: a component that branches a request's URL on the
      // raw value's first character makes the comparison fail, naming the
      // first record that differs; both levels.
      const leakyGeneric = runNoninterference(await genericBuild(true), 0);
      const leakyReference = path.join(tmp("ct-ni-reference-leak-"), "site");
      await buildReferenceFixtures(leakyReference, { leakRawRead: true });
      const leakyRef = runNoninterference(leakyReference, 1);
      for (const run of [leakyGeneric, leakyRef]) {
        expect(run.status).toBe(1);
        const check = run.report.fixtures
          .find((f) => f.name === "sensitive-login")!
          .checks.find((c) => c.name === "differs-only-in-declassify")!;
        expect(check.status).toBe("fail");
        expect(check.detail.join(" ")).toMatch(
          /^record \d+ differs beyond Declassify\.output: with X \{"record":"NetRequest".*first=a.*with Y \{"record":"NetRequest".*first=b/,
        );
      }

      // A framework that ignores the declaration records the value: the
      // scan finds the secret (the reference's seeded defect).
      const ignoring = path.join(tmp("ct-ni-reference-ignore-"), "site");
      await buildReferenceFixtures(ignoring, { leakSensitive: true });
      const ignored = runNoninterference(ignoring, 1);
      expect(ignored.status).toBe(1);
      expect(statusOf(ignored.report)).toEqual(
        expect.arrayContaining([
          "sensitive-login no-secret-in-batches fail",
          "sensitive-email no-secret-in-batches fail",
          "sensitive-pin differs-only-in-declassify fail",
        ]),
      );
    },
    TIMEOUT * 2,
  );
});

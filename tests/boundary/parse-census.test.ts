/**
 * The census a document position is counted with while the document parses
 * (`packages/boundary-shim/src/browser/parse-census.ts`) counts exactly what
 * the whole-document measure counts (`DocumentProgress.fullPosition`, the
 * definition of CodeTracer's JS-Boundary-Recording specification §6, "The
 * position"), at every point a recorder or the replay runner can ask: in
 * page scripts while the parser runs them, and in timers that run while the
 * parser waits for the network, inside a run of text included.
 *
 * A page is served in pieces by a real HTTP server, in real headless
 * Chromium, with `DocumentProgress` (bundled from its source) made by an
 * init script before any page code, as the shim and the replay runtime make
 * it. Every check compares `position()` (the census, while the document
 * parses) with `fullPosition()`. The page makes the trees the census must
 * follow: text and comments the parser appends to, foster-parented text and
 * elements, misnested formatting elements (the adoption agency, which moves
 * nodes), and page scripts that grow and change character data, add and
 * remove nodes, set `innerHTML`, move a node, `document.write`, add a
 * `<template>` and a declarative shadow root (neither counted), add and
 * remove one of CodeTracer's own scripts and change its text, change a
 * script's `type` and markers, an SVG `<script>`, an external script that
 * settles, a module script, and a `<textarea>` cut by the network. And the
 * census answers without reading a live collection's length (which Blink
 * answers by counting the document again after any change to it), which the
 * whole-document measure does at every question.
 *
 * Negative controls: the same page with the census made to ignore character
 * data changes, or removals, reports mismatches, so the comparison
 * discriminates.
 *
 * The server holds each cut until the page reports that its timer ran with
 * the parser stopped at that cut (see {@link GAPS}), so that the timer checks
 * in each wait happen however little CPU the host grants the renderer. A
 * fixed wait would leave their number to the scheduler: on a loaded CI host,
 * three 300 ms waits once granted the 1 ms timer four turns in all.
 *
 * No mocks: the server, the browser and the census are real.
 */

import * as http from "node:http";
import * as path from "node:path";
import * as esbuild from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type Browser,
  loadPlaywright,
} from "../../packages/boundary-replay/src/index.js";

const TIMEOUT = 120_000;
const REPO_ROOT = path.resolve(__dirname, "..", "..");

/** Where the server cuts the page; it sends the rest when the page reports. */
const CUT = "<!--ct:chunk-->";

/**
 * How the page tells, in its timer, which cut the parser is stopped at: the
 * last condition that holds names it. They read the tree only through
 * `lastChild` and `querySelector`, never a live collection's length, so they
 * add nothing to the reads the census is checked for. Cut 0 follows the
 * "after templates" script, cut 1 is inside the run of text (the body's last
 * child is that text), and cut 2 is inside the `<textarea>`.
 */
const GAPS = `[
  () => seenLabels.has("after templates"),
  () => { const t = document.body && document.body.lastChild;
          return !!t && t.nodeType === 3 && t.data.includes("the network cut"); },
  () => document.querySelector("textarea") !== null,
]`;

/**
 * The page's own `__check` calls, in the order they run: every script in
 * {@link PAGE} but the timer's. The module script runs after the parser
 * finishes, so after "end".
 */
const SCRIPT_CHECKS = [
  "head",
  "one of CodeTracer's own scripts running",
  "after a paragraph",
  "after a table",
  "after the adoption agency",
  "data grown",
  "comment added",
  "innerHTML",
  "insertBefore",
  "comment data",
  "removed",
  "template",
  "own script added",
  "own script text",
  "own script removed",
  "script added",
  "script type",
  "marker set",
  "marker removed",
  "document.write",
  "after document.write",
  "external script running",
  "after an external script",
  "after svg",
  "after templates",
  "end",
  "module",
];

/**
 * How long the server waits for the page's report before sending a cut's
 * remainder anyway. Reached only when no timer ran with the parser stopped
 * there; the test then fails naming the cut, instead of hanging until the
 * test's own timeout. The three cuts' limits together stay inside
 * {@link TIMEOUT}, and the page's navigation is bounded by them rather than
 * by Playwright's own 30 s default (see `census`).
 */
const GAP_REPORT_LIMIT_MS = 20_000;

const PAGE = `<!doctype html><html><head><title>census</title>
<script>__check("head")</script>
<script data-ct-replay-gate>__check("one of CodeTracer's own scripts running")</script>
</head><body>
<script>
  var timer = setInterval(function () {
    __check("timer");
    if (document.readyState !== "loading") clearInterval(timer);
  }, 1);
</script>
<p>text <b>bold</b> tail<!-- c --></p>
<script>__check("after a paragraph")</script>
<table><tr><td>a</td></tr>fostered text<div>fostered div</div></table>
<script>__check("after a table")</script>
<b><p>misnested</b> adoption</p>
<script>__check("after the adoption agency")</script>
<div id="m">one</div>
<script>
  var m = document.getElementById("m");
  m.firstChild.data += " more"; __check("data grown");
  m.appendChild(document.createComment("x")); __check("comment added");
  m.innerHTML = "<i>inner</i> html <!--y-->"; __check("innerHTML");
  var moved = document.createElement("span");
  moved.textContent = "moved";
  document.body.insertBefore(moved, document.body.firstChild); __check("insertBefore");
  m.lastChild.data = "zz"; __check("comment data");
  m.removeChild(m.firstChild); __check("removed");
  var tpl = document.createElement("template");
  tpl.innerHTML = "<p>in a template</p>";
  document.body.appendChild(tpl); __check("template");
  var own = document.createElement("script");
  own.setAttribute("data-ct-replay-gate", "");
  own.text = "1";
  document.body.appendChild(own); __check("own script added");
  own.text = "12"; __check("own script text");
  own.remove(); __check("own script removed");
  var s2 = document.createElement("script");
  s2.type = "text/x-data";
  s2.text = "data";
  document.body.appendChild(s2); __check("script added");
  s2.type = "module"; __check("script type");
  s2.setAttribute("data-ct-replay-gate", ""); __check("marker set");
  s2.removeAttribute("data-ct-replay-gate"); __check("marker removed");
  document.write("<p>written <em>em</em></p>"); __check("document.write");
</script>
<script>__check("after document.write")</script>
<script src="/ext.js"></script>
<script>__check("after an external script")</script>
<svg><script>void 0</script><text>svg text</text></svg>
<script>__check("after svg")</script>
<template><p>t</p></template><div><template shadowrootmode="open"><p>shadow</p></template>light</div>
<script>__check("after templates")</script>
${CUT}
  a run of text the network cut ${CUT} in two
<textarea>area text ${CUT} more area</textarea>
<script type="module">__check("module")</script>
<script>__check("end")</script>
</body></html>`;

let browser: Browser;
let server: http.Server;
let origin: string;
let progressSource: string;

/** The page load being served, which `/gap/<load>/<cut>` reports belong to. */
let currentLoad = 0;
/** Resolves the server's wait at a cut when the page reports it. */
const gapReported = new Map<number, () => void>();
/** The cuts of the current load whose wait ended without a report. */
let unreportedGaps: number[] = [];

beforeAll(async () => {
  browser = await loadPlaywright().chromium.launch({ headless: true });
  const bundle = await esbuild.build({
    stdin: {
      contents:
        'export { DocumentProgress } from "./document-progress.ts";\n' +
        'export { ParseCensus } from "./parse-census.ts";\n',
      resolveDir: path.join(REPO_ROOT, "packages/boundary-shim/src/browser"),
      loader: "ts",
    },
    write: false,
    bundle: true,
    format: "iife",
    globalName: "CtProgress",
    platform: "browser",
    target: "es2020",
    logLevel: "warning",
  });
  progressSource = bundle.outputFiles[0].text;
  server = http.createServer((req, res) => {
    if (req.url === "/ext.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end('__check("external script running");');
      return;
    }
    const gap = /^\/gap\/(\d+)\/(\d+)$/.exec(req.url ?? "");
    if (gap) {
      res.writeHead(204).end();
      if (Number(gap[1]) === currentLoad) gapReported.get(Number(gap[2]))?.();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    const pieces = PAGE.split(CUT);
    const next = (i: number) => {
      res.write(i === 0 ? pieces[0] : CUT + pieces[i]);
      if (i + 1 >= pieces.length) {
        res.end();
        return;
      }
      // Hold the remainder until the page's timer ran with the parser
      // stopped at this cut (GAPS), or, failing that, the limit.
      const limit = setTimeout(() => {
        gapReported.delete(i);
        unreportedGaps.push(i);
        next(i + 1);
      }, GAP_REPORT_LIMIT_MS);
      gapReported.set(i, () => {
        gapReported.delete(i);
        clearTimeout(limit);
        next(i + 1);
      });
    };
    next(0);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  origin = `http://127.0.0.1:${address.port}`;
}, TIMEOUT);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

/** One `__check` the page made. */
interface Check {
  label: string;
  /** Whether the census answered it (the document was parsing). */
  incremental: boolean;
  /** `document.readyState` when it was made. */
  state: string;
  /** For a timer check, the cut the parser was stopped at, if any (GAPS). */
  gap?: number;
}

interface Census {
  checks: number;
  log: Check[];
  /** Live collection length reads by the census's answers. */
  wholeReads: number;
  /** ... and by the whole-document measure's (the control). */
  fullReads: number;
  incremental: number;
  positions: string[];
  mismatches: string[];
}

/** Load the page with `DocumentProgress` made first; `sabotage` runs before. */
async function census(sabotage = ""): Promise<Census> {
  const load = ++currentLoad;
  unreportedGaps = [];
  gapReported.clear();
  const context = await browser.newContext();
  try {
    await context.addInitScript({
      content: `${progressSource}
${sabotage}
(() => {
  const progress = new CtProgress.DocumentProgress(window);
  const seen = new Set();
  const out = { checks: 0, log: [], incremental: 0, positions: [], mismatches: [], wholeReads: 0, fullReads: 0 };
  const seenLabels = new Set();
  const gaps = ${GAPS};
  let reportedGap = -1;
  // Reads of a live collection's length, which Blink answers by counting
  // the document again after every change to it: the census must make none.
  const lengthOf = Object.getOwnPropertyDescriptor(HTMLCollection.prototype, "length").get;
  let lengthReads = 0;
  Object.defineProperty(HTMLCollection.prototype, "length", {
    configurable: true,
    get() { lengthReads++; return lengthOf.call(this); },
  });
  globalThis.__census = out;
  globalThis.__check = (label) => {
    const incremental = progress.incremental;
    let reads = lengthReads;
    const a = JSON.stringify(progress.position());
    if (incremental) out.wholeReads += lengthReads - reads;
    reads = lengthReads;
    const b = JSON.stringify(progress.fullPosition());
    out.fullReads += lengthReads - reads;
    out.checks++;
    if (incremental) out.incremental++;
    if (!seen.has(a)) { seen.add(a); out.positions.push(a); }
    if (a !== b) out.mismatches.push(label + ": census " + a + ", full " + b);
    const entry = { label, incremental, state: document.readyState };
    seenLabels.add(label);
    if (label === "timer") {
      let gap = -1;
      for (let i = gaps.length - 1; i >= 0 && gap < 0; i--) if (gaps[i]()) gap = i;
      if (gap >= 0) entry.gap = gap;
      // The first timer check at a cut releases the rest of the page.
      if (gap > reportedGap) {
        reportedGap = gap;
        fetch("/gap/${load}/" + gap).catch(() => {});
      }
    }
    out.log.push(entry);
  };
})();`,
    });
    const page = await context.newPage();
    // No navigation timeout of its own: the server bounds each cut's wait
    // (GAP_REPORT_LIMIT_MS), and the test's TIMEOUT is the hang guard.
    await page.goto(`${origin}/`, { waitUntil: "load", timeout: 0 });
    return await page.evaluate(
      () => (globalThis as unknown as { __census: Census }).__census,
    );
  } finally {
    await context.close();
  }
}

describe("the census of a parsing document", () => {
  it(
    "census_counts_what_the_whole_document_measure_counts",
    async () => {
      const got = await census();
      expect(unreportedGaps, "cuts no timer ran at").toEqual([]);
      expect(got.mismatches).toEqual([]);
      // The census answered without counting the document again; the
      // whole-document measure did count it (the control).
      expect(got.wholeReads).toBe(0);
      expect(got.fullReads).toBeGreaterThan(got.checks);
      // Vacuity guards, each on what the page itself makes happen rather
      // than on how many timer turns the host grants: every page script's
      // check ran, in order; at each cut a timer check ran while the parser
      // waited there, with the census answering; every check made while the
      // document was loading was answered by the census; and the page
      // scripts' checks saw distinct positions.
      const scripts = got.log.filter((c) => c.label !== "timer");
      expect(scripts.map((c) => c.label)).toEqual(SCRIPT_CHECKS);
      for (const cut of [0, 1, 2]) {
        expect(
          got.log.some(
            (c) => c.gap === cut && c.incremental && c.state === "loading",
          ),
          `a timer check with the census answering at cut ${cut}`,
        ).toBe(true);
      }
      expect(
        got.log.filter((c) => c.state === "loading" && !c.incremental),
        "checks while loading that the census did not answer",
      ).toEqual([]);
      expect(got.incremental).toBe(
        got.log.filter((c) => c.state === "loading").length,
      );
      expect(got.positions.length).toBeGreaterThan(20);
      // Some checks ran while the document parsed (the census answered).
      expect(
        got.positions.some((p) => JSON.parse(p)?.phase === 1),
        "positions while the document parses",
      ).toBe(true);

      // Negative control: a census that ignores character data changes
      // (the parser appends to a text node; the page grows one) disagrees.
      const broken = await census(
        "CtProgress.ParseCensus.prototype.recountData = function () {};",
      );
      expect(broken.mismatches.length).toBeGreaterThan(0);
      // ... and so does one that takes every removed node for one of
      // CodeTracer's own scripts, which count for nothing.
      const deaf = await census(
        "CtProgress.ParseCensus.prototype.ownScript = function () { return true; };",
      );
      expect(deaf.mismatches.length).toBeGreaterThan(0);
    },
    TIMEOUT,
  );
});

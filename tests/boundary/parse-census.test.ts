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

/** Where the server cuts the page, waiting {@link GAP_MS} before the rest. */
const CUT = "<!--ct:chunk-->";
const GAP_MS = 300;

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
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    const pieces = PAGE.split(CUT);
    const next = (i: number) => {
      res.write(i === 0 ? pieces[0] : CUT + pieces[i]);
      if (i + 1 < pieces.length) setTimeout(() => next(i + 1), GAP_MS);
      else res.end();
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

interface Census {
  checks: number;
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
  const context = await browser.newContext();
  try {
    await context.addInitScript({
      content: `${progressSource}
${sabotage}
(() => {
  const progress = new CtProgress.DocumentProgress(window);
  const seen = new Set();
  const out = { checks: 0, incremental: 0, positions: [], mismatches: [], wholeReads: 0, fullReads: 0 };
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
  };
})();`,
    });
    const page = await context.newPage();
    await page.goto(`${origin}/`, { waitUntil: "load" });
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
      expect(got.mismatches).toEqual([]);
      // The census answered without counting the document again; the
      // whole-document measure did count it (the control).
      expect(got.wholeReads).toBe(0);
      expect(got.fullReads).toBeGreaterThan(got.checks);
      // Vacuity guards: the page's checks ran, the timers ran while the
      // parser waited, most of them with the census answering, and the
      // positions differ.
      expect(got.checks).toBeGreaterThan(60);
      expect(got.incremental).toBeGreaterThan(50);
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

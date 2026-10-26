/**
 * The replay runner's document gates (`packages/boundary-replay/src/gates.ts`,
 * CodeTracer's JS-Boundary-Recording specification §6, "The document's own
 * tasks") must leave the replayed document as the recorded one: a gate is a
 * script the parser runs, which takes itself (and every other gate) out of
 * the document, so once they have run the document must be node for node
 * what the browser builds from the page without them.
 *
 * Each document is loaded in real headless Chromium as served, with every
 * gate `insertGates` puts in (parser gates and the `DOMContentLoaded` and
 * `load` gates), and with those gates again, every parser gate holding the
 * parser as the replay runtime does where the log says so (it writes a
 * parser-blocking external gate script, which the parser meets in the
 * insertion mode the gate left); its tree is serialised node by
 * node, text nodes one by one (two adjacent text nodes are not one), with
 * every element and attribute. The three must be equal. The documents are
 * the shapes the HTML tree builder treats specially: implied and foster-
 * parented table parts, auto-closed paragraphs and list items, reconstructed
 * formatting elements, `select`, raw text and RCDATA, `template`, foreign
 * content, comments, a missing `head` and `body`, content after `</html>`,
 * text and comments between tags (gates go at every token boundary, text
 * included), runs of text in tables and whitespace in a column group,
 * comments after `</body>` and `</html>`, text and comments in "in
 * head", "after head", "in select", "in caption", "in table body", "in row",
 * `<template>` contents and foreign content, after ignored end tags and
 * between `<pre>` and its newline, a stray `<body>` and a `<frame>` between text; documents whose head
 * the tree builder implies (whitespace after a doctype, a comment or
 * `<html>`, which the modes before the head drop), pretty-printed tables
 * and selects, a page's own `document.write`, declarative shadow roots,
 * `ruby` and `object`, and an unquoted attribute value holding a quote.
 *
 * At protocol level 0 the recorded document carried the record bootstrap
 * at the start of its head (`bootstrapPosition`), so the reference is the
 * document with a bootstrap there (left out of the comparison: `dom-v1`
 * leaves scripts out too), and the gated one has the runner's stand-in for
 * it. That reference is also the page's own tree: the bootstrap goes where
 * the tree builder makes the head, and changes nothing else.
 *
 * And a gate the page refuses (a Content-Security-Policy without
 * 'unsafe-inline', a Trusted Types policy that refuses `document.write`)
 * is a typed divergence of the real runner, never an exception in the page
 * or a replay at another position; the same session on the same page
 * without the policy replays.
 *
 * One test double, and why: `__ctReplay.gate` is a stand-in that takes the
 * gates out and, in the holding pass, writes the held script, which the
 * route answers at once, installed as an init script.
 * What is under test is where the gates go, not the scheduler, which
 * `replay.test.ts` covers with the real runtime.
 *
 * Negative controls: a gate put where `insertGates` refuses to (before a
 * `<col>`; after a doctype, before the head exists; before whitespace in a
 * column group; after `</body>` before a comment) gives a different
 * tree, so the comparison discriminates; and so does the bootstrap where
 * the injector put it before it used the tokenizer (after `<html>` or a
 * doctype, before whitespace the modes before the head drop).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type BoundaryRecord,
  encodeLog,
  VOCAB,
} from "../../packages/boundary-format/src/index.js";
import {
  bootstrapPosition,
  BOOTSTRAP_MARKER,
  buildBundleManifest,
} from "../../packages/boundary-shim/src/index.js";
import { replaySession } from "../../packages/boundary-replay/src/runner.js";

import {
  type Browser,
  loadPlaywright,
} from "../../packages/boundary-replay/src/index.js";
import {
  GATE_PATH,
  insertGates,
  PARSER_GATE,
  parserScriptUrls,
} from "../../packages/boundary-replay/src/gates.js";
import { documentTree } from "./harness.js";

const TIMEOUT = 120_000;

const DOCUMENTS: Record<string, string> = {
  "pretty-printed": `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>t</title>
  <link rel="stylesheet" href="data:text/css,p{}">
  <script>window.x = 1;</script>
</head>
<body class="b">
  <h1>Title</h1>
  <ul>
    <li>one</li>
    <li>two <b>bold</b> tail</li>
  </ul>
  <script>window.y = 2;</script>
  <p>end</p>
</body>
</html>
`,
  tables: `<table><tr><td>a<td>b</table><table><div>fostered</div><tr><td>y</table>
<table>
  <caption>c</caption>
  <colgroup><col></colgroup>
  <thead><tr><th>h</th></tr></thead>
  <tr><td>implied tbody</td></tr>
</table>`,
  "auto-closing": `<p>one<p>two<div>three</div><ul><li>a<li>b</ul><dl><dt>t<dd>d</dl>`,
  "formatting reconstruction": `<p><b>x<p>y</b>z<i>i<a href=#>a</i>b</a>`,
  select: `<select><option>a<option selected>b<optgroup label=g><option>c</select>`,
  "raw text": `<textarea><p>not a tag</p></textarea><title>&lt;b&gt;</title>
<style>p > b { color: red }</style><noscript><p>x</p></noscript>
<script>var s = "<p>"; var t = "</p>";</script><xmp><b>x</b></xmp><p>after</p>`,
  "template and foreign": `<template><p>t</p><script>1</script></template>
<svg width=10 height=10><circle r=1/><text>t<tspan>s</tspan></text></svg>
<math><mi>x</mi></math><p>after</p>`,
  comments: `<!-- <p> --><p>a</p><!--><p>b</p><!---><p>c</p><?pi x><p>d</p>`,
  "no head or body": `<!doctype html><title>t</title><p>x<p>y`,
  "after html": `<p>a</p></body></html>
<p>late</p>`,
  "stray tags": `<body>x <body class=c> y <frame> z <head> w</body>`,
  pre: `<pre>
<b>x</b>
</pre><textarea>
t</textarea>`,
  attributes: `<div title="a>b" data-x='c>d'>x</div><p class=e>f</p><img src=x alt="<p>"><br/><p>g`,
  // The head is implied: the whitespace after the doctype, a comment or
  // `<html>` is dropped by the modes before the head; a gate there would
  // imply the head early and keep it.
  "implied head after a doctype": `<!doctype html>
<meta charset="utf-8">
<title>t</title>
<p>x`,
  "implied head after html": `<html>
<title>t</title>
<p>x`,
  "implied head and body after html": `<html>
<body>
<p>x`,
  "implied head after a comment": `<!-- c -->
<p>x`,
  "implied head after a comment in html": `<html><!-- c -->
<head></head><p>x`,
  "after head": `<head><title>t</title></head>
<!-- c -->
<body><p>x</p></body>`,
  "pretty-printed table and select": `<table>
 <tr>
  <td>x</td>
 </tr>
</table>
<select>
  <option>a</option>
  <optgroup label=g>
   <option>b</option>
  </optgroup>
</select>`,
  "the page's own document.write": `<script>document.write("<p>w</p>")</script>
<p>after</p>
<script>document.write("<table>")</script>
<tr><td>t</td></tr>
</table>`,
  "declarative shadow root": `<div><template shadowrootmode="open"><p>s</p></template>
<span>x</span></div>`,
  "ruby and object": `<ruby>a<rb>b</rb> <rt>c</rt> <rp>(</rp></ruby>
<object><param name=a value=b> <embed src=x></object>`,
  // Tags that are not tags (a `<head>` in an attribute value and in a
  // comment), a byte order mark and upper-case names: the bootstrap goes
  // after the real `<head>`.
  "head in a comment and an attribute": `<!doctype html><html data-x="<head>"><!-- <head> -->
<head data-y="a>b"><title>t</title></head><body><p>x</p></body></html>`,
  "byte order mark and upper case": `\uFEFF<!DOCTYPE HTML>
<HTML>
<!-- c -->
<BODY><P>x</BODY>`,
  // Gates at the boundaries around text and comments (§6, "The position"):
  // a run of text in a table is foster-parented or not by all of its
  // characters, whitespace in a column group stays in it, and comments
  // after `</body>` and `</html>` go to the `<html>` element and the
  // document.
  "text and comments around tags": `<p>a<!--c-->b<!---->c</p>
<div>one <b>two</b> three<br>four</div>
<p>x<span></span>y</p>tail`,
  "text runs in tables": `<table>  x  <tr><td>a</td> b </tr>
  <!-- c -->
</table>
<table>\n  <tr> <td>t</td>  </tr>\n</table>`,
  "whitespace in a column group": `<table><colgroup>
  <col>
  <!-- c -->
</colgroup>
<col>
<tr><td>x</td></tr></table>`,
  // Whitespace after `</body>` and `</html>` and no comment: a gate there
  // switches to "in body", where the whitespace goes to the body just the
  // same (the page a task can run in while the parser has `</body>` and
  // not yet `</html>`).
  "whitespace after body and html": `<p>a</p></body>
</html>
`,
  "comments after body and html": `<p>a</p></body>
<!-- after body -->
</html>
<!-- after html -->
`,
  // Text and comments in each insertion mode a gate's `<script>` start tag
  // is processed in (HTML, "Tree construction"): "in head" and "after
  // head", raw text in the head (`<noscript>`, scripting on), "in select"
  // (and in a cell), "in caption", "in table body" and "in row" with runs
  // of text the tree builder foster-parents or not, text after stray end
  // tags the body ignores (the parser appends it to the text before), a
  // comment between `<pre>` and its newline, text in `<template>` contents
  // and in foreign content (and after an HTML element that breaks out of
  // it), and a comment after a stray end tag after `</body>`, which
  // switches to "in body" itself.
  "text and comments in head and after head": `<!doctype html><html><head> <!-- h1 -->
  <title>t</title> <!-- h2 --> <noscript><p>n</p></noscript>
</head> <!-- after head -->
<body> x <!-- b --> y </body></html>`,
  "text and comments in select": `<select> <!-- s --> <option>a</option> x <optgroup label=g> <!-- o --> <option>b</optgroup> </select>
<table><tr><td><select> t <option>c</select> u </td></tr></table>`,
  "text and comments in table sections": `<table> <caption> c <!-- cap --> d </caption> <!-- t -->
<tbody> x <!-- tb --> <tr> y <!-- tr --> <td>z</td> w </tr> </tbody>
<tfoot> <tr><td>f</td></tr> </tfoot> v </table> after`,
  "text after ignored end tags": `<p>a</div>b</span>c</p>d</td>e<!--x-->f</table>g`,
  "comment between pre and its newline": `<pre><!---->
x</pre><listing><!--l-->
y</listing>`,
  "text in template and foreign content": `<template> a <!-- t --> <p>b</p> c </template> d
<svg> <g> t <!-- s --> </g> u </svg> e
<math> <mi> m </mi> <!-- m --> </math> f
<svg><p>broke out</p> after </svg> g`,
  "comment after a stray end tag after body": `<p>a</p></body></p>
<!-- in body now -->
</html>
<!-- c -->`,
  // An unquoted value holding a quote: the quote starts no quoted value, so
  // the `>` in the title below is in a quoted value, not a tag's end.
  "unquoted value with a quote": `<img alt=it's><span title='a >
<b>'>t</span>
<p>x</p>`,
};

let browser: Browser;
/** The gate scripts the inline gates wrote, with `treeOf`'s `hold`. */
const heldScripts = new Set<string>();
/** Numbers each `treeOf` call, so its held scripts count apart. */
let treeCalls = 0;

beforeAll(async () => {
  browser = await loadPlaywright().chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
});

/**
 * The document `html` builds, node by node, after every script ran; the
 * record bootstrap's element (the level-0 reference) is left out.
 */
async function treeOf(html: string, hold = false): Promise<string[]> {
  const call = treeCalls++;
  const context = await browser.newContext();
  try {
    // With `hold`, every inline parser gate also does what the replay
    // runtime's does where it holds the parser: it writes a parser-blocking
    // external gate script (`document.write`), parsed in the insertion mode
    // the inline gate left, and then takes every gate out of the document.
    // A gate that holds must leave the tree as it was too.
    await context.addInitScript({
      content: `globalThis.__ctReplay = { gate() {
        const s = document.currentScript;
        if (${hold} && s !== null && !s.src && document.readyState === "loading") {
          document.write('<script data-ct-replay-gate src="${GATE_PATH}gate/held?n=' + (globalThis.__ctHeld = (globalThis.__ctHeld || 0) + 1) + '"></' + 'script>');
        }
        for (const s of Array.from(document.querySelectorAll("script[data-ct-replay-gate]"))) s.remove();
      } };`,
    });
    await context.route("**/*", async (route, request) => {
      const url = new URL(request.url());
      if (url.pathname === `${GATE_PATH}gate/held`) {
        heldScripts.add(`${call}:${url.search}`);
        await route.fulfill({
          status: 200,
          headers: { "content-type": "text/javascript" },
          body: "",
        });
        return;
      }
      if (url.pathname.startsWith(GATE_PATH)) {
        await route.fulfill({
          status: 200,
          headers: { "content-type": "text/javascript" },
          body: "__ctReplay.gate();",
        });
        return;
      }
      if (url.pathname === "/") {
        await route.fulfill({
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
          body: html,
        });
        return;
      }
      await route.fulfill({ status: 404, body: "" });
    });
    const page = await context.newPage();
    await page.goto("http://gates.test/", { waitUntil: "load" });
    return await documentTree(page);
  } finally {
    await context.close();
  }
}

describe("the replay runner's document gates", () => {
  it(
    "parser_gates_leave_the_document_as_it_was",
    async () => {
      const options = { parser: true, domContentLoaded: true, load: true };
      const results: Record<string, boolean> = {};
      let gates = 0;
      for (const [name, html] of Object.entries(DOCUMENTS)) {
        const gated = insertGates(html, options);
        expect(gated.skipped, name).toBeUndefined();
        gates += gated.parserGates;
        const [plain, withGates, held] = [
          await treeOf(html),
          await treeOf(gated.html),
          await treeOf(gated.html, true),
        ];
        results[name] =
          JSON.stringify(withGates) === JSON.stringify(plain) &&
          JSON.stringify(held) === JSON.stringify(plain);
        if (!results[name]) {
          // Show the first difference in the failure message.
          expect(withGates, name).toEqual(plain);
          expect(held, `${name}, every gate holding`).toEqual(plain);
        }
      }
      expect(Object.values(results).every((r) => r)).toBe(true);
      // Vacuity: the gates went in, many of them.
      expect(gates).toBeGreaterThan(40);
      // ... and in the `hold` pass every one of them wrote its held script,
      // and so did the parser gate after the event gates, one per document,
      // which `parserGates` does not count.
      expect(heldScripts.size).toBe(gates + Object.keys(DOCUMENTS).length);

      // Negative control: a gate before a `<col>` ends its column group, and
      // the `<col>` implies a second one.
      const html = "<table><colgroup><col><col></colgroup></table>";
      const bad = html.replace("<col><col>", "<col>" + PARSER_GATE + "<col>");
      // insertGates puts none there.
      expect(insertGates(html, options).html).not.toContain(
        PARSER_GATE + "<col>",
      );
      expect(await treeOf(bad)).not.toEqual(await treeOf(html));

      // Negative control: a gate in a column group before whitespace ends
      // the group, so the whitespace goes to the table; and a gate after
      // `</body>` before a comment switches to "in body", so the comment
      // goes to the body. insertGates puts none at either.
      for (const [doc, at] of [
        ["whitespace in a column group", "<colgroup>"],
        ["comments after body and html", "</body>"],
      ]) {
        const html = DOCUMENTS[doc];
        const after = html.indexOf(at) + at.length;
        expect(insertGates(html, options).html, doc).not.toContain(
          at + PARSER_GATE,
        );
        expect(
          await treeOf(html.slice(0, after) + PARSER_GATE + html.slice(after)),
          doc,
        ).not.toEqual(await treeOf(html));
      }

      // ... but with only whitespace after `</body>` a gate goes there.
      expect(
        insertGates(DOCUMENTS["whitespace after body and html"], options).html,
      ).toContain("</body>" + PARSER_GATE);

      // Negative control: a gate where the head does not exist yet (right
      // after the doctype, as before the head rule) keeps the whitespace
      // there as a text node of the head.
      const early = DOCUMENTS["implied head after a doctype"];
      const atDoctype = "<!doctype html>".length;
      expect(insertGates(early, options).html.indexOf(PARSER_GATE)).not.toBe(
        atDoctype,
      );
      expect(
        await treeOf(
          early.slice(0, atDoctype) + PARSER_GATE + early.slice(atDoctype),
        ),
      ).not.toEqual(await treeOf(early));
    },
    TIMEOUT,
  );

  it(
    "level_0_gates_leave_the_recorded_document_as_it_was",
    async () => {
      const options = { parser: true, domContentLoaded: true, load: true };
      const bootstrap = `<script ${BOOTSTRAP_MARKER}></script>`;
      for (const [name, html] of Object.entries(DOCUMENTS)) {
        const at = bootstrapPosition(html);
        // The recorded document: the bootstrap at the start of its head.
        const recorded = html.slice(0, at) + bootstrap + html.slice(at);
        const gated = insertGates(html, { ...options, bootstrapAt: at });
        expect(gated.html, name).toContain(PARSER_GATE);
        expect(await treeOf(gated.html), name).toEqual(await treeOf(recorded));
        // With no gate asked for, the stand-in alone.
        const standIn = insertGates(html, {
          parser: false,
          domContentLoaded: false,
          load: false,
          bootstrapAt: at,
        });
        expect(standIn.html.split(PARSER_GATE).length - 1, name).toBe(1);
        expect(await treeOf(standIn.html), name).toEqual(
          await treeOf(recorded),
        );
        // The bootstrap went where the tree builder makes the head, so the
        // recorded document is the page's own but for the bootstrap.
        expect(await treeOf(recorded), name).toEqual(await treeOf(html));
      }
      // Negative control: the bootstrap where the injector put it before it
      // used the tokenizer (after `<html>`, or after a leading doctype,
      // when the page has no `<head>` tag) implies the head before the
      // whitespace the modes before the head drop, which then becomes a
      // text node of the head: a different tree, so the comparison
      // discriminates.
      let differs = 0;
      for (const name of [
        "implied head after a doctype",
        "implied head after html",
        "implied head and body after html",
      ]) {
        const html = DOCUMENTS[name];
        const root = /<html(\s[^>]*)?>/i.exec(html);
        const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
        const legacy =
          root !== null
            ? root.index + root[0].length
            : doctype === null
              ? 0
              : doctype[0].length;
        const recorded = html.slice(0, legacy) + bootstrap + html.slice(legacy);
        if (
          JSON.stringify(await treeOf(recorded)) !==
          JSON.stringify(await treeOf(html))
        ) {
          differs++;
        }
      }
      expect(differs).toBe(3);
    },
    TIMEOUT,
  );

  it(
    "a_gate_the_page_refuses_is_a_typed_divergence",
    async () => {
      // A session whose only task ran while the parser was before the
      // second <p> (html, head, meta, title, body, p: 6 elements; the
      // title's and the first paragraph's text: 2 of text), on a page
      // whose <meta> is a policy or not.
      const page = (meta: string) =>
        `<!doctype html><html><head>${meta}<title>t</title></head>` +
        `<body><p>a</p><p>b</p></body></html>`;
      const replayWith = async (meta: string) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-gates-csp-"));
        try {
          const build = path.join(dir, "site");
          fs.mkdirSync(build);
          fs.writeFileSync(path.join(build, "index.html"), page(meta));
          const { buildHash } = buildBundleManifest(build);
          const records: BoundaryRecord[] = [
            {
              record: "Header",
              vocab: VOCAB,
              protocol_level: 0,
              recorder_id: "gates.test",
              framework: "",
              build_hash: buildHash,
              session_id: "gates-csp",
              prev_session: "",
              capabilities: "",
            },
            {
              record: "Env",
              ua: "",
              ua_major: 0,
              viewport_w: 800,
              viewport_h: 600,
              dpr: 1,
              locale: "",
              tz: "",
              fonts_digest: "",
              color_scheme: 0,
              reduced_motion: 0,
              arms: "",
              url: "http://gates.test/index.html",
              referrer_origin: "",
              traceparent: "",
            },
            {
              record: "Loading",
              seq: 1n,
              phase: 1,
              elements: 6,
              scripts: 0,
              text: 2,
            },
            { record: "End", last_seq: 1n, reason: 2 },
          ] as BoundaryRecord[];
          const log = path.join(dir, "jsbound.log");
          fs.writeFileSync(log, encodeLog(records));
          return await replaySession({
            log,
            build,
            browser,
            timeoutMs: 30_000,
          });
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      };
      // Control: an ordinary <meta>; the parser is held at the position.
      const plain = await replayWith(`<meta name="x" content="y">`);
      expect(plain.status, JSON.stringify(plain)).toBe("replayed");
      const csp = await replayWith(
        `<meta http-equiv="Content-Security-Policy" content="script-src 'self'">`,
      );
      expect(csp.status, JSON.stringify(csp)).toBe("diverged");
      expect(csp.divergence?.kind).toBe("NonReplayable");
      expect(csp.divergence?.detail).toMatch(/Content-Security-Policy/);
      const trustedTypes = await replayWith(
        `<meta http-equiv="Content-Security-Policy" content="require-trusted-types-for 'script'">`,
      );
      expect(trustedTypes.status, JSON.stringify(trustedTypes)).toBe(
        "diverged",
      );
      expect(trustedTypes.divergence?.kind).toBe("NonReplayable");
      expect(trustedTypes.divergence?.detail).toMatch(/document\.write/);
      // The gate threw nothing into the page.
      expect(trustedTypes.pageErrors).toEqual([]);
    },
    TIMEOUT,
  );

  it("parser_script_urls_are_the_scripts_the_parser_inserts", () => {
    const html = `<head><script src="a.js"></script><base href="/lib/">
<script src='b.js?x=1&amp;y=2#frag'></script><script>inline</script>
<script type=module src=c.mjs></script></head>
<body><template><script src="t.js"></script></template>
<svg><script href="s.js"></script></svg>
<textarea><script src="no.js"></script></textarea>
<script async src="https://cdn.test/d.js"></script>`;
    expect(parserScriptUrls(html, "https://site.test/app/index.html")).toEqual([
      // Fetched when the parser reaches it, before the <base> exists.
      "https://site.test/app/a.js",
      "https://site.test/lib/b.js?x=1&y=2",
      "https://site.test/lib/c.mjs",
      "https://cdn.test/d.js",
    ]);
  });
});

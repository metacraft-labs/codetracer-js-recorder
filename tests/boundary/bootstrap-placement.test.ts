/**
 * Where the record bootstrap goes (CodeTracer's JS-Boundary-Recording
 * specification §10: "a bootstrap `<script>` inserted first in `<head>`",
 * before any application code), through both shipped routes, in real
 * headless Chromium.
 *
 * Each page shape below hides a `<head>` where the HTML tokenizer does not
 * see a tag (a comment, a script's text, an attribute value, CDATA,
 * `<template>`, `<noscript>`, a title), has no `<head>` or `<html>` at all,
 * or carries a byte order mark, upper-case names, a doctype, comments,
 * an encoding declaration (in a head and in an implied one), leading
 * whitespace or text. Every script of the page notes whether the
 * shim was installed when it ran. Each shape is installed by the
 * `codetracer-js-recorder boundary-shim` CLI step and by a real `vite build`
 * with `codetracerBoundaryShimPlugin`, loaded from a real local server, and
 * must:
 *
 * - have run the bootstrap before every script of the page (each note says
 *   so, and the first script element of the document is the bootstrap);
 * - be the page's own tree but for the bootstrap (compared node by node with
 *   the page served without the shim);
 * - give a log the strict decoder accepts, from `Header` to `End`;
 * - keep the page's character encoding declaration, when it has one, in the
 *   first 1024 bytes of the file, where the encoding prescan
 *   (https://html.spec.whatwg.org/multipage/parsing.html#prescan-a-byte-stream-to-determine-its-encoding)
 *   looks for it: the bootstrap embeds the whole shim, so it goes after a
 *   declaration that only inert elements (a title, comments, `<meta>`
 *   elements that declare nothing) precede, and otherwise (a script, a
 *   style sheet before the declaration) a copy of the declaration goes
 *   before it. Checked with an independent transcription of the prescan
 *   over the file's bytes ({@link prescan}), which must find, within the
 *   window, the encoding the page declared; the copy is CodeTracer's, and is
 *   left out of the tree compared with the page's.
 *
 * Three of the tricky shapes, recorded through the CLI route, are replayed by
 * the real replay runner, which must reach `End` with no divergence: the
 * runner's stand-in for the bootstrap goes where `bootstrapPosition` says,
 * the same function the injector uses.
 *
 * No mocks: the built CLI as a child process, the real vite, the real
 * fixture server, Chromium, the real replay runner.
 *
 * Negative control: the injector's position before it used the tokenizer
 * (the first match of `<head …>` as text) is applied to the shapes; on the
 * shapes it misplaces, the same page check reports the shim missing or late,
 * so the check discriminates, and the encoding declarations it pushes out
 * of the prescan's window. And a page that cannot get the bootstrap
 * without being otherwise changed (one that is not UTF-8) is refused by the
 * CLI, which then writes no file.
 */

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { decodeLog } from "../../packages/boundary-format/src/index.js";
import {
  BOOTSTRAP_MARKER,
  bootstrapScript,
} from "../../packages/boundary-shim/src/index.js";
import { replaySession } from "../../packages/boundary-replay/src/runner.js";
import { ENCODING_LABELS } from "../../packages/boundary-shim/src/encoding-labels.js";
import { codetracerBoundaryShimPlugin } from "../../packages/vite-plugin/src/index.js";
import {
  type Browser,
  type FixtureServer,
  type Page,
  CHUNK_MARKER,
  documentTree,
  loadPlaywright,
  readLog,
  REPO_ROOT,
  startFixtureServer,
} from "./harness.js";

const TIMEOUT = 300_000;
const CLI = path.join(REPO_ROOT, "packages/cli/dist/index.js");

/**
 * A page script: notes whether the shim was installed when it ran, and
 * reads the clock (a read the log records once the shim is there).
 */
const NOTE =
  "(window.__notes = window.__notes || []).push(typeof globalThis.__ctBoundaryShim); Date.now();";
const S = `<script>${NOTE}</script>`;

/**
 * A page shape and how many of its scripts run (each notes once); and, for
 * a page that declares its character encoding, the declaration and the
 * encoding it names, which the prescan must find within the first 1024
 * bytes of the installed page: the page's own declaration, or, where
 * `copy` says so, a copy of it before the bootstrap.
 */
interface Shape {
  html: string;
  scripts: number;
  declaration?: string;
  encoding?: string;
  copy?: boolean;
}

const SHAPES: Record<string, Shape> = {
  plain: {
    html: `<!doctype html><html><head><title>t</title>${S}</head><body><p>x</p>${S}</body></html>`,
    scripts: 2,
  },
  "head in a comment": {
    html: `<!doctype html><html><!-- <head> --><head><title>t</title>${S}</head><body><p>x</p></body></html>`,
    scripts: 1,
  },
  "head in a script's text": {
    html: `<!doctype html><script>var h = "<head>"; ${NOTE}</script><head>${S}</head><body><p>x</p></body>`,
    scripts: 2,
  },
  "head in an attribute value": {
    html: `<html lang="en" data-x="<head>"><head data-y="a>b">${S}</head><body><p>x</p></body></html>`,
    scripts: 1,
  },
  "head in CDATA": {
    html: `<!doctype html><![CDATA[<head>]]>${S}<p>x</p>`,
    scripts: 1,
  },
  "head in a template": {
    html: `<template><head>${S}</template>${S}<p>x</p>`,
    scripts: 1,
  },
  "head in noscript and title": {
    html: `<!doctype html><title><head></title><noscript><head></noscript>${S}<p>x</p>`,
    scripts: 1,
  },
  "stray head in the body": {
    html: `<body>${S}<p>x</p><head>${S}</body>`,
    scripts: 2,
  },
  "byte order mark, upper case, no head": {
    html: `﻿<!DOCTYPE html>\n<!-- c -->\n<META charset=utf-8>\n<SCRIPT>${NOTE}</SCRIPT>\n<SCRIPT src="ext.js"></SCRIPT>\n<P>x`,
    scripts: 2,
    declaration: "<META charset=utf-8>",
    encoding: "utf-8",
  },
  "encoding declaration beginning the head": {
    html: `<!doctype html>\n<html lang="en">\n  <head>\n    <!-- c -->\n    <meta name="viewport" content="width=device-width">\n    <meta charset="UTF-8" />\n    <title>t</title>\n    ${S}\n  </head>\n  <body><p>x</p>${S}</body>\n</html>`,
    scripts: 2,
    declaration: `<meta charset="UTF-8" />`,
    encoding: "utf-8",
  },
  "encoding declaration as http-equiv, no head": {
    html: `<!doctype html>\n<meta http-equiv="Content-Type" content="text/html; charset=utf-8">\n${S}<p>x`,
    scripts: 1,
    declaration: `<meta http-equiv="Content-Type" content="text/html; charset=utf-8">`,
    encoding: "utf-8",
  },
  "encoding declaration after a title, comments and inert meta, no head": {
    html: `<!doctype html>\n<title>t</title>\n<!-- c -->\n<meta name="description" content="d">\n<meta charset="utf-8">\n${S}\n<p>x`,
    scripts: 1,
    declaration: `<meta charset="utf-8">`,
    encoding: "utf-8",
  },
  "encoding declaration after a style sheet and a style": {
    html: `<!doctype html>\n<html>\n<head>\n<title>t</title>\n<link rel="stylesheet" href="s.css">\n<style>p { margin: 0 }</style>\n<meta http-equiv="content-type" content="text/html; charset=UTF-8">\n${S}\n</head>\n<body><p>x</p>${S}</body>\n</html>`,
    scripts: 2,
    declaration: `<meta http-equiv="content-type" content="text/html; charset=UTF-8">`,
    encoding: "utf-8",
    copy: true,
  },
  "encoding declaration after a script": {
    html: `<!doctype html>\n<head>\n<script>${NOTE}</script>\n<meta charset="utf-8">\n<title>t</title>\n</head>\n<body>${S}<p>x</p></body>`,
    scripts: 2,
    declaration: `<meta charset="utf-8">`,
    encoding: "utf-8",
    copy: true,
  },
  "upper-case head whose attribute holds >": {
    html: `<!DOCTYPE html><HTML><HEAD DATA-X="a>b"><SCRIPT>${NOTE}</SCRIPT></HEAD><BODY><P>x</BODY></HTML>`,
    scripts: 1,
  },
  "leading text": {
    html: `hello ${S}<p>x`,
    scripts: 1,
  },
  "leading whitespace, html with an attribute holding >": {
    html: `\n\n  <html data-a='>'>\n<body>${S}<p>x</p></body></html>`,
    scripts: 1,
  },
};

/** The external script of the shape that has one. */
const EXT_JS = NOTE;

/** The style sheet of the shape that has one. */
const S_CSS = "p { padding: 0 }";

/** The shapes the replay runner replays (recorded through the CLI route). */
const REPLAYED = [
  "head in a comment",
  "byte order mark, upper case, no head",
  "encoding declaration beginning the head",
  "encoding declaration after a script",
];

/** The end of `declaration` in the page file `file`, in bytes. */
function declarationEnd(file: string, declaration: string): number {
  return declarationEndIn(fs.readFileSync(file), declaration, file);
}

/** The end of `declaration` in `bytes`, which hold it once. */
function declarationEndIn(
  bytes: Buffer,
  declaration: string,
  file = "the page",
): number {
  const at = bytes.indexOf(declaration);
  expect(at, `${file} holds ${declaration}`).toBeGreaterThanOrEqual(0);
  // The declaration occurs once, so the first match is the page's.
  expect(bytes.indexOf(declaration, at + 1), file).toBe(-1);
  return at + Buffer.byteLength(declaration);
}

/** The prescan's window (HTML, "prescan a byte stream to determine its encoding"). */
const PRESCAN_BYTES = 1024;

const isWs = (b: number) =>
  b === 0x09 || b === 0x0a || b === 0x0c || b === 0x0d || b === 0x20;
const isUpper = (b: number) => b >= 0x41 && b <= 0x5a;
const isLetter = (b: number) => isUpper(b) || (b >= 0x61 && b <= 0x7a);

/** "Get an encoding": the encoding's name, or undefined (Node's decoder). */
function getEncoding(label: string): string | undefined {
  try {
    return new TextDecoder(label).encoding;
  } catch {
    return undefined;
  }
}

/**
 * "The algorithm for extracting a character encoding from a meta element"
 * (https://html.spec.whatwg.org/multipage/urls-and-fetching.html#algorithm-for-extracting-a-character-encoding-from-a-meta-element),
 * transcribed independently of the injector's.
 */
function extractFromContent(s: string): string | undefined {
  let position = 0;
  for (;;) {
    const at = s.toLowerCase().indexOf("charset", position);
    if (at < 0) return undefined;
    let p = at + 7;
    while (p < s.length && isWs(s.charCodeAt(p))) p++;
    if (s[p] !== "=") {
      position = at + 7;
      continue;
    }
    p++;
    while (p < s.length && isWs(s.charCodeAt(p))) p++;
    if (p >= s.length) return undefined;
    if (s[p] === '"' || s[p] === "'") {
      const close = s.indexOf(s[p], p + 1);
      return close < 0 ? undefined : getEncoding(s.slice(p + 1, close));
    }
    const m = /^[^\t\n\f\r ;]*/.exec(s.slice(p)) as RegExpExecArray;
    return getEncoding(m[0]);
  }
}

/**
 * The encoding prescan
 * (https://html.spec.whatwg.org/multipage/parsing.html#prescan-a-byte-stream-to-determine-its-encoding)
 * over the first {@link PRESCAN_BYTES} bytes of `bytes` (after a UTF-8
 * byte order mark), transcribed step by step from the specification as an
 * oracle independent of the injector: the encoding the first declaration
 * names, and where that `<meta>` ends; undefined when the window has none.
 */
function prescan(bytes: Buffer): { encoding: string; end: number } | undefined {
  const n = Math.min(bytes.length, PRESCAN_BYTES);
  let p = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  class Abort extends Error {}
  const at = (k: number): number => {
    if (k >= n) throw new Abort();
    return bytes[k];
  };
  // "Get an attribute": [name, value], or undefined at a `>`.
  const getAttribute = (): [string, string] | undefined => {
    while (isWs(at(p)) || at(p) === 0x2f) p++;
    if (at(p) === 0x3e) return undefined;
    let name = "";
    let value = "";
    for (;;) {
      const b = at(p);
      if (b === 0x3d && name !== "") {
        p++;
        break;
      }
      if (isWs(b)) {
        while (isWs(at(p))) p++;
        if (at(p) !== 0x3d) return [name, ""];
        p++;
        break;
      }
      if (b === 0x2f || b === 0x3e) return [name, ""];
      name += String.fromCharCode(isUpper(b) ? b + 32 : b);
      p++;
    }
    while (isWs(at(p))) p++;
    const q = at(p);
    if (q === 0x22 || q === 0x27) {
      p++;
      for (;;) {
        const b = at(p);
        p++;
        if (b === q) return [name, value];
        value += String.fromCharCode(isUpper(b) ? b + 32 : b);
      }
    }
    if (q === 0x3e) return [name, ""];
    for (;;) {
      const b = at(p);
      if (isWs(b) || b === 0x3e) return [name, value];
      value += String.fromCharCode(isUpper(b) ? b + 32 : b);
      p++;
    }
  };
  const lower = (k: number) => String.fromCharCode(bytes[k] | 0x20);
  try {
    for (; p < n; p++) {
      if (bytes.subarray(p, p + 4).toString("latin1") === "<!--") {
        const close = bytes.indexOf("-->", p + 4, "latin1");
        if (close < 0 || close + 3 > n) return undefined;
        p = close + 2;
        continue;
      }
      if (
        at(p) === 0x3c &&
        lower(p + 1) + lower(p + 2) + lower(p + 3) + lower(p + 4) === "meta" &&
        (isWs(at(p + 5)) || at(p + 5) === 0x2f)
      ) {
        p += 5;
        const seen = new Set<string>();
        let gotPragma = false;
        let needPragma: boolean | null = null;
        let charset: string | null | false = null;
        for (let a = getAttribute(); a !== undefined; a = getAttribute()) {
          const [name, value] = a;
          if (seen.has(name)) continue;
          seen.add(name);
          if (name === "http-equiv" && value === "content-type")
            gotPragma = true;
          else if (name === "content") {
            const e = extractFromContent(value);
            if (e !== undefined && charset === null) {
              charset = e;
              needPragma = true;
            }
          } else if (name === "charset") {
            charset = getEncoding(value) ?? false;
            needPragma = false;
          }
        }
        if (needPragma === null) continue;
        if (needPragma && !gotPragma) continue;
        if (charset === false || charset === null) continue;
        if (charset === "utf-16le" || charset === "utf-16be") charset = "utf-8";
        return { encoding: charset, end: p + 1 };
      }
      if (
        at(p) === 0x3c &&
        (isLetter(at(p + 1)) || (at(p + 1) === 0x2f && isLetter(at(p + 2))))
      ) {
        while (!isWs(at(p)) && at(p) !== 0x3e) p++;
        while (getAttribute() !== undefined);
        continue;
      }
      if (
        at(p) === 0x3c &&
        (at(p + 1) === 0x21 || at(p + 1) === 0x2f || at(p + 1) === 0x3f)
      ) {
        const gt = bytes.indexOf(0x3e, p + 1);
        if (gt < 0 || gt >= n) return undefined;
        p = gt;
      }
    }
  } catch (e) {
    if (e instanceof Abort) return undefined;
    throw e;
  }
  return undefined;
}

const fileOf = (name: string) =>
  `${name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}.html`;

let browser: Browser;
const servers: FixtureServer[] = [];
const tmpDirs: string[] = [];

function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

/** A site with every shape as its own page, and the external script. */
function writeSite(dir: string, transform = (html: string) => html): void {
  for (const [name, shape] of Object.entries(SHAPES)) {
    fs.writeFileSync(path.join(dir, fileOf(name)), transform(shape.html));
  }
  fs.writeFileSync(path.join(dir, "ext.js"), EXT_JS);
  fs.writeFileSync(path.join(dir, "s.css"), S_CSS);
}

/** The bundle-manifest build hash of `dir`, as the deploy route prints it. */
function buildHashOf(dir: string): string {
  return execFileSync(process.execPath, [CLI, "bundle-manifest", dir], {
    encoding: "utf-8",
  }).trim();
}

/** Install the shim into every page of `dir` with the CLI step. */
function cliSite(): string {
  const dir = path.join(tmp("ct-placement-cli-"), "site");
  fs.mkdirSync(dir);
  writeSite(dir);
  const hash = buildHashOf(dir);
  execFileSync(
    process.execPath,
    [CLI, "boundary-shim", dir, "--build-hash", hash],
    { stdio: "pipe" },
  );
  return dir;
}

/** Build every page with vite and the boundary-shim plugin. */
async function viteSite(): Promise<string> {
  const vite = createRequire(__filename)("vite") as typeof import("vite");
  const root = tmp("ct-placement-vite-");
  writeSite(root);
  // vite copies `public/` as it is: the external script stays a classic
  // script at the same URL, and the style sheet a `<link>` where the page
  // has it (vite moves a style sheet it bundles to the end of the head).
  fs.mkdirSync(path.join(root, "public"));
  for (const asset of ["ext.js", "s.css"]) {
    fs.renameSync(path.join(root, asset), path.join(root, "public", asset));
  }
  const outDir = path.join(tmp("ct-placement-vite-out-"), "site");
  const input: Record<string, string> = {};
  for (const name of Object.keys(SHAPES)) {
    input[fileOf(name).replace(/\.html$/, "")] = path.join(root, fileOf(name));
  }
  await vite.build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [codetracerBoundaryShimPlugin({ buildHash: "ab".repeat(32) })],
    build: { outDir, emptyOutDir: true, rollupOptions: { input } },
  });
  return outDir;
}

/** What a page showed once loaded. */
interface Loaded {
  notes: string[];
  firstScriptIsBootstrap: boolean;
  /** The declaration copy before the bootstrap, as a tree line, if any. */
  copy: string | null;
  tree: string[];
  page: Page;
  close(): Promise<void>;
}

async function load(origin: string, file: string): Promise<Loaded> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${origin}/${file}`);
  // The page's scripts all ran by `load` (none is async or deferred);
  // polled from Node, so nothing of the test's runs in the page's tasks.
  for (const deadline = Date.now() + 15_000; ; ) {
    const state = await page.evaluate(() => document.readyState);
    if (state === "complete") break;
    if (Date.now() > deadline) throw new Error(`${file} did not load`);
    await new Promise((r) => setTimeout(r, 20));
  }
  const [notes, firstScriptIsBootstrap] = await page.evaluate(
    (marker) =>
      [
        ((window as unknown as { __notes?: string[] }).__notes ?? []).slice(),
        document.scripts[0]?.hasAttribute(marker) ?? false,
      ] as [string[], boolean],
    BOOTSTRAP_MARKER,
  );
  // The copy of the encoding declaration before the bootstrap is
  // CodeTracer's, as the bootstrap is: it is left out of the tree compared
  // with the page's. It is the first element of its kind in the document
  // (it stands where the head begins), so it is the first such line.
  const copy = await page.evaluate((marker) => {
    const c = document.querySelector(
      `script[${marker}="charset"]`,
    )?.previousElementSibling;
    if (c === null || c === undefined) return null;
    const attrs = Array.from(c.attributes)
      .map((a) => `${a.name}=${JSON.stringify(a.value)}`)
      .join(" ");
    return `<${c.namespaceURI} ${c.localName} ${attrs}>`;
  }, BOOTSTRAP_MARKER);
  const tree = await documentTree(page);
  if (copy !== null) {
    const k = tree.findIndex((line) => line.trimStart() === copy);
    if (k >= 0) tree.splice(k, 1);
  }
  return {
    notes,
    firstScriptIsBootstrap,
    copy,
    tree,
    page,
    close: () => context.close(),
  };
}

async function serve(dir: string): Promise<FixtureServer> {
  const s = await startFixtureServer(dir);
  servers.push(s);
  return s;
}

/** Stop the page's session and strictly decode its log. */
async function stopAndRead(page: Page): Promise<Uint8Array> {
  await page.evaluate(() => {
    (
      (globalThis as unknown as Record<string, unknown>).__ctBoundaryShim as {
        stop(): void;
      }
    ).stop();
  });
  return readLog(page);
}

beforeAll(async () => {
  browser = await loadPlaywright().chromium.launch({ headless: true });
}, TIMEOUT);

afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
  await browser?.close();
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

/** The trees of the pages served without the shim, by shape. */
async function plainTrees(): Promise<Record<string, string[]>> {
  const dir = tmp("ct-placement-plain-");
  writeSite(dir);
  const server = await serve(dir);
  const out: Record<string, string[]> = {};
  for (const name of Object.keys(SHAPES)) {
    const loaded = await load(server.origin, fileOf(name));
    out[name] = loaded.tree;
    // Vacuity: without the shim every script ran, and saw no shim.
    expect(loaded.notes, name).toEqual(
      new Array(SHAPES[name].scripts).fill("undefined"),
    );
    await loaded.close();
  }
  return out;
}

/** Check every shape of the site at `dir`; returns the logs, by shape. */
async function checkSite(
  dir: string,
  plain: Record<string, string[]>,
): Promise<Record<string, Uint8Array>> {
  const server = await serve(dir);
  const logs: Record<string, Uint8Array> = {};
  for (const [name, shape] of Object.entries(SHAPES)) {
    const loaded = await load(server.origin, fileOf(name));
    try {
      expect(loaded.notes, `${name}: every script ran after the shim`).toEqual(
        new Array(shape.scripts).fill("object"),
      );
      expect(loaded.firstScriptIsBootstrap, name).toBe(true);
      expect(loaded.copy !== null, `${name}: a declaration copy`).toBe(
        shape.copy === true,
      );
      expect(loaded.tree, `${name}: the page's own tree`).toEqual(plain[name]);
      const log = await stopAndRead(loaded.page);
      const records = decodeLog(log).records;
      expect(records[0].record, name).toBe("Header");
      expect(records[records.length - 1].record, name).toBe("End");
      // The page's clock reads are in the log: the shim saw the scripts.
      expect(
        records.filter((r) => r.record === "Clock").length,
        name,
      ).toBeGreaterThanOrEqual(shape.scripts);
      logs[name] = log;
    } finally {
      await loaded.close();
    }
  }
  return logs;
}

describe("the record bootstrap's position", () => {
  it(
    "every_shape_runs_the_shim_first_through_the_cli_and_vite",
    async () => {
      const plain = await plainTrees();
      const cli = cliSite();
      const logs = await checkSite(cli, plain);
      const vite = await viteSite();
      await checkSite(vite, plain);

      // The encoding prescan still finds, in the first 1024 bytes, the
      // encoding the page declared (the bootstrap, tens of kilobytes,
      // follows the page's declaration or a copy of it), and the page's own
      // declaration is still there.
      for (const [name, shape] of Object.entries(SHAPES)) {
        if (shape.declaration === undefined) continue;
        // Vacuity: the page as written declares it within the window.
        expect(prescan(Buffer.from(shape.html)), name).toEqual({
          encoding: shape.encoding,
          end: declarationEndIn(Buffer.from(shape.html), shape.declaration),
        });
        for (const dir of [cli, vite]) {
          const file = path.join(dir, fileOf(name));
          const bytes = fs.readFileSync(file);
          expect(bytes.toString("utf-8"), file).toContain(BOOTSTRAP_MARKER);
          const found = prescan(bytes);
          expect(
            found?.encoding,
            `${file}: the prescan finds the page's encoding in its window`,
          ).toBe(shape.encoding);
          // The page's own declaration is left where the page had it.
          const own = declarationEnd(file, shape.declaration);
          if (shape.copy === true) {
            expect(found?.end, file).toBeLessThan(own);
            expect(own, file).toBeGreaterThan(PRESCAN_BYTES);
          } else {
            expect(found?.end, file).toBe(own);
          }
        }
      }

      // Replay three of the tricky shapes: the runner's stand-in goes where
      // the bootstrap went, and the replay reaches End with no divergence.
      for (const name of REPLAYED) {
        const log = path.join(tmp("ct-placement-log-"), "jsbound.log");
        fs.writeFileSync(log, logs[name]);
        const report = await replaySession({
          log,
          build: cli,
          browser,
          timeoutMs: 60_000,
        });
        expect(
          report.status,
          `${name}: ${JSON.stringify(report.divergence ?? report.error)}`,
        ).toBe("replayed");
        expect(report.checkpoints, name).toBeGreaterThanOrEqual(1);
      }
    },
    TIMEOUT,
  );

  it(
    "the_position_found_as_text_misplaces_the_shim_negative_control",
    async () => {
      // The injector before the tokenizer: after the first `<head …>`
      // matched as text, else after `<html …>`, else after a leading
      // doctype.
      const legacy = (html: string): string => {
        const tag = bootstrapScript({}, {});
        const m =
          /<head(\s[^>]*)?>/i.exec(html) ?? /<html(\s[^>]*)?>/i.exec(html);
        const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
        const at =
          m !== null
            ? m.index + m[0].length
            : doctype === null
              ? 0
              : doctype[0].length;
        return html.slice(0, at) + tag + html.slice(at);
      };
      const dir = tmp("ct-placement-legacy-");
      writeSite(dir, legacy);
      const server = await serve(dir);
      const misplaced: string[] = [];
      for (const [name, shape] of Object.entries(SHAPES)) {
        const loaded = await load(server.origin, fileOf(name));
        const first =
          JSON.stringify(loaded.notes) ===
            JSON.stringify(new Array(shape.scripts).fill("object")) &&
          loaded.firstScriptIsBootstrap;
        if (!first) misplaced.push(name);
        await loaded.close();
      }
      // The check discriminates: the text search misplaces the shim in the
      // shapes built to defeat it, and not in the plain page.
      expect(misplaced).not.toContain("plain");
      expect(misplaced).toEqual(
        expect.arrayContaining([
          "head in a comment",
          "head in a script's text",
          "head in an attribute value",
          "head in a template",
          "head in noscript and title",
          "stray head in the body",
          "upper-case head whose attribute holds >",
        ]),
      );
      // And the bootstrap first in the head pushes the encoding declaration
      // out of the prescan's window.
      for (const name of [
        "encoding declaration beginning the head",
        "byte order mark, upper case, no head",
        "encoding declaration after a title, comments and inert meta, no head",
        "encoding declaration after a style sheet and a style",
        "encoding declaration after a script",
      ]) {
        expect(
          declarationEnd(
            path.join(dir, fileOf(name)),
            SHAPES[name].declaration as string,
          ),
          name,
        ).toBeGreaterThan(PRESCAN_BYTES);
      }
    },
    TIMEOUT,
  );

  it(
    "input_while_an_inline_script_is_in_the_document_and_not_run_replays",
    async () => {
      // The parser stops inside the body's inline script (the server sends
      // the page in two pieces, cut in the script's text), so the script is
      // in the document and has not run; the pointer moves meanwhile, and
      // the browser dispatches its events. On replay the parser is held at
      // the gate before the script while those tasks run: the position
      // (`Loading`) must not count the script as run on either side. The
      // same thing happens when Chromium's parser yields at a script's end
      // tag before running it, which a loaded machine makes likely.
      const dir = path.join(tmp("ct-placement-pending-"), "site");
      fs.mkdirSync(dir);
      const page =
        `<!doctype html>\n<head>\n<meta charset="utf-8">\n<title>t</title>\n</head>\n` +
        `<body>\n<script>${NOTE} /*${CHUNK_MARKER}*/</script>\n<p>x</p>\n</body>`;
      fs.writeFileSync(path.join(dir, "pending.html"), page);
      const hash = buildHashOf(dir);
      execFileSync(
        process.execPath,
        [CLI, "boundary-shim", dir, "--build-hash", hash],
        { stdio: "pipe" },
      );
      const server = await serve(dir);
      const context = await browser.newContext();
      let log: Uint8Array;
      try {
        const p = await context.newPage();
        const loaded = p.goto(`${server.origin}/pending.html?chunks=600`, {
          waitUntil: "commit",
        });
        await loaded;
        // While the second piece is held back.
        for (let k = 0; k < 6; k++) {
          await p.mouse.move(20 + k * 15, 20 + k * 10);
          await new Promise((r) => setTimeout(r, 40));
        }
        for (const deadline = Date.now() + 15_000; ; ) {
          if ((await p.evaluate(() => document.readyState)) === "complete") {
            break;
          }
          if (Date.now() > deadline)
            throw new Error("pending.html did not load");
          await new Promise((r) => setTimeout(r, 20));
        }
        log = await stopAndRead(p);
      } finally {
        await context.close();
      }
      // Vacuity: an input ran after the parser had inserted the script and
      // before it ran (its clock read comes after the input).
      const records = decodeLog(log).records;
      const firstInput = records.findIndex((r) => r.record === "Input");
      const clock = records.findIndex((r) => r.record === "Clock");
      expect(firstInput, "an input was recorded").toBeGreaterThanOrEqual(0);
      expect(
        clock,
        "the script read the clock after the input",
      ).toBeGreaterThan(firstInput);
      const file = path.join(tmp("ct-placement-pending-log-"), "jsbound.log");
      fs.writeFileSync(file, log);
      const report = await replaySession({
        log: file,
        build: dir,
        browser,
        timeoutMs: 60_000,
      });
      expect(
        report.status,
        JSON.stringify(report.divergence ?? report.error),
      ).toBe("replayed");
    },
    TIMEOUT,
  );

  it(
    "the_encoding_labels_are_chromiums",
    async () => {
      // The injector's table of the Encoding Standard's labels, held to the
      // browser's: every label constructs a TextDecoder in Chromium but the
      // replacement encoding's, which no TextDecoder constructs.
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        const refused = await page.evaluate((labels) => {
          return labels.filter((l) => {
            try {
              new TextDecoder(l);
              return false;
            } catch {
              return true;
            }
          });
        }, ENCODING_LABELS as string[]);
        expect(refused.sort()).toEqual([
          "csiso2022kr",
          "hz-gb-2312",
          "iso-2022-cn",
          "iso-2022-cn-ext",
          "iso-2022-kr",
          "replacement",
        ]);
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  it("the_cli_refuses_a_page_that_is_not_utf8_and_writes_nothing", () => {
    const dir = tmp("ct-placement-refuse-");
    const good = "<!doctype html><head></head><body></body>";
    fs.writeFileSync(path.join(dir, "a.html"), good);
    // UTF-16LE with its byte order mark: not UTF-8.
    const utf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("<html><head></head></html>", "utf16le"),
    ]);
    fs.writeFileSync(path.join(dir, "b.html"), utf16);
    const r = spawnSync(process.execPath, [CLI, "boundary-shim", dir], {
      encoding: "utf-8",
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(path.join(dir, "b.html"));
    expect(r.stderr).toMatch(/not UTF-8/);
    // Nothing was written, the valid page included.
    expect(fs.readFileSync(path.join(dir, "a.html"), "utf-8")).toBe(good);
    expect(fs.readFileSync(path.join(dir, "b.html")).equals(utf16)).toBe(true);
  });
});

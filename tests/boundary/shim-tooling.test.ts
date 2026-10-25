/**
 * The Node side of `@codetracer/boundary-shim` and the two routes that
 * install it (the vite plugin's `transformIndexHtml` and the
 * `codetracer-js-recorder boundary-shim` CLI step), plus the shim's
 * synchronous SHA-256 against Node's. The browser behaviour of the shim is
 * in record-shim.test.ts.
 *
 * No mocks: real files, the built CLI as a child process, node:crypto.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  BOOTSTRAP_MARKER,
  SHIM_VERSION,
  bootstrapScript,
  injectBoundaryShim,
  stripBoundaryShim,
} from "../../packages/boundary-shim/src/index.js";
import { sha256Hex } from "../../packages/boundary-shim/src/browser/sha256.js";
import {
  ENCODING_LABELS,
  encodingLabel,
} from "../../packages/boundary-shim/src/encoding-labels.js";
import { charsetFromContent } from "../../packages/boundary-shim/src/placement.js";
import { codetracerBoundaryShimPlugin } from "../../packages/vite-plugin/src/index.js";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const CLI = path.join(REPO_ROOT, "packages/cli/dist/index.js");
const BUNDLE = "console.log('</script>');";
const TAG = bootstrapScript({}, { bundleSource: BUNDLE });
/** The bootstrap after a copy of the page's encoding declaration. */
const TAG_AFTER_COPY = TAG.replace(
  `<script ${BOOTSTRAP_MARKER}>`,
  `<script ${BOOTSTRAP_MARKER}=charset>`,
);

describe("@codetracer/boundary-shim tooling", () => {
  it("its SHA-256 agrees with node:crypto across block boundaries", () => {
    const inputs: (Uint8Array | string)[] = ["", "abc", "héllo, 世界"];
    for (let n = 0; n <= 130; n++) inputs.push(new Uint8Array(randomBytes(n)));
    for (const input of inputs) {
      const expected = createHash("sha256")
        .update(typeof input === "string" ? Buffer.from(input, "utf-8") : input)
        .digest("hex");
      expect(sha256Hex(input)).toBe(expected);
    }
  });

  it("injects the bootstrap as the first element of <head>, once", () => {
    const html =
      '<!doctype html><html lang="en"><head data-x="1"><title>t</title>' +
      '<script src="app.js"></script></head><body></body></html>';
    const once = injectBoundaryShim(html, {}, { bundleSource: BUNDLE });
    expect(once).toBe(
      html.replace('<head data-x="1">', `<head data-x="1">${TAG}`),
    );
    expect(injectBoundaryShim(once, {}, { bundleSource: BUNDLE })).toBe(once);
    expect(once.split(BOOTSTRAP_MARKER).length).toBe(2);
    // Without <head>: where the tree builder implies the head (before the
    // first start tag but <html>, here <body> and <p>).
    expect(
      injectBoundaryShim(
        "<html><body></body></html>",
        {},
        { bundleSource: BUNDLE },
      ),
    ).toBe(`<html>${TAG}<body></body></html>`);
    expect(
      injectBoundaryShim(
        "<!DOCTYPE html><p>x</p>",
        {},
        { bundleSource: BUNDLE },
      ),
    ).toBe(`<!DOCTYPE html>${TAG}<p>x</p>`);
    // `<header>` is not `<head>`.
    expect(
      injectBoundaryShim("<header></header>", {}, { bundleSource: BUNDLE }),
    ).toBe(`${TAG}<header></header>`);
  });

  it("keeps the page's encoding declaration ahead of the bootstrap", () => {
    // `|` is the bootstrap; `@` the bootstrap whose marker says a copy of
    // the page's declaration stands before it. Each injection is
    // idempotent and stripped back to the page, copy included.
    const at = (html: string, expected: string) => {
      const once = injectBoundaryShim(html, {}, { bundleSource: BUNDLE });
      expect(once, html).toBe(
        expected.replace("|", TAG).replace("@", TAG_AFTER_COPY),
      );
      expect(injectBoundaryShim(once, {}, { bundleSource: BUNDLE }), html).toBe(
        once,
      );
      expect(stripBoundaryShim(Buffer.from(once)).toString(), html).toBe(html);
    };
    // The declaration begins the head, after whitespace, a comment and
    // inert `<meta>` elements: the bootstrap follows it.
    at(
      '<head>\n <!-- c -->\n <meta name="viewport" content="w"><META CHARSET=utf-8 />\n<script></script>',
      '<head>\n <!-- c -->\n <meta name="viewport" content="w"><META CHARSET=utf-8 />|\n<script></script>',
    );
    // The `http-equiv` form, in a head the `<meta>` implies.
    at(
      '<!doctype html><meta http-equiv="Content-Type" content="text/html; charset=utf-8"><p>x',
      '<!doctype html><meta http-equiv="Content-Type" content="text/html; charset=utf-8">|<p>x',
    );
    // Inert `<meta>` elements with no declaration after them: the bootstrap
    // stays first (implying the head before them when there is no tag).
    at("<meta name=a><script></script>", "|<meta name=a><script></script>");
    at("<head><meta name=a>x", "<head>|<meta name=a>x");
    // A title, and a `charset` that names no encoding (the prescan goes on
    // past it), are inert too.
    at(
      "<head><title>t</title>\n<meta charset=utf-8><script></script>",
      "<head><title>t</title>\n<meta charset=utf-8>|<script></script>",
    );
    at(
      "<title>a<meta charset=x></title><meta charset=bogus><meta charset=utf-8>",
      "<title>a<meta charset=x></title><meta charset=bogus><meta charset=utf-8>|",
    );
    // Not a declaration that begins the head (a Content-Security-Policy,
    // which would apply to the bootstrap, even with a charset; one after a
    // script, a style sheet, text, or a `<meta http-equiv>` of another
    // kind): the bootstrap stays first, and a copy of the declaration goes
    // before it, so the prescan still finds one in the first 1024 bytes.
    at(
      '<head><meta http-equiv="content-security-policy" charset=utf-8 content="x">',
      '<head><meta charset=utf-8>@<meta http-equiv="content-security-policy" charset=utf-8 content="x">',
    );
    at(
      '<head><script>go()</script><meta charset=" UTF-8 ">',
      '<head><meta charset=UTF-8>@<script>go()</script><meta charset=" UTF-8 ">',
    );
    at(
      "<head><link rel=stylesheet href=s.css><style>p{}</style><meta http-equiv=content-type content=\"text/html; charset='iso-8859-1'\">",
      "<head><meta charset=iso-8859-1>@<link rel=stylesheet href=s.css><style>p{}</style><meta http-equiv=content-type content=\"text/html; charset='iso-8859-1'\">",
    );
    at(
      "<head>x<meta charset=utf-8>",
      "<head><meta charset=utf-8>@x<meta charset=utf-8>",
    );
    at(
      "<head><meta http-equiv=refresh content=5><meta charset=utf-8>",
      "<head><meta charset=utf-8>@<meta http-equiv=refresh content=5><meta charset=utf-8>",
    );
    // With no head tag the copy implies the head where the bootstrap would.
    at(
      "<!doctype html><script></script><meta charset=utf8>",
      "<!doctype html><meta charset=utf8>@<script></script><meta charset=utf8>",
    );
    // The declaration the prescan takes is the first naming an encoding:
    // not one in a script's text, nor a `content` without the pragma, nor
    // a label that names none.
    at(
      '<head><script>"<meta charset=koi8-r>"</script><meta content="charset=gbk"><meta charset=nope><meta http-equiv=Content-Type content="charset = shift_jis;x">',
      '<head><meta charset=shift_jis>@<script>"<meta charset=koi8-r>"</script><meta content="charset=gbk"><meta charset=nope><meta http-equiv=Content-Type content="charset = shift_jis;x">',
    );
    // No declaration at all: no copy.
    at(
      "<head><script></script><meta name=a>",
      "<head>|<script></script><meta name=a>",
    );
    // A declaration that did not end in the first 1024 bytes of the page
    // is left as it was (the window counts bytes, not characters: 400 `€`
    // are 1200 bytes).
    const far = `<!--${"€".repeat(400)}-->`;
    at(
      `<head><script></script>${far}<meta charset=utf-8>`,
      `<head>|<script></script>${far}<meta charset=utf-8>`,
    );
    const near = `<!--${"€".repeat(300)}-->`;
    at(
      `<head><script></script>${near}<meta charset=utf-8>`,
      `<head><meta charset=utf-8>@<script></script>${near}<meta charset=utf-8>`,
    );
    // A declaration's attribute value holding `>` and a duplicate
    // `http-equiv` (the tokenizer keeps the first).
    at(
      '<head><meta content="a>b; charset=utf-8" http-equiv=Content-Type http-equiv=refresh>',
      '<head><meta content="a>b; charset=utf-8" http-equiv=Content-Type http-equiv=refresh>|',
    );
  });

  it("knows the Encoding Standard's labels as Node's TextDecoder does", () => {
    // The table, held to an independent implementation: every label but
    // those Node's ICU decoder lacks (and the replacement encoding's, which
    // no TextDecoder constructs) constructs one, and names nothing else.
    const notInNode = new Set([
      "iso-8859-16",
      "x-user-defined",
      "csiso2022kr",
      "hz-gb-2312",
      "iso-2022-cn",
      "iso-2022-cn-ext",
      "iso-2022-kr",
      "replacement",
    ]);
    expect(ENCODING_LABELS.length).toBe(new Set(ENCODING_LABELS).size);
    for (const label of ENCODING_LABELS) {
      expect(encodingLabel(label.toUpperCase()), label).toBe(
        label.toUpperCase(),
      );
      if (notInNode.has(label)) continue;
      expect(() => new TextDecoder(label), label).not.toThrow();
    }
    for (const label of ["utf-7", "utf-32", "latin-1", "ebcdic", "x-bogus"]) {
      expect(encodingLabel(label), label).toBeUndefined();
      expect(() => new TextDecoder(label), label).toThrow();
    }
    expect(encodingLabel("\t utf-8 \n")).toBe("utf-8");
    // The extraction algorithm of a `content` attribute.
    expect(charsetFromContent("text/html; charset=utf-8")).toBe("utf-8");
    expect(charsetFromContent('charset ="koi8-r" x')).toBe("koi8-r");
    expect(charsetFromContent("xcharsetx; CHARSET=gbk")).toBe("gbk");
    expect(charsetFromContent("charset='utf-8")).toBeUndefined();
    expect(charsetFromContent("charset=")).toBeUndefined();
    expect(charsetFromContent("charset=nope")).toBeUndefined();
  });

  it("reads `</` as the tokenizer does", () => {
    // `</>` emits nothing, `</ x>` is a bogus comment, neither makes the
    // head: the page's `<head>` is still the first start tag.
    for (const lead of ["</>", "</ x>", "</1>"]) {
      expect(
        injectBoundaryShim(
          `${lead}<head><script></script>`,
          {},
          {
            bundleSource: BUNDLE,
          },
        ),
      ).toBe(`${lead}<head>${TAG}<script></script>`);
    }
    // `</` at the end of the document is text.
    expect(injectBoundaryShim("<html></", {}, { bundleSource: BUNDLE })).toBe(
      `<html>${TAG}</`,
    );
  });

  it("replaces and strips only a bootstrap the tokenizer sees as an element", () => {
    // Text that looks like a bootstrap, in a comment and in a script's text,
    // is the page's: injection keeps it, and stripping keeps it.
    const decoy = `<script ${BOOTSTRAP_MARKER}>decoy</script>`;
    const page =
      `<!doctype html><!-- ${decoy} --><head>` +
      `<script>var s = '${decoy.replace("</", "<\\/")}';</script>` +
      `</head><body></body>`;
    const once = injectBoundaryShim(page, {}, { bundleSource: BUNDLE });
    expect(once).toBe(page.replace("<head>", `<head>${TAG}`));
    expect(injectBoundaryShim(once, {}, { bundleSource: BUNDLE })).toBe(once);
    expect(stripBoundaryShim(Buffer.from(once)).toString()).toBe(page);
    // A byte order mark and bytes that are not ASCII survive the latin1 view.
    const bom = `\uFEFF<!DOCTYPE html><HEAD></HEAD><p>é</p>`;
    const injected = Buffer.from(
      injectBoundaryShim(bom, {}, { bundleSource: BUNDLE }),
    );
    expect(injected.toString()).toBe(bom.replace("<HEAD>", `<HEAD>${TAG}`));
    expect(stripBoundaryShim(injected).toString()).toBe(bom);
  });

  it("cannot be closed early by the bundle or the configuration", () => {
    const tag = bootstrapScript(
      { buildHash: "</script><script>alert(1)</script>" },
      { bundleSource: BUNDLE },
    );
    // One closing tag: the element's own.
    expect(tag.match(/<\/script/gi)).toEqual(["</script"]);
    expect(tag.endsWith("</script>")).toBe(true);
  });

  it("the vite plugin's transformIndexHtml is the same injection", () => {
    const html = "<html><head><title>t</title></head><body></body></html>";
    const plugin = codetracerBoundaryShimPlugin({ buildHash: "ab".repeat(32) });
    expect(plugin.transformIndexHtml(html)).toBe(
      injectBoundaryShim(html, { buildHash: "ab".repeat(32) }),
    );
    expect(plugin.transformIndexHtml(html)).toContain(
      `<head><script ${BOOTSTRAP_MARKER}>`,
    );
  });

  it("the CLI step injects into every page under a directory, idempotently", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-boundary-cli-"));
    try {
      fs.mkdirSync(path.join(dir, "sub"));
      fs.writeFileSync(path.join(dir, "a.html"), "<html><head></head></html>");
      fs.writeFileSync(
        path.join(dir, "sub", "b.html"),
        "<html><head></head></html>",
      );
      fs.writeFileSync(path.join(dir, "c.js"), "x");
      const hash = "cd".repeat(32);
      const first = execFileSync(
        process.execPath,
        [CLI, "boundary-shim", dir, "--build-hash", hash],
        { encoding: "utf-8" },
      );
      expect(first.trim().split("\n")).toEqual([
        `injected: ${path.join(dir, "a.html")}`,
        `injected: ${path.join(dir, "sub", "b.html")}`,
      ]);
      const page = fs.readFileSync(path.join(dir, "sub", "b.html"), "utf-8");
      expect(page.startsWith(`<html><head><script ${BOOTSTRAP_MARKER}>`)).toBe(
        true,
      );
      expect(page).toContain(`"buildHash":"${hash}"`);
      expect(fs.readFileSync(path.join(dir, "c.js"), "utf-8")).toBe("x");
      const second = execFileSync(
        process.execPath,
        [CLI, "boundary-shim", dir, "--build-hash", hash],
        { encoding: "utf-8" },
      );
      expect(second).toContain(`unchanged: ${path.join(dir, "a.html")}`);
      expect(fs.readFileSync(path.join(dir, "sub", "b.html"), "utf-8")).toBe(
        page,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the CLI step refuses a build hash that is not a lowercase SHA-256", () => {
    const r = spawnSync(
      process.execPath,
      [CLI, "boundary-shim", ".", "--build-hash", "ABC"],
      { encoding: "utf-8" },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--build-hash must be 64 lowercase hex digits");
  });

  it("the CLI step refuses an ingest without a build hash, and consent without an ingest", () => {
    const hash = "0123456789abcdef".repeat(4);
    for (const [args, message] of [
      [["--ingest", "/ingest"], "--ingest needs --build-hash"],
      [["--build-hash", hash, "--ingest", ""], "--ingest needs a URL"],
      [
        ["--build-hash", hash, "--consent-required"],
        "--consent-required needs --ingest",
      ],
    ] as const) {
      const r = spawnSync(
        process.execPath,
        [CLI, "boundary-shim", ".", ...args],
        { encoding: "utf-8" },
      );
      expect(r.status, args.join(" ")).toBe(1);
      expect(r.stderr).toContain(message);
    }
  });

  it("declares the package's version as the recorder version", () => {
    const pkg = JSON.parse(
      fs.readFileSync(
        path.join(REPO_ROOT, "packages/boundary-shim/package.json"),
        "utf-8",
      ),
    ) as { version: string };
    expect(SHIM_VERSION).toBe(pkg.version);
  });
});

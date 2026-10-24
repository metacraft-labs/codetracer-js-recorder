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
import { codetracerBoundaryShimPlugin } from "../../packages/vite-plugin/src/index.js";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const CLI = path.join(REPO_ROOT, "packages/cli/dist/index.js");
const BUNDLE = "console.log('</script>');";
const TAG = bootstrapScript({}, { bundleSource: BUNDLE });

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
    const at = (html: string, expected: string) =>
      expect(injectBoundaryShim(html, {}, { bundleSource: BUNDLE }), html).toBe(
        expected.replace("|", TAG),
      );
    // The declaration begins the head, after whitespace, a comment and
    // inert `<meta>` elements: the bootstrap follows it.
    at(
      '<head>\n <!-- c -->\n <meta name="viewport" content="w"><META CHARSET=utf-8/>\n<script></script>',
      '<head>\n <!-- c -->\n <meta name="viewport" content="w"><META CHARSET=utf-8/>|\n<script></script>',
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
    // Not a declaration that begins the head: a Content-Security-Policy
    // (it would apply to the bootstrap) even with a charset, one after a
    // title, after text, or after a `<meta http-equiv>` of another kind.
    at(
      '<head><meta http-equiv="content-security-policy" charset=utf-8 content="x">',
      '<head>|<meta http-equiv="content-security-policy" charset=utf-8 content="x">',
    );
    at(
      "<head><title>t</title><meta charset=utf-8>",
      "<head>|<title>t</title><meta charset=utf-8>",
    );
    at("<head>x<meta charset=utf-8>", "<head>|x<meta charset=utf-8>");
    at(
      "<head><meta http-equiv=refresh content=5><meta charset=utf-8>",
      "<head>|<meta http-equiv=refresh content=5><meta charset=utf-8>",
    );
    // A declaration's attribute value holding `>` and a duplicate
    // `http-equiv` (the tokenizer keeps the first).
    at(
      '<head><meta content="a>b" http-equiv=Content-Type http-equiv=refresh>',
      '<head><meta content="a>b" http-equiv=Content-Type http-equiv=refresh>|',
    );
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

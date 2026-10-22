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
    // Without <head>: after <html …>; without that: after the doctype.
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

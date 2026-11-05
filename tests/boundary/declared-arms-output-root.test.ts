/** Real filesystem custody tests; no DOM, recorder, compiler or path mocks. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveControlOutputRoot } from "./declared-arms-output-root.mjs";

let root: string;
let source: string;
let alias: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-arms-output-"));
  source = path.join(root, "source");
  alias = path.join(root, "alias");
  fs.mkdirSync(source);
  fs.symlinkSync(source, alias, "junction");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("declared-arms output custody", () => {
  it("rejects the exact input root without writing", () => {
    expect(() => resolveControlOutputRoot(source, source)).toThrow(
      "outputs must be outside source",
    );
    expect(fs.readdirSync(source)).toEqual([]);
  });
  it("rejects a not-yet-created input descendant without creating it", () => {
    expect(() =>
      resolveControlOutputRoot(source, path.join(source, "new", "output")),
    ).toThrow("outputs must be outside source");
    expect(fs.readdirSync(source)).toEqual([]);
  });
  it("rejects an existing alias of the input root", () => {
    expect(() => resolveControlOutputRoot(source, alias)).toThrow(
      "outputs must be outside source",
    );
    expect(fs.readdirSync(source)).toEqual([]);
  });
  it("rejects a missing descendant reached through an input alias", () => {
    expect(() =>
      resolveControlOutputRoot(source, path.join(alias, "new", "output")),
    ).toThrow("outputs must be outside source");
    expect(fs.readdirSync(source)).toEqual([]);
  });
  it("resolves the input root itself through an alias", () => {
    expect(() =>
      resolveControlOutputRoot(alias, path.join(source, "output")),
    ).toThrow("outputs must be outside source");
    expect(fs.readdirSync(source)).toEqual([]);
  });
  it("accepts a new external output without creating directories", () => {
    const requested = path.join(root, "external", "output");
    expect(resolveControlOutputRoot(source, requested)).toBe(requested);
    expect(fs.existsSync(path.join(root, "external"))).toBe(false);
  });
  it("accepts a sibling sharing the input path prefix", () => {
    const requested = path.join(root, "source-other");
    expect(resolveControlOutputRoot(source, requested)).toBe(requested);
    expect(fs.existsSync(requested)).toBe(false);
  });
  it("fails closed on a dangling alias without writing into its target", () => {
    const target = path.join(source, "missing");
    const dangling = path.join(root, "dangling");
    fs.symlinkSync(target, dangling, "junction");
    expect(() =>
      resolveControlOutputRoot(source, path.join(dangling, "output")),
    ).toThrow();
    expect(fs.readdirSync(source)).toEqual([]);
  });
});

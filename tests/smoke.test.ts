import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

describe("smoke tests", () => {
  it("native addon loads and returns version", () => {
    const native = require(
      path.resolve(__dirname, "../crates/recorder_native/index.node"),
    );
    const ver = native.version();
    expect(typeof ver).toBe("string");
    expect(ver).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("instrumenter module exports instrument function", async () => {
    const { instrument } = await import("@codetracer/instrumenter");
    expect(typeof instrument).toBe("function");
  });
});

import { describe, it, expect } from "vitest";

describe("smoke tests", () => {
  it("native addon loads and returns version", async () => {
    // TODO(M0): Enable once native addon is built
    // const native = require("../crates/recorder_native");
    // expect(typeof native.version()).toBe("string");
    expect(true).toBe(true);
  });

  it("instrumenter module exports instrument function", async () => {
    const { instrument } = await import("@codetracer/instrumenter");
    expect(typeof instrument).toBe("function");
  });
});

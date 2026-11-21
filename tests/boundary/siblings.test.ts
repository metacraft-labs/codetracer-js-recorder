/**
 * Where the boundary tests look for codetracer's cargo binaries
 * (`siblings.ts`): with the host's executable suffix, release before debug.
 *
 * A probe without the suffix finds nothing on Windows, where cargo links
 * `ct-jsbound.exe`: the replay tests then failed as "not built" right after
 * CI built both binaries, and the full-stack browser test skipped itself.
 *
 * No mocks: the functions are pure, and the platform is a parameter.
 */

import { describe, expect, it } from "vitest";

import { cargoBinaryCandidates, cargoBinaryName } from "./siblings.js";

describe("codetracer sibling binary names", () => {
  it("carries the .exe suffix on Windows only", () => {
    expect(cargoBinaryName("ct-jsbound", "win32")).toBe("ct-jsbound.exe");
    expect(cargoBinaryName("ct-jsbound", "linux")).toBe("ct-jsbound");
    expect(cargoBinaryName("ct-jsbound", "darwin")).toBe("ct-jsbound");
  });

  it("probes release, then debug, under the crate's own target directory", () => {
    const file = cargoBinaryName("session-manager");
    expect(
      cargoBinaryCandidates(
        "codetracer/src/backend-manager",
        "session-manager",
      ),
    ).toEqual([
      `codetracer/src/backend-manager/target/release/${file}`,
      `codetracer/src/backend-manager/target/debug/${file}`,
    ]);
  });
});

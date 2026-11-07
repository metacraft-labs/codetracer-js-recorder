import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Tests that drive a subprocess (the CLI, a bundler, the recorder) or a
    // browser take a second or two on an idle host and well past vitest's
    // 5 s default on a busy one (measured with eight cores shared by 64 CPU
    // hogs: CLI tooling, fetch-factories and benchmark_trace_size tests at 5
    // to 16 s). No test asserts a speed through its timeout; those that
    // measure one do it inside the test, against a reference. So the timeout
    // is only a hang guard, as the suites that set their own already treat
    // it, and a test that hangs still fails.
    testTimeout: 60_000,
    // Setup and teardown hooks launch Chromium, start fixture servers and
    // build fixtures: a few seconds on an idle host, past vitest's 10 s
    // default on a busy one (measured: gates.test.ts's Chromium launch, with
    // two cores shared by 24 CPU hogs and three other browser suites). No
    // assertion depends on how long a hook takes, so this is only a hang
    // guard; most suites already gave their hooks 120 s or more by hand.
    hookTimeout: 120_000,
  },
});

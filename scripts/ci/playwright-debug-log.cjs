// playwright-debug-log.cjs -- give every Node process its own Playwright debug
// log file. A CI diagnostic, loaded with `node --require` (NODE_OPTIONS) by
// .github/workflows/ci-reprobuild.yml; it does nothing unless
// CT_PLAYWRIGHT_DEBUG_DIR is set.
//
// Why: playwright-core writes its `DEBUG=pw:*` output to the file named by
// DEBUG_FILE instead of stderr (lib/server/utils/debugLogger.js), but opens
// that file with fs.createWriteStream's default "w" flag, i.e. truncating it.
// `just test` runs Playwright in many processes at once -- one per vitest
// worker, plus the CLIs the tests spawn (boundary-conformance,
// boundary-replay) -- so a single DEBUG_FILE would be truncated and
// overwritten by each of them, and the log of the browser that crashed would
// be lost. Each process therefore gets `<dir>/pw-<pid>.log`. The variable is
// rewritten in every process this preload runs in, so a child never inherits
// and truncates its parent's file.
//
// What it changes: only DEBUG_FILE in this process's environment, after making
// sure its directory exists. It loads no module the tests use and writes no log
// itself; playwright-core creates the file when (and only if) the process loads
// it.
// https://playwright.dev/docs/debug#verbose-api-logs (the `DEBUG=pw:*` names)

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const dir = process.env.CT_PLAYWRIGHT_DEBUG_DIR;
if (dir) {
  // playwright-core does not create the directory, and a write stream that
  // cannot open its file emits an unhandled "error" that would kill the test
  // process. So the variable is set only once the directory exists: a
  // diagnostic that cannot be written is skipped, never a cause of failure.
  try {
    fs.mkdirSync(dir, { recursive: true });
    process.env.DEBUG_FILE = path.join(dir, `pw-${process.pid}.log`);
  } catch (error) {
    process.stderr.write(
      `playwright-debug-log: not logging to ${dir}: ${error.message}\n`,
    );
  }
}

/**
 * Sample program for the launcher <-> recorder compatibility E2E.
 *
 * WHAT THIS IS FOR
 *   `codetracer/ci/test/launcher-recorder-e2e.sh` records this file through the
 *   REAL `ct` launcher binary:
 *
 *       ct record launcher_compat_sample.js -o <trace-dir>
 *         -> codetracer-launcher routes `.js` from the codetracer-desktop
 *            capability file and execv()s the desktop core
 *            -> the core dispatches
 *               `codetracer-js-recorder record --out-dir <dir> <program>`
 *               -> the recorder instruments and runs it, writing a CTFS trace
 *                  -> `ct-print` (codetracer-trace-format-nim) decodes it
 *
 *   `.js` is the extension milestone LRC-1 ADDED to
 *   `codetracer/resources/codetracer-desktop-capabilities`: before that fix the
 *   launcher refused to route `ct record app.js` at all, even though this
 *   recorder existed.  This edge is the end-to-end proof that the fix works, so
 *   if the declaration is ever lost the run must FAIL here rather than skip.
 *
 *   The driver asserts the DECODED trace against the expectations declared in
 *   `cross-repo/launcher-compat.yml`, so everything this file prints or calls is
 *   part of a checked contract.  Changing a function name or a printed line here
 *   means changing that file in the same commit.
 *
 * WHY IT PRINTS `CODETRACER_COMPONENT_DIR`
 *   `CODETRACER_COMPONENT_DIR` is exported by the LAUNCHER and by nothing else
 *   on this path (codetracer-launcher/src/launcher.nim sets it right before
 *   `execv`-ing the component's binary).  Seeing it inside the recorded trace's
 *   stdout is therefore positive evidence that the recording really travelled
 *   launcher -> desktop core -> recorder, rather than the driver having invoked
 *   the core (or the recorder) directly.  A test that only checked "a trace
 *   appeared" could not tell those apart.
 *
 * KEEP THIS PROGRAM BORING
 *   Fixed inputs, deterministic output, no clock, no network, no randomness, no
 *   imports at all.  The trace it produces is compared against exact
 *   expectations; anything non-deterministic would make the gate flaky.
 */

const MARKER = "launcher-recorder-e2e";

// Fixed inputs -- the expected sum below is asserted by the driver.
const VALUES = [1, 2, 3, 4, 5];

// Sum `values` with an explicit loop so the trace has real steps.
function accumulate(values) {
  let total = 0;
  for (const value of values) {
    total = total + value;
  }
  return total;
}

// Report the component directory the launcher exported for this run.
function describeLauncherRoute() {
  return process.env.CODETRACER_COMPONENT_DIR || "<unset>";
}

function main() {
  const total = accumulate(VALUES);
  console.log(MARKER + ": total=" + total);
  console.log(MARKER + ": component-dir=" + describeLauncherRoute());
  return total;
}

main();

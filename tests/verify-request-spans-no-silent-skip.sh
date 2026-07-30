#!/usr/bin/env bash
# Verify that the RS-M9 web-request span coverage is really there and really
# running (no silent skip — every assertion either passes or fails loudly).
#
# Why this exists: the milestone's tests are the only thing standing between a
# working Request Panel row for JavaScript and a plausible-looking one.  The
# failure modes this guards against are the ones the earlier language
# milestones in this initiative actually hit:
#
#   * the test file drifts out of the runner's discovery glob and stops
#     running while still passing CI (an "orphan" test);
#   * the required test names are renamed or removed, so a grep-based gate
#     elsewhere keeps passing against nothing;
#   * a test is quarantined with `.skip` / `.todo` / `.only` and nobody
#     notices;
#   * the falsifiable claims (contiguity taking both values, concurrency
#     appearing only when requests overlap, step ranges tracking the writer's
#     counter) are gutted down to prose while the file still parses.
#
# The last one is the important one, and it is why this script asserts on
# ASSERTION EXPRESSIONS rather than on comments or test titles: a gate that
# greps documentation passes on a test whose body has been deleted.
#
# Wire-up: see `Justfile` (`just lint` and `just test` both run this script)
# and `package.json` (the `test:verify-request-spans` script).
#
# Exit codes:
#   0  all assertions held
#   1  at least one assertion failed (the failing assertion is printed to
#      stderr and the script exits at the first failure for clarity)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

SPAN_TEST="${REPO_ROOT}/tests/web/express-spans.test.ts"
VITEST_CONFIG="${REPO_ROOT}/vitest.config.ts"
MIDDLEWARE="${REPO_ROOT}/packages/express/src/index.ts"
DEMO_APP="${REPO_ROOT}/test-programs/web/express/app.js"
DEMO_DRIVER="${REPO_ROOT}/test-programs/web/express/index.js"
NATIVE_SPANS="${REPO_ROOT}/crates/recorder_native/src/spans.rs"
NATIVE_LIB="${REPO_ROOT}/crates/recorder_native/src/lib.rs"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

require_file() {
  [[ -f "$1" ]] || fail "missing required file: $1"
  echo "[verify] present: ${1#"${REPO_ROOT}/"}"
}

require_in_file() {
  # require_in_file <needle> <file> <why>
  local needle="$1" file="$2" why="$3"
  grep -qF -- "${needle}" "${file}" \
    || fail "${file#"${REPO_ROOT}/"} no longer contains '${needle}' — ${why}"
  echo "[verify] ok: ${why}"
}

refute_in_file() {
  # refute_in_file <extended-regex> <file> <why>
  local pattern="$1" file="$2" why="$3"
  if grep -qE -- "${pattern}" "${file}"; then
    fail "${file#"${REPO_ROOT}/"} matches /${pattern}/ — ${why}"
  fi
  echo "[verify] ok: ${why}"
}

# ---------------------------------------------------------------------------
# 1. The deliverables exist
# ---------------------------------------------------------------------------

require_file "${SPAN_TEST}"
require_file "${MIDDLEWARE}"
require_file "${DEMO_APP}"
require_file "${DEMO_DRIVER}"
require_file "${NATIVE_SPANS}"

# ---------------------------------------------------------------------------
# 2. The test file is discovered by the runner
# ---------------------------------------------------------------------------
#
# vitest collects `tests/**/*.test.ts`; a file outside that glob is an orphan
# that passes CI by never running.

require_in_file 'tests/**/*.test.ts' "${VITEST_CONFIG}" \
  "vitest must still collect tests/web/express-spans.test.ts"
[[ "${SPAN_TEST}" == "${REPO_ROOT}/tests/"*".test.ts" ]] \
  || fail "the span test is outside vitest's collection glob"
echo "[verify] ok: the span test sits inside vitest's collection glob"

# ---------------------------------------------------------------------------
# 3. The required test names are present and not quarantined
# ---------------------------------------------------------------------------

require_in_file 'describe("express_requests_land_in_span_stream"' "${SPAN_TEST}" \
  "RS-M9 names this test explicitly"
require_in_file 'describe("express_span_step_ranges_track_the_writers_counter"' \
  "${SPAN_TEST}" "the step-index control must stay"
require_in_file 'describe("express_span_contiguity_reflects_the_event_loop"' \
  "${SPAN_TEST}" "the contiguity/concurrency control must stay"

refute_in_file '(describe|it|test)\.(skip|todo|only)' "${SPAN_TEST}" \
  "no span test may be quarantined or run in isolation"

# ---------------------------------------------------------------------------
# 4. The falsifiable assertions are still assertions
# ---------------------------------------------------------------------------
#
# Each needle below is an expression, not a comment: deleting the check that
# makes a structural claim checkable fails here even if the surrounding prose
# survives.

require_in_file 'expect(seqContiguous.length).toBeGreaterThan(0)' "${SPAN_TEST}" \
  "contiguous_on_one_thread must be shown to be true somewhere"
require_in_file 'expect(seqSplit.length).toBeGreaterThan(0)' "${SPAN_TEST}" \
  "contiguous_on_one_thread must be shown to be false somewhere"
require_in_file 'expect(sequential.every((s) => !s.concurrent_with_siblings)).toBe(true)' \
  "${SPAN_TEST}" "a sequential schedule must report no overlap"
require_in_file 'expect(nested).toBe(true)' "${SPAN_TEST}" \
  "a concurrent schedule must produce a genuinely nested pair"
require_in_file 'expect(span.start_step).toBeGreaterThan(other.start_step)' \
  "${SPAN_TEST}" \
  "span ranges must be shown to move when the writer emits extra exec events"
require_in_file 'expect(recording.all).toHaveLength(REQUIRED_SCHEDULE.length * 2)' \
  "${SPAN_TEST}" "every span must publish an open record and a settled record"

# ---------------------------------------------------------------------------
# 5. The spans are read through the canonical Nim decoder
# ---------------------------------------------------------------------------
#
# A JavaScript re-implementation of the span wire format would let the tests
# agree with a recorder bug.  The test must go through `readSpans`, which
# calls the addon's `readSpanStream` binding to `initSpanStreamReader`.

require_in_file 'from "../../packages/cli/src/read-spans-cmd.js"' "${SPAN_TEST}" \
  "spans must be decoded by the canonical Nim reader, not parsed in JS"
require_in_file 'readSpanStream' "${REPO_ROOT}/packages/cli/src/read-spans-cmd.ts" \
  "read-spans must still route through the native Nim reader binding"

# ---------------------------------------------------------------------------
# 6. No sidecar
# ---------------------------------------------------------------------------
#
# RS-M9 is inline-bound spans.  A middleware that started writing a JSONL
# sidecar would satisfy every assertion above and still be the thing this
# initiative exists to remove.

refute_in_file 'appendFileSync|writeFileSync|createWriteStream|node:fs' \
  "${MIDDLEWARE}" \
  "the Express middleware must not write any file — spans go into the container"
refute_in_file 'File::create|OpenOptions|fs::write' "${NATIVE_SPANS}" \
  "the native span writer must not write any file — spans go into the container"
require_in_file 'writer.register_span(&record)' "${NATIVE_LIB}" \
  "spans must be registered through the container's own span-stream writer"
require_in_file 'writer.next_step_index()' "${NATIVE_LIB}" \
  "span step ids must come from the writer's exec-event counter, never a self-maintained one"

# ---------------------------------------------------------------------------
# 7. The demo app still exercises what the milestone claims
# ---------------------------------------------------------------------------

require_in_file 'await sleep(50)' "${DEMO_APP}" \
  "the demo must keep a handler that awaits inside its span"
require_in_file 'throw new Error("demo handler exploded")' "${DEMO_APP}" \
  "the demo must keep a handler that fails"
require_in_file 'codetracerExpress()' "${DEMO_APP}" \
  "the demo must install the span middleware"
require_in_file 'CT_EXPRESS_CONCURRENT' "${DEMO_DRIVER}" \
  "the driver must still offer the interleaved schedule the controls need"

echo "[verify] all RS-M9 span assertions held"

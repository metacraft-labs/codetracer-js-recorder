#!/usr/bin/env bash
# Verify that the codetracer-js-recorder CLI complies with
# `Recorder-CLI-Conventions.md` (no silent skip — every assertion
# either passes or fails loudly):
#
#   * `--format` is absent from `--help` (CTFS-only — convention §4)
#   * `CODETRACER_FORMAT` is absent from `--help` (convention §5)
#   * `--out-dir` is present in `--help` (§3)
#   * `--help` mentions `ct print` (the canonical conversion tool, §4)
#   * `CODETRACER_JS_RECORDER_OUT_DIR` is referenced in source so the
#     env-var fallback (§5) cannot regress silently.
#   * `CODETRACER_JS_RECORDER_DISABLED` is referenced in source so the
#     disable-recording env-var (§5) cannot regress silently.
#   * The recorder's output dispatch in `crates/recorder_native/src/lib.rs`
#     no longer mentions the legacy `trace.json` events sidecar (CTFS-
#     only — §4).
#
# Wire-up: see `Justfile` (`just lint` and `just test` both run this
# script) and `package.json` (the `test:verify-cli-convention` script).
#
# Exit codes:
#   0  all assertions held
#   1  at least one assertion failed (the failing line is printed to
#      stderr and the script exits at the first failure for clarity)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# The CLI is a Node.js entry — no separate compiled binary.  We invoke
# the built JS via node.  `npm run build` is expected to have been
# called already; when running standalone, callers should ensure that.
CLI_DIST="${REPO_ROOT}/packages/cli/dist/index.js"
if [[ ! -f "${CLI_DIST}" ]]; then
  echo "ERROR: CLI bundle not found at ${CLI_DIST}" >&2
  echo "Run 'npm run build' first." >&2
  exit 1
fi

NODE_BIN="$(command -v node || true)"
if [[ -z "${NODE_BIN}" ]]; then
  echo "ERROR: node not on PATH" >&2
  exit 1
fi

run_cli() {
  "${NODE_BIN}" "${CLI_DIST}" "$@"
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

assert_absent() {
  # assert_absent <needle> <haystack-description> <haystack>
  local needle="$1"
  local desc="$2"
  local haystack="$3"
  if grep -qF -- "${needle}" <<< "${haystack}"; then
    echo "FAIL: ${desc} must NOT contain '${needle}'" >&2
    echo "----- ${desc} -----" >&2
    echo "${haystack}" >&2
    echo "-------------------" >&2
    exit 1
  fi
  echo "ok: '${needle}' absent from ${desc}"
}

assert_present() {
  # assert_present <needle> <haystack-description> <haystack>
  local needle="$1"
  local desc="$2"
  local haystack="$3"
  if ! grep -qF -- "${needle}" <<< "${haystack}"; then
    echo "FAIL: ${desc} must contain '${needle}'" >&2
    echo "----- ${desc} -----" >&2
    echo "${haystack}" >&2
    echo "-------------------" >&2
    exit 1
  fi
  echo "ok: '${needle}' present in ${desc}"
}

# ---------------------------------------------------------------------------
# Top-level --help
# ---------------------------------------------------------------------------

TOP_HELP="$(run_cli --help)"

assert_absent "--format" "top-level --help" "${TOP_HELP}"
assert_absent "CODETRACER_FORMAT" "top-level --help" "${TOP_HELP}"
assert_present "--help" "top-level --help" "${TOP_HELP}"
assert_present "ct print" "top-level --help" "${TOP_HELP}"

# ---------------------------------------------------------------------------
# `record` subcommand --help
# ---------------------------------------------------------------------------

RECORD_HELP="$(run_cli record --help)"

assert_absent "--format" "record --help" "${RECORD_HELP}"
assert_absent "CODETRACER_FORMAT" "record --help" "${RECORD_HELP}"
assert_present "--out-dir" "record --help" "${RECORD_HELP}"
assert_present "ct print" "record --help" "${RECORD_HELP}"

# ---------------------------------------------------------------------------
# Source-level references for env-var fallbacks
# ---------------------------------------------------------------------------

# The recorder must reference `CODETRACER_JS_RECORDER_OUT_DIR` in source
# (otherwise the env-var fallback either doesn't exist or has been
# silently removed).  We grep across the TS packages and Rust crate.
if ! grep -rqF "CODETRACER_JS_RECORDER_OUT_DIR" \
       "${REPO_ROOT}/packages" "${REPO_ROOT}/crates"; then
  echo "FAIL: CODETRACER_JS_RECORDER_OUT_DIR must be referenced in packages/ or crates/" >&2
  exit 1
fi
echo "ok: CODETRACER_JS_RECORDER_OUT_DIR referenced in source"

if ! grep -rqF "CODETRACER_JS_RECORDER_DISABLED" \
       "${REPO_ROOT}/packages" "${REPO_ROOT}/crates"; then
  echo "FAIL: CODETRACER_JS_RECORDER_DISABLED must be referenced in packages/ or crates/" >&2
  exit 1
fi
echo "ok: CODETRACER_JS_RECORDER_DISABLED referenced in source"

# ---------------------------------------------------------------------------
# Native crate: no `trace.json` events sidecar dispatch
# ---------------------------------------------------------------------------

# The native crate's `flush_and_stop` used to write a `trace.json` events
# sidecar in addition to the CTFS `.ct` container.  Convention §4 makes
# the recorder CTFS-only; the events sidecar must be gone from the
# write path.  We allow the string in comments/docs but not in any
# `fs::write` call site.
if grep -nE 'fs::write\([^)]*"trace\.json"' \
   "${REPO_ROOT}/crates/recorder_native/src/lib.rs"; then
  echo "FAIL: native crate must not write trace.json (CTFS-only)" >&2
  exit 1
fi
echo "ok: native crate has no trace.json fs::write call"

# ---------------------------------------------------------------------------
# Native addon: no `format` parameter on the startRecording N-API
# ---------------------------------------------------------------------------

# The addon's `start_recording` used to extract a `format` named
# property from the N-API options object.  Convention §4 means there is
# no format selector — the N-API surface must not require it.
if grep -nE '"format"' \
   "${REPO_ROOT}/crates/recorder_native/src/lib.rs" \
   | grep -v '//' \
   | grep -qE '"format"'; then
  # Allow the pinned "ctfs" string literal used to populate
  # TraceMetadata.format; reject any other "format" literal.
  if grep -nE '"format"' "${REPO_ROOT}/crates/recorder_native/src/lib.rs" \
     | grep -vE '//.*' \
     | grep -vE '"ctfs"' \
     | grep -qE '"format"'; then
    echo "FAIL: native crate still references the \"format\" N-API parameter" >&2
    exit 1
  fi
fi
echo "ok: native crate's startRecording N-API has no \"format\" parameter"

echo "verify-cli-convention-no-silent-skip: all checks passed"

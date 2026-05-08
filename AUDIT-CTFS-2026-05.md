# JavaScript Recorder CTFS Audit — 2026-05-08

This audit checks `codetracer-js-recorder` against the CTFS-only contract
of `codetracer-specs/Recorder-CLI-Conventions.md` §4 (CTFS-only output)
and §5 (env-var fallbacks).  The 2026-05-02 round of recorder audits
established the CTFS-default pattern across Cairo, Cardano, Circom,
Flow, Fuel and EVM recorders; this entry documents the analogous
follow-up for the JS recorder.

The JS recorder is a Node-native pipeline:

* `packages/cli` — TypeScript CLI (`codetracer-js-recorder` binary,
  invoked as `node packages/cli/dist/index.js`).  Provides `instrument`
  and `record` subcommands.
* `packages/instrumenter` — Source-to-source JS/TS instrumentation
  (Babel-based).
* `packages/runtime` — Runtime library injected into instrumented
  programs to capture trace events.
* `crates/recorder_native` — Rust N-API addon (via napi-rs) that
  consumes the runtime's event buffer and writes the on-disk trace
  via `NimTraceWriter` (sibling-path dep on
  `codetracer-trace-format-nim::codetracer_trace_writer_nim`).

The recorder uses the **Rust-native NimTraceWriter** path, not the C
FFI, so every canonical entry point (`register_call`, `arg`,
`register_special_event`, `register_thread_*`) is reachable.

## Convention compliance follow-up — 2026-05-08

Pre-2026-05-08 the JS recorder accepted a `--format json|binary` flag
on the `record` subcommand and wrote both the canonical CTFS `.ct`
container and a parallel `trace.json` events sidecar.  The runtime
also read `CODETRACER_FORMAT` from the environment to set a default
format on the addon side.

Subsequent to the 2026-05-02 audits, `Recorder-CLI-Conventions.md` §4
in `codetracer-specs` was tightened to require **CTFS-only** output:
recorders no longer accept a `--format` flag and `ct print` (shipped
with `codetracer-trace-format-nim`) is the canonical conversion tool
for human-readable output.  `Repo-Requirements.md` §2.2 / §2.3 reflect
this contract.

This entry records the convention-compliance changes applied to the
JS recorder on 2026-05-08:

### CLI surface

* `--format` was removed from `packages/cli/src/index.ts` (top-level
  `--help` text) and from `packages/cli/src/record-cmd.ts`
  (`parseArgs` + the `record --help` subcommand text).  Unknown flags
  are now rejected with an "unexpected argument" diagnostic and
  exit code 2 — the parser previously ignored them silently which
  would have allowed `--format json` to be silently consumed as the
  positional `<file>` argument after the flag was removed.
* `-o` was added as a short alias for `--out-dir` (per
  `Recorder-CLI-Conventions.md` §3).
* The `--help` output now mentions `ct print` from
  `codetracer-trace-format-nim` as the canonical conversion tool,
  documents `CODETRACER_JS_RECORDER_OUT_DIR` and
  `CODETRACER_JS_RECORDER_DISABLED` environment variables, and
  states explicitly that the recorder always writes the canonical
  CTFS multi-stream container.
* `CODETRACER_JS_RECORDER_OUT_DIR` is now honoured at the CLI layer
  as a fallback for `--out-dir`.  Lookup order: CLI flag → env var →
  `./ct-traces/`.
* `CODETRACER_JS_RECORDER_DISABLED=1` (or `true`) at the CLI layer
  exits cleanly with a notice and no trace artefacts.  The
  pre-existing runtime-layer disable path
  (`packages/runtime/src/config.ts`) still applies for cases where
  the runtime is loaded as a library.

### Runtime surface

* `packages/runtime/src/config.ts` no longer reads `CODETRACER_FORMAT`.
  The `RuntimeConfig.format` field was removed and the disabled-env
  check now accepts both `"true"` and `"1"` (was previously only
  `"true"`).
* `packages/runtime/src/runtime.ts` `NativeAddon.startRecording` no
  longer takes a `format` parameter.  `StartRecordingOptions.format`
  was removed.

### Native addon surface

* `crates/recorder_native/src/lib.rs::start_recording` (the N-API
  entry point) no longer extracts a `"format"` named property from
  the options object.
* `RecorderState.format` was removed.  The Nim writer in
  `write_binary_trace` is hard-pinned to `NimTraceFormat::Binary`
  (which the underlying Nim writer treats as CTFS — see
  `codetracer-trace-format/codetracer_trace_writer_nim/src/lib.rs:297`
  for the alias).
* The legacy `trace.json` events-sidecar write was removed from
  `flush_and_stop`.  The recorder now produces only the canonical
  CTFS `.ct` container plus the operational `trace_metadata.json`
  and `trace_paths.json` sidecars (consumed by the `ct` CLI to
  register the trace).
* `TraceMetadata.format` is hard-pinned to `"ctfs"` (no longer
  reflects the absent CLI/env flag).

### Test rewrites

Tests that previously asserted on `--format json`-produced
`trace.json` content were rewritten to record via the canonical CTFS
path and pipe the produced `.ct` container through `ct print --json`
for content assertions.  The new helper
`tests/helpers/ct-print.ts` discovers the `ct-print` binary in the
sibling `codetracer-trace-format-nim` repo (override via the
`CT_PRINT` env var) and exposes:

* `ctPrintAvailable()` — returns `false` when `ct-print` isn't
  reachable; tests guard with this and emit `console.warn("SKIP …")`
  rather than silently passing.  The shell-level guard at
  `tests/verify-cli-convention-no-silent-skip.sh` ensures the CLI
  surface stays compliant even when ct-print-dependent content
  assertions are skipped.
* `findCtFile(traceDir)` — locates the `<program>.ct` container in
  a recorded trace directory.
* `ctPrintJson(ctFile)` — runs `ct-print --json` and parses the
  result; the parsed shape is exposed via the `CtPrintBundle`
  interface.

Rewritten test files:

* `tests/e2e/e2e.test.ts` — `e2e_record_simple_program` and
  `e2e_record_multi_file` blocks now use ct-print's `paths`,
  `functions`, `steps`, `ioEvents` anchors.
* `tests/e2e/ctfs-audit.test.ts` — handoff-1.38 audit fixes (Call
  args, stderr Write/WriteOther, thread events) now assert on
  `bundle.values[].varname` and `bundle.ioEvents[].kind` instead of
  the `trace.json` event-by-event shape.
* `tests/e2e/ct-binary.test.ts` — `--format json` test replaced by
  a `--format` rejection test.  The legacy `trace.json` existence
  expectation was inverted (must NOT exist).
* `tests/integration/addon.test.ts` — addon-level Call/Step/Return
  content assertions now use ct-print.
* `tests/async/async.test.ts` — async-context tests now assert on
  ct-print's `ioEvents` for the post-await stdout payloads.
* `tests/hcr/hcr.test.ts` — HCR content assertions rewritten to use
  ct-print's `functions`, `paths`, `steps`, `values` tables.
* `tests/io-filtering/io-filtering.test.ts` — Write/WriteOther
  console-capture tests now assert on `ioStdout` / `ioStderr` from
  ct-print's `ioEvents`.
* `tests/values/values.test.ts` — Call-arg name + Return value
  assertions weakened from full value/typeKind round-trip (which
  required the JSON sidecar) to varname-presence checks against
  ct-print's `values` table.  The encoder-level invariants
  (typeKind=Int for 42, value=42, etc.) remain fully covered by the
  `test_type_registration` suite via the pure `encodeValue` path.
* `tests/deep-values/deep-values.test.ts` — same pattern as
  `values.test.ts` for compound-value tests.  Note: ct-print's
  current `values` table renders compound values as Raw "{...}" /
  "[...]" markers (transitional Nim-writer limitation documented
  in `crates/recorder_native/src/lib.rs::local_value_to_upstream`),
  so deep-structure assertions on recorded values are out of scope
  until the Nim C library exports CBOR-based compound registration.
* `tests/benchmarks/benchmarks.test.ts` — benchmark size analysis
  now reports CTFS container size and step count (sourced from
  ct-print) instead of `trace.json` byte size.

### New tests added

* `tests/cli-conventions.test.ts` — five describe blocks mirroring
  the cairo precedent (commit 2710b5e):
  - `test_no_format_flag_in_help` — top-level and `record` `--help`
    must not advertise `--format` or `CODETRACER_FORMAT`.
  - `test_help_mentions_ct_print` — both help surfaces must point
    users at `ct print` for human-readable conversion.
  - `test_format_flag_rejected` — `--format json` and `--format
    binary` both exit non-zero with a `--format` mention in stderr.
  - `test_env_out_dir_used_when_flag_omitted` — both directions
    (env-only and flag-wins-over-env).
  - `test_env_disabled_skips_recording` — `=1` and `=true` both
    skip recording; no `.ct` files are written.
* `tests/verify-cli-convention-no-silent-skip.sh` — shell-level
  guard run from both `just lint` and `just test`.  Asserts
  presence of canonical strings in `--help`, absence of legacy
  strings in `--help`, presence of env-var references in source,
  and absence of any `fs::write(.., "trace.json")` call site in
  the native crate.
* `tests/helpers/ct-print.ts` — helper module described above.

### Files modified / added

Modified:

* `packages/cli/src/index.ts`
* `packages/cli/src/record-cmd.ts`
* `packages/runtime/src/config.ts`
* `packages/runtime/src/runtime.ts`
* `crates/recorder_native/src/lib.rs`
* `package.json` (test script wiring)
* `Justfile` (lint + test wiring)
* All test files mentioned in "Test rewrites" above.

Added:

* `tests/helpers/ct-print.ts`
* `tests/cli-conventions.test.ts`
* `tests/verify-cli-convention-no-silent-skip.sh`
* `AUDIT-CTFS-2026-05.md` (this file)
* `README.md`

### References

* [`codetracer-specs/Recorder-CLI-Conventions.md`](../codetracer-specs/Recorder-CLI-Conventions.md) §4 (CTFS-only) and §5 (env vars).
* [`codetracer-specs/Repo-Requirements.md`](../codetracer-specs/Repo-Requirements.md) §2.2 (CLI compliance) and §2.3 (trace format compatibility).
* Cairo precedent: `codetracer-cairo-recorder` commit 2710b5e
  ("Recorder convention compliance: drop --format, add CTFS-only contract").

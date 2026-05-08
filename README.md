# codetracer-js-recorder

CodeTracer JavaScript / TypeScript recorder — full-state recording via
compile-time SWC instrumentation.

## Quick start

```bash
just build       # builds the Rust N-API addon + TypeScript packages
just test        # runs vitest + the CLI-convention shell guard
```

## Usage

```bash
# Instrument source files (no execution)
codetracer-js-recorder instrument <src> --out <dir>

# Instrument and run a program, producing a CTFS trace
codetracer-js-recorder record <file> [-o|--out-dir <dir>] [-- app-args...]
```

Examples:

```bash
# Record hello.js into ./ct-traces/ (the default)
codetracer-js-recorder record examples/hello.js

# Record into a specific output directory using the short flag
codetracer-js-recorder record examples/hello.js -o /tmp/my-traces

# Record an entry directory and pass app args after `--`
codetracer-js-recorder record ./src --out-dir ./traces -- --port 3000
```

## Output format: CTFS

The recorder always writes the canonical CodeTracer multi-stream
container — the `.ct` CTFS bundle — into `--out-dir`.  Per
[`codetracer-specs/Recorder-CLI-Conventions.md`][cli-conventions] §4
there is **no `--format` flag** and **no `CODETRACER_FORMAT`
environment variable**.

For human-readable conversion of a recorded `.ct` bundle (debugging,
golden-snapshot fixtures, interop with non-CodeTracer tools), use
`ct print` shipped with [codetracer-trace-format-nim][trace-format-nim]:

```bash
# JSON view (high-level summary)
ct-print --json /path/to/traces/trace-1/<program>.ct

# Per-event JSON stream
ct-print --json-events /path/to/traces/trace-1/<program>.ct

# Plain-text summary
ct-print --summary /path/to/traces/trace-1/<program>.ct
```

## Output directory structure

```
<out-dir>/
  trace-<N>/
    <program>.ct                  # canonical CTFS multi-stream container
    trace_metadata.json           # operational metadata for the `ct` CLI
    trace_paths.json              # operational paths sidecar
    files/                        # copied source files
```

The `trace_metadata.json` and `trace_paths.json` files are
**operational** sidecars consumed by the `ct` CLI to register the
trace; they are not duplicates of the trace event content.

## CLI flags

| Flag                   | Description                                         |
| ---------------------- | --------------------------------------------------- |
| `-o`, `--out-dir <dir>` | Trace output directory (default: `./ct-traces/`).  |
| `--include <glob>`     | Include only matching source files (repeatable).   |
| `--exclude <glob>`     | Exclude matching source files (repeatable).        |
| `--help`, `-h`         | Print help and exit.                               |
| `--version`, `-V`      | Print version and exit.                            |

Unknown flags (including the legacy `--format`) are rejected with an
"unexpected argument" diagnostic.

## Environment variables

Per [`Recorder-CLI-Conventions.md`][cli-conventions] §5:

| Variable                              | CLI equivalent | Description                              |
| ------------------------------------- | -------------- | ---------------------------------------- |
| `CODETRACER_JS_RECORDER_OUT_DIR`      | `--out-dir`    | Trace output directory.                  |
| `CODETRACER_JS_RECORDER_DISABLED`     | —              | Set to `1` or `true` to skip recording.  |
| `CODETRACER_JS_RECORDER_INCLUDE`      | `--include`    | Comma-separated include glob patterns.   |
| `CODETRACER_JS_RECORDER_EXCLUDE`      | `--exclude`    | Comma-separated exclude glob patterns.   |

CLI flags always take precedence over environment variables.  When
`CODETRACER_JS_RECORDER_DISABLED` is truthy at the CLI layer, the
recorder exits cleanly without spawning the target Node process and
without writing any trace artefacts.

## Repository layout

* `packages/cli` — CLI entry point.
* `packages/instrumenter` — Babel-based source-to-source
  instrumentation.
* `packages/runtime` — Runtime library injected into instrumented
  programs (event buffer, encoder, async-context tracker).
* `crates/recorder_native` — Rust N-API addon that consumes the
  runtime's event buffer and writes the CTFS container via
  `NimTraceWriter`.
* `tests/` — End-to-end + integration + benchmark tests.

## Convention compliance

This recorder implements the CTFS-only output contract per
[`Recorder-CLI-Conventions.md`][cli-conventions] §4, with env-var
fallbacks per §5 and a no-silent-skip shell guard at
`tests/verify-cli-convention-no-silent-skip.sh`.  See
[`AUDIT-CTFS-2026-05.md`](./AUDIT-CTFS-2026-05.md) for the full audit
record.

[cli-conventions]: ../codetracer-specs/Recorder-CLI-Conventions.md
[trace-format-nim]: ../codetracer-trace-format-nim

## Direct-storage upload (Enterprise on-prem)

For Enterprise on-prem deployments, the recorder produces a
materialized CTFS bundle on the local filesystem and a separate
`codetracer-managed-upload direct-materialized-finalize` invocation
PUTs it directly to the customer's storage server, then posts a
metadata-only finalize to codetracer-ci. Trace bytes never traverse
the codetracer-ci control plane.

After the recorder produces the materialized artifact set:

```bash
codetracer-managed-upload direct-materialized-finalize \
  --storage-config /etc/codetracer/trace-storage.json \
  --recording-id "${SESSION_ID}" \
  --object-key-prefix "traces/${TENANT_ID}/${SESSION_ID}/javascript-direct" \
  --idempotency-key "${SESSION_ID}-javascript" \
  --artifact-dir "${RECORDER_OUT_DIR}" \
  --language javascript
```

The full data-path overview, the static-config schema, and the
Enterprise lease lifecycle are documented at
[`codetracer-specs/Observability-Platform/docs/direct-storage-data-path.md`](../codetracer-specs/Observability-Platform/docs/direct-storage-data-path.md).
The HTTP endpoint reference is at
[`codetracer-ci/rewrite-docs/04-apis-events/http-api.md`](../codetracer-ci/rewrite-docs/04-apis-events/http-api.md)
section 4.10.

End-to-end coverage:
`StoragePolicyModelTests.e2e_js_recorder_materialized_direct_upload_with_static_config`
(M38 slice 5C) and the M39 NixOS test
`codetracer-ci-rewrite-multitenant-infra-materialized-recorders-incus`
(live recorder running inside an Incus container per tenant).

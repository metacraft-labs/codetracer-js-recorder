# Instructions for Codex

To build the Rust native addon and TypeScript packages, execute:

```
just build
```

To run the test suite, execute:

```
just test
```

The test suite uses Vitest and instruments sample programs in `tests/`, recording
their execution and comparing traces against known good fixtures.

To run only the Rust or TypeScript tests independently:

```
just build-native    # Rust N-API addon only
npm test             # TypeScript/Vitest tests only
```

To run the benchmark, if available:

```
npm run bench
```

# Codebase structure

This is a monorepo managed with npm workspaces:

* `packages/cli` — CLI entry point (`codetracer-js-recorder` binary).
  Provides `instrument`, `record`, `read-spans`, `boundary-shim` and
  `bundle-manifest` subcommands. `instrument` is deterministic: files are
  instrumented in sorted order (`sortedFilesUnder` in
  `packages/instrumenter/src/files.ts`, never the filesystem's order), every
  output declares the recorder version (`packages/instrumenter/src/version.ts`),
  and `--relative-paths` makes the output independent of where the bundle sits
  (the post-bundle replay build). `bundle-manifest` writes `ct-bundle.json` and
  prints the build hash (`packages/boundary-shim/src/bundle-manifest.ts`).
  Pinned by `tests/integration/deterministic-instrumentation.test.ts`.
* `packages/{esbuild,rollup,webpack,vite}-plugin` — bundler plugins. Each numbers
  every module in the merged manifest (`ManifestAccumulator`, see below) and
  emits `codetracer.manifest.json` and a source map; the real bundlers (root
  devDependencies) run them in `tests/integration/bundler-plugins.test.ts`.
* `packages/express` — Express middleware emitting one web-request span per
  request into the recorded `.ct` container (RS-M9); see
  `docs/web-request-spans.md`.
* `test-programs/web/express` — the recorded Express demo app + its in-process
  request driver, shared by `just demo-request-panel-js` and the span tests.
* `packages/instrumenter` — Source-to-source JavaScript/TypeScript
  instrumentation using SWC.
* `packages/runtime` — Runtime library injected into instrumented programs
  to capture trace events.
* `packages/boundary-format` — encoder and strict decoder of the browser
  boundary log (`jsbound.log`). Held to the byte vectors the Rust
  implementation in codetracer `libs/jsbound` writes; they are vendored in
  `tests/boundary/vectors/` by `scripts/vendor-jsbound-vectors.sh` (re-run it
  after the Rust side regenerates them; `just verify-jsbound-vectors` checks
  the copy).
* `packages/boundary-shim` — the generic boundary-recording shim (record mode):
  patches a page's nondeterminism seams and writes the boundary log with
  `packages/boundary-format`. Its browser half is bundled into
  `dist/boundary-shim.iife.js` and inserted first in `<head>` by
  `codetracer-js-recorder boundary-shim <html|dir>` or the vite plugin's
  `codetracerBoundaryShimPlugin`. Where the bootstrap goes (`bootstrapPosition`,
  `src/placement.ts`) is found with the HTML tokenizer in `src/html-scan.ts`,
  never a text search (a `<head>` in a comment or a script is not the head);
  the replay runner's gates use the same scanner, so record and replay agree
  on positions (`tests/boundary/bootstrap-placement.test.ts`). It follows an
  encoding declaration that begins the head, which must stay in the first
  1024 bytes for the encoding prescan. Its browser tests
  (`tests/boundary/record-shim.test.ts`) run real headless Chromium, which the
  dev shell provides (`PLAYWRIGHT_CORE_PATH`, `PLAYWRIGHT_BROWSERS_PATH`).
* `packages/runtime-browser/src/batch-transport.ts` — `HttpBatchTransport`,
  the batched upload transport of boundary recording: a capped ring with
  drop accounting, batches of at most 256 records or 50 ms with the
  Boundary-Ingest envelope (`encodeBatch` from `packages/boundary-format`,
  never a second codec), `sendBeacon` at `pagehide`/hidden, and the consent
  gates (DNT, GPC, the page's consent callback, the ingest's `config`). The
  shim uses it when installed with `boundary-shim --ingest <url>` and imports
  it by its subpath (`@codetracer/runtime-browser/dist/batch-transport.js`)
  so the shim bundle carries no `__ct` runtime; cooperating frameworks can
  use it the same way. Every platform function it calls is a captured
  original, or its timers and requests would be recorded as the page's.
  Without `--ingest` the shim keeps its log in the page (`log()`), which is
  what the replay and shim tests read. Pinned by
  `tests/boundary/transport.test.ts` against a local stub ingest
  (`tests/boundary/stub-ingest.ts`, the one allowed mock until the real
  ingest exists).
* `packages/boundary-conformance` — the conformance suite of the
  boundary-recording cooperation protocol, the definition of "a framework
  implements the protocol": the fixture scenarios (`src/fixtures.ts`), the
  record-leg harness `ct-boundary-conformance record --build <dir> --level
  <0|1>` (a real server and headless Chromium; the checks in
  `src/checks.ts`), the suite's generic build for the shim at level 0 (installed with
  `--ingest /ct-conformance`: at both levels the log is the batches the
  harness's server received), and a
  **test-only** reference micro-framework at level 1 (`src/reference/`, with
  seeded defects) that proves the harness discriminates. It is a public
  contract other repositories run against their own builds, so the fixture
  pages' `data-fx` names and the `/ct-conformance/` routes are part of it.
  The checkpoint cadence oracle (`src/cadence.ts`) is the one implementation
  of that rule; the shim's own tests call it too. The probe's `dom-v1`
  serialiser (`src/browser/probe.ts`) is deliberately a second, independent
  implementation of the scheme, the oracle the recorders' hashes are checked
  against; do not replace it with the shim's. Pinned by
  `tests/boundary/conformance.test.ts`. `packages/boundary-format` also has
  the batch envelope codec (`batch.ts`, `encodeBatch`/`parseBatch`) the suite
  checks uploads with, held to the Rust parser by the shared batch vectors
  (`tests/boundary/vectors/batches.json`).
* `packages/boundary-replay` — the replay runner of boundary recording:
  `ct-boundary-replay --log <recording.ct|jsbound.log> --build <dir> [--out
  <trace.ct>]` replays a recorded log in headless Chromium against the build
  it ran (`replaySession` in `src/runner.ts`), reports the first divergence
  as a typed error and, with `--out`, instruments the build itself and writes
  the materialised trace through codetracer's `session-manager record-web`,
  passing it the trace's recording id (`materialisedRecordingId`, derived from
  the session, so a trace written again is byte-identical). Its in-page half
  (`src/browser/runtime.ts`, bundled to `dist/replay-runtime.iife.js`) is `__ctReplay`, the one cursor every replayed
  read is matched against, and the scheduler that owns the page's tasks. The
  document's own loading (the parser's progress, external scripts,
  `DOMContentLoaded`, `load`) is held back to the points the log has
  (`Loading` and `DocTask` records, written by
  `packages/boundary-shim/src/browser/document-progress.ts` on both sides)
  by the runner's gates (`src/gates.ts`), pinned by `tests/boundary/gates.test.ts`
  and the slow-loading session of `tests/boundary/replay.test.ts`. The
  generic shim's replay mode is `packages/boundary-shim/src/browser/replay/`
  (its own bundle, `dist/boundary-shim-replay.iife.js`, so recorded pages never
  carry it), a client of `__ctReplay`; so is the reference framework's replay
  mode. A `.ct` is read through the native addon's `readCtfsMember` (the
  canonical CTFS reader), never a second container decoder. The conformance
  suite's replay leg (`ct-boundary-conformance replay`,
  `packages/boundary-conformance/src/replay-leg.ts`) runs it. Pinned by
  `tests/boundary/replay.test.ts`, which needs two codetracer sibling binaries
  besides `ct-print`: `session-manager` (`cargo build --bin session-manager` in
  `codetracer/src/backend-manager`) and `ct-jsbound` (`cargo build --bin
  ct-jsbound` in `codetracer/libs/jsbound`), or `CODETRACER_SESSION_MANAGER` and
  `CT_JSBOUND`; without them it fails, naming the build command.
* `crates/recorder_native` — Rust N-API addon (via napi-rs) for writing
  trace files in binary (CBOR+zstd) and JSON formats.
* `tests/` — End-to-end integration tests.

## There are THREE implementations of the `__ct` runtime

Changing the runtime surface (adding a method, or an argument to one) means
changing all three, or the change silently does nothing on the path you did not
touch:

1. `packages/runtime/src/runtime.ts` — the real library, used when a program
   embeds the recorder itself (bundler plugins, `startRecording`).
2. `packages/cli/src/record-cmd.ts` `generateRunner()` — a hand-inlined
   duplicate emitted as `__ct_runner.js`. **This is what `record` actually
   runs**, so a fix applied only to (1) will not show up in a recorded trace.
   It must stay dependency-free CommonJS, which is why it is duplicated rather
   than imported; constants shared with (1) are imported at *generation* time so
   the budgets cannot drift.
3. `packages/cli/src/instrument-cmd.ts` and `packages/runtime-browser` — the
   browser transport, which speaks a different (message-based) wire protocol to
   the recording daemon. New instrumenter arguments are accepted and ignored
   here unless that protocol is extended too.

The two browser implementations (1 as `runtime-browser`, and 3) must make their
own timers and sockets through the platform functions as they were before a
boundary shim patched them (`resolveOriginals` in `runtime-browser`), or the
recorder's flush timer is recorded as a task of the page.

## Manifest ids are minted in the MERGED numbering, never per file

`__ct.step(siteId)` / `__ct.write(siteId)` / `__ct.enter(fnId)` / `__ct.ret(fnId)`
carry their ids as **bare numeric literals in the instrumented source**, and the
recorder resolves them by indexing the merged manifest's `sites` / `functions`
arrays. A merge therefore cannot renumber them — the code that reports them has
already been written.

So a caller that instruments several files must ask
`nextManifestIdBases(slicesSoFar)` **before** each `instrument()` call and pass
it as `idBases`, then merge in the same order with `mergeManifestSlices`. That
merge is the single implementation (`packages/instrumenter/src/merge.ts`), used
by `record`, `instrument` and every bundler plugin's `ManifestAccumulator`; it places
each slice at its declared base and throws `ManifestIdBaseMismatchError` rather
than mis-attributing.

Until 2026-09-09 every slice was numbered from zero and the merge "repaired" it
by offsetting `fnId` references *inside* the manifest — which made the manifest
self-consistent and nothing else. The second file's `__ct.step(k)` still resolved
against the first file's site `k`, so **every step recorded outside the first
instrumented file pointed at an unrelated line of that first file**, silently.
Pinned by `tests/transform/manifest-id-spaces.test.ts`.

**This was not a corner case.** It needed no reload, no bundler and no unusual
input — only more than one instrumented file. **Every multi-file JavaScript
recording this recorder ever produced had wrong step attribution**, and the
larger the first file, the more of the rest of the program it absorbed. Measured
2026-09-09 on a two-file program with no reload of any kind (a 7-line `index.js`
requiring a 14-line `lib.js`, recorded and decoded from the `.ct`): the six steps
that belong to `lib.js` decoded, before the fix, as `index.js` lines 1, 6, 7, 5,
6 plus one stray `lib.js:1`; after it, all six decode correctly as `lib.js` lines
1, 10, 14, 10, 11, 12. Nothing errored in either run.

## Event side channels must be attached in the same `push`

`EventBuffer.push` (and the runner's `pushEvent`) auto-flush when the buffer
reaches capacity. Attaching a value/write/marker in a *separate* call after the
push therefore lands it in the next, empty window with a stale index — losing
the data for one event out of every `BUFFER_CAPACITY`. Pass the attachment to
`push` instead.

# You don't have access to the internet

During development, certain commands will fail because you don't have
access to the internet.

The script `.agents/download_internet_resources.sh` is executed before
your development session starts while your computer is still connected
to the internet.

You can examine this script to see what kind of internet resources
have been downloaded for offline use. If it's difficult for you to
achieve a task without access to additional internet resources, you
can always propose a PR that modifies the download.sh script instead
of completing your main task.

Downloading development dependencies may also fail due to the lack of
internet connectivity. We are trying to maintain the script `.agents/codex-setup`
that is also executed before your development session starts while
your computer is still connected to the internet. It tries to run
all build commands that need development dependencies in order to
cache the dependencies for offline use. Please propose changes to
this script when you introduce new build targets with dependencies.

When you need to consult the documentation or source code modules
for a particular dependency, always try to find where this dependency
have been downloaded and try to access the necessary files through
the file system (i.e. depending on the programming language, the
operating system and the package manager being used, they should
be in their standard location).

# Code quality guidelines

- ALWAYS strive to achieve high code quality.
- ALWAYS write secure code.
- ALWAYS make sure the code is well tested and edge cases are covered. Design the code for testability and be extremely thorough.
- ALWAYS write defensive code and make sure all potential errors are handled.
- ALWAYS strive to write highly reusable code with routines that have high fan in and low fan out.
- ALWAYS keep the code DRY.
- Aim for low coupling and high cohesion. Encapsulate and hide implementation details.
- TypeScript code is formatted with Prettier and linted for style consistency.
- Rust code uses `cargo clippy` with `-D warnings` and `cargo fmt`.
- Nix files are formatted with `nixfmt`.

# Code commenting guidelines

- Document public APIs and complex modules using standard code documentation conventions.
- Comment the intention behind your code extensively. Omit comments only for very obvious
  facts that almost any developer would know.
- Maintain the comments together with the code to keep them meaningful and current.
- When the code is based on specific formats, standards or well-specified behavior of
  other software, always make sure to include relevant links (URLs) that provide the
  necessary technical details.

# Writing git commit messages

- You MUST use multiline git commit messages.
- Use the conventional commits style for the first line of the commit message.
- Use the summary section of your final response as the remaining lines in the commit message.

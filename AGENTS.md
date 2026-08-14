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
  Provides `instrument`, `record` and `read-spans` subcommands.
* `packages/express` — Express middleware emitting one web-request span per
  request into the recorded `.ct` container (RS-M9); see
  `docs/web-request-spans.md`.
* `test-programs/web/express` — the recorded Express demo app + its in-process
  request driver, shared by `just demo-request-panel-js` and the span tests.
* `packages/instrumenter` — Source-to-source JavaScript/TypeScript
  instrumentation using SWC.
* `packages/runtime` — Runtime library injected into instrumented programs
  to capture trace events.
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

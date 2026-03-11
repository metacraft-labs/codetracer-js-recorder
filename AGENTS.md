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
  Provides `instrument` and `record` subcommands.
* `packages/instrumenter` — Source-to-source JavaScript/TypeScript
  instrumentation using Babel.
* `packages/runtime` — Runtime library injected into instrumented programs
  to capture trace events.
* `crates/recorder_native` — Rust N-API addon (via napi-rs) for writing
  trace files in binary (CBOR+zstd) and JSON formats.
* `tests/` — End-to-end integration tests.

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

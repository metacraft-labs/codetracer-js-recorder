# Windows DIY dev environment — codetracer-js-recorder

CodeTracer is normally developed inside a Nix dev shell. On Windows, the
repo-root `env.ps1` provisions the same toolchain without Nix.

## Usage

From a PowerShell 7+ prompt at the repo root:

```powershell
. .\env.ps1
```

This downloads pinned versions of **Rust**, **Node.js**, and **just**
into a deterministic install root and prepends them to `PATH` for the
current shell. The install root defaults to
`%LOCALAPPDATA%\codetracer\windows-diy`, or `$env:WINDOWS_DIY_INSTALL_ROOT`
if set — the same value the other CodeTracer repos use, so one binary
cache serves the whole workspace.

Then build and test as usual:

```powershell
just build      # napi-rs native addon + the TypeScript packages
just test       # vitest + the CLI-convention shell guard
```

The npm-only path (what CI runs) also works:

```powershell
npm install
npx napi build --release --manifest-path crates/recorder_native/Cargo.toml --output-dir crates/recorder_native/
npm run build
npm test
```

## Prerequisites

- **PowerShell 7+**.
- **Git for Windows** — provides `bash`, which `npm test` invokes for the
  CLI-convention guard (`tests/verify-cli-convention-no-silent-skip.sh`).
  `env.ps1` puts Git's `bash` on `PATH` automatically.
- **MSVC toolchain** — Visual Studio Build Tools with the C++ workload.
  `rustc` locates it automatically when compiling the native addon for
  the `x86_64-pc-windows-msvc` target.

## Pinned versions

See [`toolchain-versions.env`](./toolchain-versions.env).
`RUST_TOOLCHAIN_VERSION` must stay in sync with the channel in the repo's
`rust-toolchain.toml`.

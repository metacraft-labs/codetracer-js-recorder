## Reprobuild dev env + build recipe for codetracer-js-recorder.
##
## Ships an npm package whose native addon is implemented in Rust +
## napi-rs. The recipe expresses the cargo build + test edges
## natively per ``codetracer-specs/Repo-Requirements.md`` §2.8 — no
## ``shell(command = "just ..."")`` delegations.
##
## Provisioning note (MR2): node + npm now ship full tarball-direct
## entries in ``packages/node.nim`` and ``packages/npm.nim`` (Node 20.x
## LTS from nodejs.org). The recipe therefore drops
## ``defaultToolProvisioning "path"`` and relies on the engine's own
## provisioning end-to-end — Nix on Linux/macOS, the tarball selector
## on Windows (or ``REPRO_TOOL_PROVISIONING=tarball`` anywhere).

import repro_project_dsl

package codetracer_js_recorder:
  uses:
    "rustc >=1.85"
    "cargo >=1.85"
    "nim >=2.2 <3.0"
    "nimble"
    "capnp"
    "zstd"
    # ``node`` drives the napi-rs binding step. The Unix Node tarballs
    # expose ``npm`` as a symlink, which the current tarball resolver
    # does not materialise as an executable; the reprobuild cargo-only
    # build/test edges do not need npm on Linux/macOS.
    "node >=20"
    when defined(windows):
      "npm"
    when defined(linux):
      # Nim staticlib builds invoked from cargo expect a GNU archiver on
      # Linux. Use gcc so Nim selects ``ar`` instead of ``llvm-ar``.
      "gcc"
    when defined(macosx):
      # Cargo build scripts look for ``cc`` by default; pass ``CC=clang``
      # below and make clang part of the macOS dev environment.
      "clang"
    when not defined(windows):
      "pkg-config"
      "openssl"

  library codetracerJsRecorder

  devEnv:
    activity "default"

  build:
    # ---- Native cargo build of the napi-rs addon ---------------------
    #
    # The Rust crate produces a cdylib that napi-rs renames to
    # `<addon>.<platform-suffix>.node` at packaging time. For the
    # `default` collection we materialise the cargo cdylib output;
    # the platform-suffix rename happens at package time (outside this
    # cargo edge). Cargo uses ``lib`` prefixes for Unix cdylibs.
    #
    # Path-mode caveat: the JS recorder's cargo crate lives at
    # ``crates/recorder_native/Cargo.toml`` (there is no workspace
    # ``Cargo.toml`` at the repo root). Pin the manifest path so cargo
    # finds it from the recipe's CWD (the repo root).
    const dylibExt =
      when defined(windows): "dll"
      elif defined(macosx): "dylib"
      else: "so"
    const dylibName =
      when defined(windows): "codetracer_js_recorder_native"
      else: "libcodetracer_js_recorder_native"
    const addonBinary =
      "crates/recorder_native/target/release/" & dylibName & "." & dylibExt
    const cargoManifest = "crates/recorder_native/Cargo.toml"
    const cargoLockfile = "crates/recorder_native/Cargo.lock"
    let cargoCompilerEnv: seq[(string, string)] =
      when defined(windows): @[]
      elif defined(macosx): @[("CC", "clang")]
      else: @[("CC", "gcc")]

    let addonBuild = cargo.build(
      release = true,
      manifestPath = cargoManifest,
      actionId = "codetracer-js-recorder.cargo-build",
      extraInputs = @[
        cargoManifest, cargoLockfile,
        "crates/recorder_native/src"
      ],
      extraOutputs = @[addonBinary],
      extraEnv = cargoCompilerEnv)
    discard collect("default", @[addonBuild])

    # ---- Rust-side cargo tests ---------------------------------------

    let cargoTestsBuild = cargo.test(
      noRun = true,
      manifestPath = cargoManifest,
      actionId = "codetracer-js-recorder.cargo-test-build",
      extraInputs = @[cargoManifest, cargoLockfile,
                      "crates/recorder_native/src"],
      extraOutputs = @["crates/recorder_native/target/debug/deps"],
      extraEnv = cargoCompilerEnv)

    let cargoTestsRun = cargo.test(
      manifestPath = cargoManifest,
      actionId = "codetracer-js-recorder.cargo-test-run",
      after = @[cargoTestsBuild.action],
      extraInputs = @[
        cargoManifest, cargoLockfile,
        "crates/recorder_native/src",
        "crates/recorder_native/target/debug/deps"
      ],
      extraEnv = cargoCompilerEnv)

    discard collect("test", @[cargoTestsRun.action])

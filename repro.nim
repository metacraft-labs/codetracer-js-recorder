## Reprobuild dev env + build recipe for codetracer-js-recorder.
##
## Ships an npm package whose native addon is implemented in Rust +
## napi-rs. The recipe expresses the cargo build + test edges
## natively per ``codetracer-specs/Repo-Requirements.md`` §2.8 — no
## ``shell(command = "just ..."")`` delegations.
##
## **Tool provisioning.** The engine refuses ``uses:`` declarations
## without a provisioning mode (it will not fall back to PATH
## implicitly), so the recipe declares one:
##
## * Linux / macOS: ``path``. The tools come from this repository's
##   flake dev shell (``useFlakeDevShell()`` below), the same Nix
##   toolchain ``nix develop`` and ``just`` use, so ``repro build``
##   and the Justfile build with one set of tools.
## * Windows: ``tarball``. There is no Nix; every tool in ``uses:``
##   has a Windows tarball entry in reprobuild's stdlib
##   (``repro_dsl_stdlib/packages/{rustc,cargo,nim,nimble,git,capnp,zstd,
##   node,npm}.nim``), which the engine downloads and verifies.
##
## ``--tool-provisioning=<mode>`` or ``REPRO_TOOL_PROVISIONING``
## overrides the default for one invocation.

import repro_project_dsl
import repro_dsl_stdlib/foreign_env

package codetracer_js_recorder:
  defaultToolProvisioning (when defined(windows): tarball else: path)

  uses:
    "rustc >=1.85"
    "cargo >=1.85"
    # C compiler driver — rustc links through `cc`, and build scripts
    # (cc-rs, the Nim FFI) compile C. The stdlib's `cargo` lists `gcc` /
    # `clang` as sub-tools, so declaring it here puts it on every cargo
    # edge's PATH; a `uses:` entry for a tool that no edge lists puts it
    # on none. Windows links with MSVC instead.
    when defined(linux):
      "gcc"
    elif defined(macosx):
      "clang"
    # Run by the build scripts of the dependency tree, not by cargo; the
    # cargo edges attach them explicitly (see "Build-script tools" below).
    "nim >=2.2 <3.0"
    "nimble"
    "git"
    "capnp"
    "zstd"
    # ``node`` + ``npm`` drive the napi-rs binding step. With MR2's
    # stdlib tarball entries the engine materialises a content-
    # addressed Node 20.x LTS prefix and surfaces ``node`` / ``npm``
    # from that prefix to the build edge.
    "node >=20"
    "npm"
    when not defined(windows):
      "pkg-config"
      "openssl"
    # Workspace siblings, resolved BY PATH: the addon's Cargo.toml
    # path-depends on codetracer-trace-format's crates (types, ctfs,
    # reader and the Nim-backed codetracer_trace_writer_nim, whose build
    # script compiles codetracer-trace-format-nim's Nim library). The
    # storage-contract conformance
    # test calls codetracer_ctfs::recorder_conformance. Naming them here
    # is what puts their pinned revisions in this repo's repro.lock.
    "codetracer-trace-format"
    "codetracer-trace-format-nim"

  library codetracerJsRecorder

  devEnv:
    when not defined(windows):
      useFlakeDevShell()

    activity "default"

  build:
    # ---- Native cargo build of the napi-rs addon ---------------------
    #
    # The Rust crate produces a cdylib that napi-rs renames to
    # `<addon>.<platform-suffix>.node` at packaging time. For the
    # `default` collection we materialise the cargo cdylib output;
    # the platform-suffix rename happens at gem-packing time (the
    # `package` collection's job, declared elsewhere).
    #
    # Path-mode caveat: the JS recorder's cargo crate lives at
    # ``crates/recorder_native/Cargo.toml`` (there is no workspace
    # ``Cargo.toml`` at the repo root). Pin the manifest path so cargo
    # finds it from the recipe's CWD (the repo root).
    #
    # Cargo names a cdylib after the platform's shared-library
    # convention: `lib<crate>.so` / `lib<crate>.dylib` on Linux and
    # macOS, `<crate>.dll` (no `lib` prefix) on Windows. The declared
    # output must match that file exactly, or the engine fails the
    # action for not producing what it declared.
    # https://doc.rust-lang.org/reference/linkage.html
    const addonFile =
      when defined(windows): "codetracer_js_recorder_native.dll"
      elif defined(macosx): "libcodetracer_js_recorder_native.dylib"
      else: "libcodetracer_js_recorder_native.so"
    const addonBinary = "crates/recorder_native/target/release/" & addonFile
    const cargoManifest = "crates/recorder_native/Cargo.toml"
    const cargoLockfile = "crates/recorder_native/Cargo.lock"

    let addonBuild = cargo.build(
      release = true,
      manifestPath = cargoManifest,
      actionId = "codetracer-js-recorder.cargo-build",
      extraInputs = @[
        cargoManifest, cargoLockfile,
        "crates/recorder_native/src"
      ],
      extraOutputs = @[addonBinary])
    discard collect("default", @[addonBuild])

    # ---- Rust-side cargo tests ---------------------------------------

    let cargoTestsBuild = cargo.test(
      noRun = true,
      manifestPath = cargoManifest,
      actionId = "codetracer-js-recorder.cargo-test-build",
      extraInputs = @[cargoManifest, cargoLockfile,
                      "crates/recorder_native/src",
                      "crates/recorder_native/tests"],
      extraOutputs = @["crates/recorder_native/target/debug/deps"])

    let cargoTestsRun = cargo.test(
      manifestPath = cargoManifest,
      actionId = "codetracer-js-recorder.cargo-test-run",
      after = @[cargoTestsBuild.action],
      extraInputs = @[
        cargoManifest, cargoLockfile,
        "crates/recorder_native/src",
        "crates/recorder_native/tests",
        "crates/recorder_native/target/debug/deps"
      ])

    # ---- Build-script tools --------------------------------------------
    #
    # A cargo edge gets ``cargo``, ``rustc`` and the C compiler on its PATH
    # because the stdlib's ``cargo`` declares them as sub-tools. The tools a
    # crate's BUILD SCRIPT runs are not cargo's: the stdlib leaves them to
    # the recipe to attach at the call site
    # (``repro_dsl_stdlib/packages/cargo.nim``, ``executable cargo``), and
    # a ``uses:`` entry alone resolves a tool without putting it on any
    # edge. On Linux and macOS the dev shell's PATH masks a missing
    # attachment; on Windows (tarball provisioning) the build script fails
    # with "program not found". The build scripts of this crate's
    # dependency tree run:
    #
    # * ``codetracer_trace_writer_nim`` (a normal dependency, so every
    #   edge): ``nimble install --depsOnly``, which runs ``nim`` and clones
    #   the packages it lacks with ``git``, then ``nim e build_ffi.nims``,
    #   which runs ``nim c`` and through it the C compiler.
    # * ``codetracer_trace_format_capnp`` (reached only through the
    #   dev-dependency ``codetracer_trace_reader``, so the test edges
    #   only): ``capnpc`` runs ``capnp compile``.
    #
    # ``zstd-sys``, ``ring`` and ``napi-build`` need only the C compiler
    # (``cc-rs``), which cargo's sub-tools cover. ``cargo test`` without
    # ``--no-run`` first rebuilds whatever is stale, so the test-run edge
    # carries the test-build edge's tools.
    const nimFfiTools = ["nim", "nimble", "git"]
    appendRegisteredActionToolIdentityRefs(addonBuild.id, nimFfiTools)
    for action in [cargoTestsBuild.action, cargoTestsRun.action]:
      appendRegisteredActionToolIdentityRefs(action.id, nimFfiTools)
      appendRegisteredActionToolIdentityRefs(action.id, ["capnp"])

    discard collect("test", @[cargoTestsRun.action])

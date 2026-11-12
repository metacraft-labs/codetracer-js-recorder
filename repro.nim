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
##   (``repro_dsl_stdlib/packages/{rustc,cargo,gcc,nim,nimble,git,capnp,
##   zstd,zstd_dev,node,npm,just,sh,bash}.nim``), which the engine downloads
##   and verifies.
##
## ``--tool-provisioning=<mode>`` or ``REPRO_TOOL_PROVISIONING``
## overrides the default for one invocation.
##
## **ct-print.** The vitest suite ``just test`` runs decodes its recordings
## with ``ct-print`` from the sibling ``../codetracer-trace-format-nim``
## checkout (``tests/helpers/ct-print.ts``) and fails without it. The
## ``test`` collection builds it there through the sibling's own
## ``buildCtPrint`` constructor, so the compile flags stay in the
## repository that owns them and the engine supplies the declared C
## compiler and ``zstd-dev`` to the compile on every host. CI's ``just test
## (cross-check)`` step runs after ``repro test`` and reads that binary.

import repro_project_dsl
import repro_dsl_stdlib/foreign_env

# The owning constructor of ``ct-print``. It lives in the sibling checkout
# this repository's cargo ``path`` dependencies already resolve at
# ``../codetracer-trace-format-nim``, and the tests read the binary it
# builds there.
import "../codetracer-trace-format-nim/build_writer_artifacts"

const traceFormatNimRoot = "../codetracer-trace-format-nim"

package codetracer_js_recorder:
  defaultToolProvisioning (when defined(windows): tarball else: path)

  uses:
    "rustc >=1.85"
    "cargo >=1.85"
    # C compiler driver — rustc links through `cc`, and build scripts
    # (cc-rs, the Nim FFI) compile C. The stdlib's `cargo` lists `gcc` /
    # `clang` as sub-tools, so declaring it here puts it on every cargo
    # edge's PATH; a `uses:` entry for a tool that no edge lists puts it
    # on none.
    #
    # Windows links with MSVC, and still declares ``gcc``: the ct-print
    # edge ``build_writer_artifacts.buildCtPrint`` constructs compiles with
    # ``nim c``'s gcc back-end on every host but macOS and names ``gcc`` on
    # its edge, and the constructor refuses a package that does not declare
    # it (the module's "Native tool contract"). On the cargo edges it is
    # inert there: rustc and cc-rs drive MSVC for the ``*-windows-msvc``
    # target, and the Nim FFI build script passes ``--cc:vcc`` for it.
    when defined(macosx):
      "clang"
    else:
      "gcc"
    # Run by the build scripts of the dependency tree, not by cargo; the
    # cargo edges attach them explicitly (see "Build-script tools" below).
    "nim >=2.2 <3.0"
    "nimble"
    "git"
    "capnp"
    "zstd"
    # zstd.h + libzstd for the sibling ct-print edge
    # (``build_writer_artifacts.buildCtPrint`` compiles and links against
    # them; ``zstd`` is the CLI only). The constructor cannot provision a
    # tool from inside ``build:`` and refuses a recipe that omits it, on
    # every host: on Windows ``zstd-dev`` is a MinGW static ``libzstd.a``
    # for the ct-print edge's gcc back-end, beside the ``gcc`` above.
    "zstd-dev"
    # ``node`` + ``npm`` drive the napi-rs binding step. With MR2's
    # stdlib tarball entries the engine materialises a content-
    # addressed Node 20.x LTS prefix and surfaces ``node`` / ``npm``
    # from that prefix to the build edge.
    "node >=20"
    "npm"
    when not defined(windows):
      "pkg-config"
      "openssl"
    # ``just`` and the shells its recipes run. CI's cross-check steps run
    # ``dev-exec just build`` and ``dev-exec just test`` on every leg
    # (``.github/workflows/ci-reprobuild.yml``). On Linux and macOS the
    # flake dev shell provides all three; on Windows there is no dev shell,
    # so the environment holds only what this block declares. ``just`` runs
    # each recipe line with ``sh``, and the recipes call ``bash`` scripts.
    "just"
    "sh"
    "bash"

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
                      "crates/recorder_native/src"],
      extraOutputs = @["crates/recorder_native/target/debug/deps"])

    let cargoTestsRun = cargo.test(
      manifestPath = cargoManifest,
      actionId = "codetracer-js-recorder.cargo-test-run",
      after = @[cargoTestsBuild.action],
      extraInputs = @[
        cargoManifest, cargoLockfile,
        "crates/recorder_native/src",
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

    # ---- ``ct-print`` for the vitest suite ---------------------------
    #
    # Ordered after the cargo test build because that build's
    # ``codetracer_trace_writer_nim`` ``build.rs`` installs the sibling's
    # nimble ``requires`` (``results``, ``stew``) into the nimble path the
    # ct-print compile resolves them from; ``just build-ct-print`` in the
    # sibling gets the same packages from ``nimble buildCtPrint``.
    let ctPrintBuild = buildCtPrint(traceFormatNimRoot,
                                    after = @[cargoTestsBuild.action])

    discard collect("test", @[cargoTestsRun.action, ctPrintBuild])

{
  description = "Development environment for codetracer-js-recorder";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";
    fenix = {
      url = "github:nix-community/fenix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    pre-commit-hooks.url = "github:cachix/git-hooks.nix";

    # Non-flake source for the codetracer trace format crates.
    # The Rust native addon depends on codetracer_trace_types and
    # codetracer_trace_writer via relative path deps (when present in
    # Cargo.toml). This input provides the source so Nix package builds
    # can resolve those paths. When the addon has no trace-format path
    # deps (e.g. on older branches), the input is unused but harmless.
    codetracer-trace-format = {
      url = "github:metacraft-labs/codetracer-trace-format/ffi-crate-and-format-fixes";
      flake = false;
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      fenix,
      pre-commit-hooks,
      codetracer-trace-format,
    }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forEachSystem = nixpkgs.lib.genAttrs systems;

      rust-toolchain-for =
        system:
        fenix.packages.${system}.fromToolchainFile {
          file = ./rust-toolchain.toml;
          sha256 = "sha256-Qxt8XAuaUR2OMdKbN4u8dBJOhSHxS+uS06Wl9+flVEk=";
        };
    in
    {
      checks = forEachSystem (system: {
        pre-commit-check = pre-commit-hooks.lib.${system}.run {
          src = ./.;
          hooks = {
            lint = {
              enable = true;
              name = "Lint";
              entry = "just lint";
              language = "system";
              pass_filenames = false;
            };
          };
        };
      });

      devShells = forEachSystem (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          preCommit = self.checks.${system}.pre-commit-check;
          isLinux = pkgs.stdenv.isLinux;
          isDarwin = pkgs.stdenv.isDarwin;
        in
        {
          default = pkgs.mkShell {
            packages =
              with pkgs;
              [
                # Node.js runtime and package manager
                nodejs_22
                corepack # Provides yarn/pnpm based on packageManager field

                # Rust toolchain for the N-API native addon
                (rust-toolchain-for system)

                # Required for napi-rs build
                pkg-config
                libiconv

                # For trace format serialization
                capnproto

                # Build automation and dev tools
                just
                git-lfs
              ]
              ++ pkgs.lib.optionals isLinux [
                glibc.dev
              ]
              ++ pkgs.lib.optionals isDarwin [
                darwin.apple_sdk.frameworks.CoreFoundation
                darwin.apple_sdk.frameworks.Security
              ]
              ++ preCommit.enabledPackages;

            inherit (preCommit) shellHook;
          };
        }
      );

      packages = forEachSystem (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          inherit (pkgs) lib stdenv;
          isLinux = stdenv.isLinux;
          isDarwin = stdenv.isDarwin;

          # Check if the native addon's Cargo.toml references codetracer-trace-format
          # path deps (present after the trace_writer integration commit).
          cargoToml = builtins.readFile ./crates/recorder_native/Cargo.toml;
          hasTraceFormatDeps = builtins.match ".*codetracer_trace_types.*" cargoToml != null;
        in
        {
          # The codetracer-js-recorder package:
          # - Builds the Rust N-API native addon (codetracer_js_recorder_native)
          # - Compiles all TypeScript workspace packages (instrumenter, runtime, cli)
          # - Produces $out/bin/codetracer-js-recorder entry point
          default = stdenv.mkDerivation {
            pname = "codetracer-js-recorder";
            version = "0.1.0";

            src = ./.;

            # npm dependencies (pre-fetched for offline install)
            npmDeps = pkgs.fetchNpmDeps {
              src = ./.;
              hash = "sha256-+U1Jou9/6j+7WBtkO+wfWrc8LVHLChpO4QxdQ0gL1UI=";
            };

            # Rust dependencies for the native addon (vendored from Cargo.lock)
            cargoDeps = pkgs.rustPlatform.importCargoLock {
              lockFile = ./crates/recorder_native/Cargo.lock;
            };

            nativeBuildInputs = with pkgs; [
              nodejs_22
              npmHooks.npmConfigHook # Sets up npm cache and runs npm install
              # Use project's Rust toolchain (1.88) — nixpkgs default (1.86) is
              # too old for napi-build@2.3.1
              (rust-toolchain-for system)
              rustPlatform.cargoSetupHook # Sets up Cargo vendor directory
              pkg-config
              capnproto
              makeWrapper
            ];

            buildInputs = lib.optionals isDarwin (
              with pkgs;
              [
                libiconv
                darwin.apple_sdk.frameworks.CoreFoundation
                darwin.apple_sdk.frameworks.Security
              ]
            );

            # cargoSetupHook expects Cargo.lock at the source root
            postUnpack = ''
              cp $sourceRoot/crates/recorder_native/Cargo.lock \
                 $sourceRoot/Cargo.lock
            '';

            # If the native addon depends on codetracer-trace-format crates,
            # patch the relative path deps to use the nix store path.
            postPatch = lib.optionalString hasTraceFormatDeps ''
              substituteInPlace crates/recorder_native/Cargo.toml \
                --replace-fail \
                  'path = "../../../codetracer/libs/codetracer-trace-format/codetracer_trace_types"' \
                  'path = "${codetracer-trace-format}/codetracer_trace_types"' \
                --replace-fail \
                  'path = "../../../codetracer/libs/codetracer-trace-format/codetracer_trace_writer"' \
                  'path = "${codetracer-trace-format}/codetracer_trace_writer"'
            '';

            buildPhase = ''
              runHook preBuild

              # 1. Build the Rust N-API native addon (cdylib)
              cd crates/recorder_native
              cargo build --release --offline
              cd ../..

              # The native addon cdylib needs to be placed as index.node
              # in the recorder_native directory — the CLI resolves it relative
              # to its own __dirname via ../../crates/recorder_native/index.node
              local ext="${if isLinux then "so" else "dylib"}"
              cp crates/recorder_native/target/release/libcodetracer_js_recorder_native.$ext \
                 crates/recorder_native/index.node

              # 2. Build TypeScript packages (instrumenter, runtime, cli)
              npm run build

              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall

              mkdir -p $out/lib/codetracer-js-recorder $out/bin

              # Preserve the directory structure so the CLI can resolve the
              # native addon via its relative path from __dirname
              cp -r packages $out/lib/codetracer-js-recorder/
              mkdir -p $out/lib/codetracer-js-recorder/crates/recorder_native
              cp crates/recorder_native/index.node \
                 $out/lib/codetracer-js-recorder/crates/recorder_native/

              # Node.js modules needed at runtime
              cp -r node_modules $out/lib/codetracer-js-recorder/

              # Executable wrapper
              makeWrapper ${pkgs.nodejs_22}/bin/node \
                $out/bin/codetracer-js-recorder \
                --add-flags "$out/lib/codetracer-js-recorder/packages/cli/dist/index.js"

              runHook postInstall
            '';

            doCheck = false;
          };
        }
      );
    };
}

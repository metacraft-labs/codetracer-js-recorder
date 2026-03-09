{
  description = "Development environment for codetracer-js-recorder";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";
    fenix = {
      url = "github:nix-community/fenix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    pre-commit-hooks.url = "github:cachix/git-hooks.nix";
  };

  outputs = {
    self,
    nixpkgs,
    fenix,
    pre-commit-hooks,
  }: let
    systems = ["x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin"];
    forEachSystem = nixpkgs.lib.genAttrs systems;

    rust-toolchain-for = system:
      fenix.packages.${system}.fromToolchainFile {
        file = ./rust-toolchain.toml;
        sha256 = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
      };
  in {
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

    devShells = forEachSystem (system: let
      pkgs = import nixpkgs {inherit system;};
      preCommit = self.checks.${system}.pre-commit-check;
      isLinux = pkgs.stdenv.isLinux;
      isDarwin = pkgs.stdenv.isDarwin;
    in {
      default = pkgs.mkShell {
        packages = with pkgs;
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
    });
  };
}

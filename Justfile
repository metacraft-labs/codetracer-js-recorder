alias t := test
alias fmt := format

# Run all tests (builds workspaces first so imports resolve)
test:
    npm run build
    npm test

# Build the Rust native addon via napi-rs
build-native:
    npx napi build --release --manifest-path crates/recorder_native/Cargo.toml --output-dir crates/recorder_native/

# Build all packages
build:
    just build-native
    npm run build

# Format Rust code
format-rust:
    cargo fmt --manifest-path crates/recorder_native/Cargo.toml

# Format TypeScript/JavaScript code
format-js:
    npx prettier --write "packages/**/*.{ts,js}" "tests/**/*.{ts,js}"

# Format Nix files
format-nix:
    if command -v nixfmt >/dev/null; then find . -name '*.nix' -print0 | xargs -0 nixfmt; fi

# Format all code
format:
    just format-rust
    just format-js
    just format-nix

# Lint Rust code
lint-rust:
    cargo fmt --check --manifest-path crates/recorder_native/Cargo.toml
    cargo clippy --manifest-path crates/recorder_native/Cargo.toml

# Lint TypeScript/JavaScript code
lint-js:
    npx prettier --check "packages/**/*.{ts,js}" "tests/**/*.{ts,js}"

# Lint Nix files
lint-nix:
    if command -v nixfmt >/dev/null; then find . -name '*.nix' -print0 | xargs -0 nixfmt --check; fi

# Lint all code
lint:
    just lint-rust
    just lint-js
    just lint-nix

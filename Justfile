alias t := test
alias fmt := format

# Run all tests (builds workspaces first so imports resolve)
test:
    npm run build
    npm test
    just verify-cli-convention

# Verify CLI convention compliance (Recorder-CLI-Conventions.md §4 / §5).
# This is a no-silent-skip shell guard — every assertion either passes
# or fails loudly.  Wired into both `just lint` and `just test`.
verify-cli-convention:
    bash tests/verify-cli-convention-no-silent-skip.sh

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
    just verify-cli-convention

# Bump version across all package.json files (usage: just bump-version 0.2.0)
bump-version version:
    #!/usr/bin/env bash
    set -euo pipefail
    for f in package.json packages/cli/package.json packages/instrumenter/package.json packages/runtime/package.json; do
        node -e "const fs=require('fs'); const p=JSON.parse(fs.readFileSync('$f','utf8')); p.version='{{version}}'; fs.writeFileSync('$f',JSON.stringify(p,null,2)+'\n');"
        echo "$f → {{version}}"
    done

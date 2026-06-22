alias t := test
alias fmt := format

# Install npm dependencies (idempotent).
#
# `build-native` shells out to `npx napi`, and the workspace build/test
# steps need the dev dependencies (`@napi-rs/cli`, `typescript`,
# `vitest`, …).  On a fresh checkout `node_modules` is absent and
# `npx napi build` fails with `ENOVERSIONS`.  Run `npm install` first so
# the recorder builds cleanly from a clean tree (the reprobuild
# `just build` integration relies on this).  `npm install` is a no-op
# once dependencies are present, so wiring it into `build`/`test` is safe
# to run repeatedly.
install:
    npm install

# Run all tests (builds workspaces first so imports resolve)
test: install
    npm run build
    npm test
    just verify-cli-convention

# Verify CLI convention compliance (Recorder-CLI-Conventions.md §4 / §5).
# This is a no-silent-skip shell guard — every assertion either passes
# or fails loudly.  Wired into both `just lint` and `just test`.
verify-cli-convention:
    bash tests/verify-cli-convention-no-silent-skip.sh

# Build the Rust native addon via napi-rs
build-native: install
    npx napi build --release --manifest-path crates/recorder_native/Cargo.toml --output-dir crates/recorder_native/

# Build all packages
build: install
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

# Bump version across all package.json files
# (usage: just bump-version 0.2.0  or  just bump-version patch / minor / major)
bump-version version:
    #!/usr/bin/env python3
    import json, re, sys
    from pathlib import Path
    raw = "{{version}}"
    pkgs = [Path(p) for p in [
        "package.json",
        "packages/cli/package.json",
        "packages/instrumenter/package.json",
        "packages/runtime/package.json",
    ] if Path(p).exists()]
    if not pkgs:
        sys.exit("no package.json found")
    cur = json.loads(pkgs[0].read_text()).get("version", "0.1.0")
    if re.match(r"^\d+\.\d+\.\d+$", raw):
        new = raw
    else:
        a, b, p = map(int, cur.split("."))
        if raw == "major": new = f"{a+1}.0.0"
        elif raw == "minor": new = f"{a}.{b+1}.0"
        elif raw == "patch": new = f"{a}.{b}.{p+1}"
        else: sys.exit(f"unknown bump component: {raw!r}")
    for f in pkgs:
        data = json.loads(f.read_text())
        data["version"] = new
        f.write_text(json.dumps(data, indent=2) + "\n")
        print(f"{f} -> {new}")

# --- M13: Packaging UX Standardization ---
# Implements Repo-Requirements.md §2.8 packaging UX for the JS
# language-ecosystem recorder. Single channel: npm.

# Build a release artifact for the given channel.
# Supported channels: npm
build-package channel:
    #!/usr/bin/env bash
    set -euo pipefail
    case "{{channel}}" in
        npm)
            just build
            npm pack --pack-destination dist
            ;;
        *)
            echo "::error::unknown channel '{{channel}}'. JS recorder only supports 'npm'." >&2
            exit 1
            ;;
    esac

# Verify the artifact produced by `build-package <channel>`.
verify-package channel:
    #!/usr/bin/env python3
    import os, sys, tarfile
    from pathlib import Path
    ch = "{{channel}}"
    strict = os.environ.get("CT_VERIFY_STRICT") == "1"
    if ch != "npm":
        print(f"::error::unknown channel {ch!r}; JS recorder only supports 'npm'")
        sys.exit(1)
    dist = Path("dist")
    tgzs = list(dist.glob("*.tgz")) if dist.exists() else []
    if not tgzs:
        print(f"[verify] no .tgz in {dist} — run `just build-package npm` first")
        sys.exit(0 if not strict else 1)
    for t in tgzs:
        with tarfile.open(t, "r:gz") as tf:
            names = tf.getnames()
        if not any(n.endswith("package.json") for n in names):
            print(f"::error::tgz {t.name} missing package.json")
            sys.exit(1)
        print(f"[verify] tgz {t.name} OK")

# Per-channel shortcut.
build-npm:
    just build-package npm

verify-npm:
    just verify-package npm

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
    just verify-request-spans

# Verify the RS-M9 web-request span coverage is present and running.
# This is a no-silent-skip shell guard — every assertion either passes
# or fails loudly.  Wired into both `just lint` and `just test`.
verify-request-spans:
    bash tests/verify-request-spans-no-silent-skip.sh

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
    just verify-request-spans

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

# --- RS-M9: Request Panel (web-request spans) ---
#
# Record the Express demo app under `test-programs/web/express/` and leave a
# real `.ct` container — spans included — in $CODETRACER_DEMO_DIR.
#
# SCHEDULE selects how the driver issues its requests:
#   sequential — one at a time (the default); a handler that never awaits is a
#                contiguous run of the exec stream.
#   concurrent — all in flight at once, so the handlers interleave on the one
#                event loop and their step ranges genuinely overlap.
#
# Invoked on its own it opens the GUI when `ct` is on PATH; invoked as the
# container-production half of codetracer's `just demo-request-panel js` it
# sets CODETRACER_DEMO_RECORD_ONLY and that side opens the session instead.
demo-request-panel-js SCHEDULE="sequential": build
    #!/usr/bin/env bash
    set -euo pipefail
    demo_dir="${CODETRACER_DEMO_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/codetracer/demos/request-panel-js}"
    echo "=== RS-M9 Request Panel demo — js/express ({{SCHEDULE}}) ==="
    case "{{SCHEDULE}}" in
      sequential) concurrent=0 ;;
      concurrent) concurrent=1 ;;
      *) echo "::error::unknown schedule '{{SCHEDULE}}' (want sequential|concurrent)" >&2; exit 1 ;;
    esac
    rm -rf "$demo_dir"
    mkdir -p "$demo_dir"
    CT_EXPRESS_CONCURRENT="$concurrent" \
      node packages/cli/dist/index.js record test-programs/web/express -o "$demo_dir"
    # The recorder writes `<out>/trace-<n>/`; the GUI wants that directory.
    trace_dir="$(find "$demo_dir" -maxdepth 1 -type d -name 'trace-*' | head -n1)"
    if [ -z "$trace_dir" ]; then
      echo "::error::no trace produced in $demo_dir" >&2
      exit 1
    fi
    # Leave the path the recipe used in a marker file rather than making the
    # caller guess the handle number.
    printf '%s' "$trace_dir" > "$demo_dir/.trace_dir"
    echo "[demo] recorded session in $trace_dir"
    # Print the spans straight out of the container, through the canonical Nim
    # reader, so a failure to render in the GUI stays distinguishable from a
    # failure to record.
    node packages/cli/dist/index.js read-spans "$trace_dir" || true
    if [ -n "${CODETRACER_DEMO_RECORD_ONLY:-}" ]; then
      exit 0
    fi
    if command -v ct >/dev/null 2>&1; then
      echo "[demo] launching the GUI; the REQUESTS panel docks itself once the"
      echo "[demo] first delta arrives (bottom edge strip if you close it)."
      exec ct replay -t "$trace_dir"
    fi
    echo "[demo] no 'ct' on PATH — open it by hand with:"
    echo "         ct replay -t $trace_dir"
    echo "[demo] (or run this through codetracer's recipe, which supplies ct:"
    echo "         direnv exec ../codetracer just demo-request-panel js)"

# RS-M9 — regenerate the committed JS request-panel fixture consumed by
# codetracer's `vm_js_request_panel_rows` ViewModel test.
#
# OUT is a directory in the codetracer checkout; the recorded trace folder (the
# `.ct` container plus the recorded app source) is written there.  Run this
# whenever the demo app or the span metadata changes, then commit the result in
# codetracer — the fixture is checked in so the ViewModel test needs no Node
# toolchain.
record-request-panel-fixture OUT SCHEDULE="sequential": build
    #!/usr/bin/env bash
    set -euo pipefail
    work="$(mktemp -d)"
    trap 'rm -rf "$work"' EXIT
    CODETRACER_DEMO_DIR="$work" CODETRACER_DEMO_RECORD_ONLY=1 \
      just demo-request-panel-js {{SCHEDULE}}
    trace_dir="$(cat "$work/.trace_dir")"
    rm -rf "{{OUT}}"
    mkdir -p "{{OUT}}"
    # Only the container is checked in.  The recorder also drops a
    # `files/<abs-source-path>` copy of every recorded source, which reproduces
    # the recording machine's directory tree verbatim; the ViewModel test reads
    # the container and nothing else, so shipping that tree would put one
    # developer's $HOME in codetracer's git history for no benefit.
    cp "$trace_dir"/*.ct "{{OUT}}/"
    echo "[fixture] wrote {{OUT}}"

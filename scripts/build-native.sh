#!/usr/bin/env bash
#
# build-native.sh -- build the napi-rs native addon and prove this run made it.
#
#   bash scripts/build-native.sh
#
# Runs `npx napi build --release` for crates/recorder_native and then requires
# the addon it writes, crates/recorder_native/index.node, to exist and be
# non-empty. package.json has no `napi` config, so the napi CLI uses its
# default binary name `index`, and without `--platform` it adds no target
# triple: the file is `index.node` on every platform, the path every consumer
# in tests/ and packages/ loads.
#
# Why napi's exit status is not enough: on Windows, npm installs `napi.cmd` and
# `napi.ps1` shims side by side. A PATHEXT exported by CI setup made cmd.exe
# resolve the `.ps1` shim and hand it to the `.ps1` file association, which
# returned 0 at once: napi never ran, no addon was written, and the CI leg
# passed.
#
# Why the old addon is removed first: an existence check alone would accept an
# addon left over from an earlier build, and an mtime comparison depends on
# timestamp granularity that a no-op rebuild can finish within. With the old
# file gone, an addon that exists afterwards was written by this invocation.
# napi copies the cdylib on every run, even when cargo rebuilds nothing, so
# the removal costs no recompilation.
#
# Exit codes:
#   0  napi exited 0 and wrote a non-empty addon
#   1  the old addon could not be removed, or napi exited 0 without writing
#      the addon
#   *  napi's own non-zero status when it fails
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
crate_dir="crates/recorder_native"
addon="$crate_dir/index.node"
say() { echo "build-native.sh: $*" >&2; }

cd "$root"

# On Windows this fails while a running node process still has the addon
# loaded, which is the right outcome: the build could not replace it either.
if ! rm -f "$addon"; then
	say "could not remove the previous addon '$addon'; is a node process still using it?"
	exit 1
fi

npx napi build --release \
	--manifest-path "$crate_dir/Cargo.toml" \
	--output-dir "$crate_dir/"

if [ ! -s "$addon" ]; then
	say "'npx napi build' exited 0 but did not write '$addon'."
	say "The napi CLI most likely never ran: on Windows, check that 'npx' resolved"
	say "napi's .cmd shim and not its .ps1 shim (look for cargo output above)."
	exit 1
fi

say "built $addon ($(wc -c <"$addon" | tr -d ' ') bytes)"

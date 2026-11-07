#!/usr/bin/env bash
#
# prettier.sh -- run the prettier this repository's lockfile pins.
#
#   bash scripts/prettier.sh --check|--write <globs...>
#
# `npx prettier` is not used: with `node_modules` absent it downloads the newest
# prettier release, so the lint verdict would depend on prettier's release
# schedule rather than on package-lock.json.
#
# Resolution, in order:
#   1. node_modules/.bin/prettier -- the lockfile's install (`npm ci`);
#   2. a prettier on PATH, only if it is exactly the lockfile's version;
#   3. otherwise fail, naming the versions and the remedy. Nothing is fetched.
#
# Contract suite: tests/prettier-resolution-test.sh
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
say() { echo "prettier.sh: $*" >&2; }

local_bin="$root/node_modules/.bin/prettier"
if [ -x "$local_bin" ]; then
	exec "$local_bin" "$@"
fi

if ! command -v node >/dev/null 2>&1; then
	say "node is not on PATH, so the lockfile's prettier version cannot be read."
	say "Enter the dev shell (nix develop) and run: npm ci"
	exit 1
fi
wanted="$(node -e 'console.log(require(process.argv[1]).packages["node_modules/prettier"].version)' \
	"$root/package-lock.json")"

if command -v prettier >/dev/null 2>&1; then
	found="$(prettier --version)"
	if [ "$found" = "$wanted" ]; then
		exec prettier "$@"
	fi
	say "ERROR: package-lock.json pins prettier $wanted, but node_modules is not"
	say "  installed and the prettier on PATH ($(command -v prettier)) is $found."
	say "  Formatting differs between prettier releases, so it is not used."
	say "  Remedy: npm ci"
	exit 1
fi

say "ERROR: package-lock.json pins prettier $wanted, and it is not installed"
say "  (no $local_bin, no prettier on PATH). Nothing is fetched."
say "  Remedy: npm ci"
exit 1

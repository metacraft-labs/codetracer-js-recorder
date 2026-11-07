#!/usr/bin/env bash
#
# prettier-resolution-test.sh -- contract suite for scripts/prettier.sh, the
# only way `just lint-js` / `just format-js` reach prettier.
#
# The defect it pins: the recipes used to call `npx prettier`. With
# `node_modules` absent, npx downloads whatever prettier release is newest, so
# the lint verdict changed with prettier's release schedule (3.9 reformats
# union types that 3.8, the lockfile's version, accepts).
#
# The contract:
#   * node_modules/.bin/prettier (the lockfile's install) is used when present;
#   * otherwise a prettier on PATH is used only if it is the lockfile's version;
#   * otherwise the run fails, naming the versions and `npm ci`;
#   * npx is never invoked.
#
# Mocks: prettier and npx are replaced by stub executables on PATH. That is the
# point under test -- WHICH executable the wrapper picks and whether it reaches
# for npx -- and running real prettier releases would need network access.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WRAPPER="$REPO_ROOT/scripts/prettier.sh"

assertions=0
failures=0
ok() {
	assertions=$((assertions + 1))
	printf '  ok   %s\n' "$1"
}
fail() {
	assertions=$((assertions + 1))
	failures=$((failures + 1))
	printf '  FAIL %s\n' "$1"
	shift
	for line in "$@"; do printf '         %s\n' "$line"; done
}

if [ ! -f "$WRAPPER" ]; then
	echo "FAIL: $WRAPPER is missing; lint-js would reach prettier through npx"
	exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

node_bin="$(dirname "$(command -v node)")"
lock_version="$(node -e 'console.log(require(process.argv[1]).packages["node_modules/prettier"].version)' "$REPO_ROOT/package-lock.json")"

# stub NAME VERSION DIR: a prettier that reports VERSION and records each call.
stub_prettier() {
	mkdir -p "$3"
	cat >"$3/prettier" <<EOF
#!/bin/sh
if [ "\$1" = "--version" ]; then echo "$2"; exit 0; fi
echo "$1 \$*" >>"$tmp/calls"
EOF
	chmod +x "$3/prettier"
}

# A fixture checkout: the wrapper, the real lockfile, a PATH with node, coreutils
# and an npx that records being called.
fixture() {
	local root="$tmp/$1"
	rm -rf "$root" "$tmp/calls"
	mkdir -p "$root/scripts" "$root/pathbin"
	cp "$WRAPPER" "$root/scripts/prettier.sh"
	cp "$REPO_ROOT/package-lock.json" "$root/"
	printf '#!/bin/sh\necho "npx $*" >>"%s/calls"\n' "$tmp" >"$root/pathbin/npx"
	chmod +x "$root/pathbin/npx"
	for tool in dirname cat sh bash; do
		ln -sf "$(command -v "$tool")" "$root/pathbin/$tool"
	done
	echo "$root"
}

run() { # ROOT -> stdout+stderr in $out, status in $rc
	set +e
	out="$(cd "$1" && PATH="$1/pathbin:$node_bin" bash scripts/prettier.sh --check x 2>&1)"
	rc=$?
	set -e
}

called() { [ -f "$tmp/calls" ] && cat "$tmp/calls"; }

echo "scripts/prettier.sh"

# 1: the lockfile's install wins.
r="$(fixture c1)"
stub_prettier local "$lock_version" "$r/node_modules/.bin"
stub_prettier path "$lock_version" "$r/pathbin"
run "$r"
if [ "$rc" -eq 0 ] && [ "$(called)" = "local --check x" ]; then
	ok "node_modules/.bin/prettier is used when installed"
else
	fail "node_modules/.bin/prettier is used when installed" "rc=$rc calls=$(called)" "$out"
fi

# 2: no install; a PATH prettier of the lockfile's version is accepted.
r="$(fixture c2)"
stub_prettier path "$lock_version" "$r/pathbin"
run "$r"
if [ "$rc" -eq 0 ] && [ "$(called)" = "path --check x" ]; then
	ok "a PATH prettier at the lockfile's version ($lock_version) is used"
else
	fail "a PATH prettier at the lockfile's version is used" "rc=$rc calls=$(called)" "$out"
fi

# 3: no install; a PATH prettier of another version is refused, loudly.
r="$(fixture c3)"
stub_prettier path 3.9.9 "$r/pathbin"
run "$r"
if [ "$rc" -ne 0 ] && [ -z "$(called)" ] &&
	[[ "$out" == *"$lock_version"* && "$out" == *3.9.9* && "$out" == *"npm ci"* ]]; then
	ok "a PATH prettier at another version is refused, naming both versions"
else
	fail "a PATH prettier at another version is refused" "rc=$rc calls=$(called)" "$out"
fi

# 4: nothing installed: fail, and never fall back to npx.
r="$(fixture c4)"
run "$r"
if [ "$rc" -ne 0 ] && [ -z "$(called)" ] && [[ "$out" == *"npm ci"* ]]; then
	ok "with no prettier at all it fails instead of fetching one through npx"
else
	fail "with no prettier at all it fails instead of fetching one" "rc=$rc calls=$(called)" "$out"
fi

echo "Justfile"

# 5: the recipes go through the wrapper, and nothing calls npx prettier.
if ! grep -q 'npx prettier' "$REPO_ROOT/Justfile" &&
	grep -A1 '^lint-js:' "$REPO_ROOT/Justfile" | grep -q 'scripts/prettier.sh --check' &&
	grep -A1 '^format-js:' "$REPO_ROOT/Justfile" | grep -q 'scripts/prettier.sh --write'; then
	ok "lint-js and format-js use scripts/prettier.sh, and no recipe calls npx prettier"
else
	fail "lint-js and format-js use scripts/prettier.sh, and no recipe calls npx prettier" \
		"$(grep -n 'prettier' "$REPO_ROOT/Justfile")"
fi

echo
if [ "$assertions" -ne 5 ]; then
	echo "FAIL: ran $assertions assertions, expected 5"
	failures=$((failures + 1))
fi
if [ "$failures" -ne 0 ]; then
	echo "$failures of $assertions assertions failed"
	exit 1
fi
echo "all $assertions assertions passed"

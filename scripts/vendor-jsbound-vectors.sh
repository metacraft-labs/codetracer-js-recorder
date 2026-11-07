#!/usr/bin/env bash
#
# vendor-jsbound-vectors.sh -- vendor the JS boundary log's shared byte
# vectors from the codetracer sibling, and check the vendored copy.
#
#   bash scripts/vendor-jsbound-vectors.sh            # copy, then check
#   bash scripts/vendor-jsbound-vectors.sh --check    # check only
#
# The vectors are the contract between the two implementations of
# `jsbound.log`: codetracer `libs/jsbound` (Rust, which writes them with
# `cargo run --example generate_vectors`) and `packages/boundary-format`
# here (TypeScript, tested against them by tests/boundary/format.test.ts).
# They are vendored rather than read from the sibling so this repository's
# tests run without it.
#
# The source directory carries SHA256SUMS: one `<sha256>  <file>` line per
# vector file. Copying refuses a source whose files do not match it, or that
# holds a file it does not list. --check verifies the vendored copy the same
# way and, when the sibling is checked out, that the vendored SHA256SUMS is
# the sibling's: a vendored copy older than the Rust side fails by name.
# Without the sibling it says so and verifies the vendored copy alone.
#
# Source: $JSBOUND_VECTORS_SRC, else ../codetracer/libs/jsbound/vectors.
#
# Exit codes: 0 verified; 1 a hash, a file set or the sibling disagrees;
# 2 usage or a missing directory.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dest="${root}/tests/boundary/vectors"
src="${JSBOUND_VECTORS_SRC:-${root}/../codetracer/libs/jsbound/vectors}"
say() { echo "vendor-jsbound-vectors.sh: $*" >&2; }

mode=vendor
case "${1:-}" in
"") ;;
--check) mode=check ;;
*)
	say "unknown argument '$1' (expected nothing or --check)"
	exit 2
	;;
esac

sha256_of() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | cut -d' ' -f1
	else
		shasum -a 256 "$1" | cut -d' ' -f1
	fi
}

# verify DIR: every file SHA256SUMS lists has that hash, and DIR holds no
# file SHA256SUMS does not list. Prints the number of files verified.
verify() {
	local dir="$1" sums="$1/SHA256SUMS" listed=0 hash name actual
	if [ ! -f "${sums}" ]; then
		say "${dir} has no SHA256SUMS"
		return 1
	fi
	declare -A seen=()
	while IFS= read -r line; do
		hash="${line%%  *}"
		name="${line#*  }"
		if [ -z "${name}" ] || [ "${name}" = "${line}" ] || [ "${name#*/}" != "${name}" ]; then
			say "${sums}: malformed line '${line}'"
			return 1
		fi
		if [ ! -f "${dir}/${name}" ]; then
			say "${dir}/${name} is listed in SHA256SUMS but missing"
			return 1
		fi
		actual="$(sha256_of "${dir}/${name}")"
		if [ "${actual}" != "${hash}" ]; then
			say "${dir}/${name}: sha256 ${actual}, SHA256SUMS says ${hash}"
			return 1
		fi
		seen["${name}"]=1
		listed=$((listed + 1))
	done <"${sums}"
	for path in "${dir}"/*; do
		name="$(basename "${path}")"
		if [ "${name}" != SHA256SUMS ] && [ -z "${seen[${name}]:-}" ]; then
			say "${dir}/${name} is not listed in SHA256SUMS"
			return 1
		fi
	done
	# A directory with a handful of files cannot be the vector set (a
	# manifest, at least 21 valid vectors with their expectations, the
	# refusals); verifying it would be a green over nothing.
	if [ "${listed}" -lt 43 ]; then
		say "${dir}: only ${listed} file(s) listed; this is not the vector set"
		return 1
	fi
	echo "${listed}"
}

if [ "${mode}" = vendor ]; then
	if [ ! -d "${src}" ]; then
		say "no source at ${src}; check out codetracer beside this repository or set JSBOUND_VECTORS_SRC"
		exit 2
	fi
	n="$(verify "${src}")" || exit 1
	rm -rf "${dest}"
	mkdir -p "${dest}"
	cp "${src}"/* "${dest}/"
	say "vendored ${n} file(s) from ${src}"
fi

if [ ! -d "${dest}" ]; then
	say "nothing vendored at ${dest}; run this script without --check"
	exit 2
fi
n="$(verify "${dest}")" || exit 1
if [ -d "${src}" ]; then
	if ! cmp -s "${src}/SHA256SUMS" "${dest}/SHA256SUMS"; then
		say "the vendored vectors differ from ${src}:"
		diff "${dest}/SHA256SUMS" "${src}/SHA256SUMS" >&2 || true
		say "re-vendor with: bash scripts/vendor-jsbound-vectors.sh"
		exit 1
	fi
	say "OK: ${n} vendored file(s) match their SHA256SUMS and the sibling at ${src}"
else
	say "OK: ${n} vendored file(s) match their SHA256SUMS (no sibling at ${src}; not compared with it)"
fi

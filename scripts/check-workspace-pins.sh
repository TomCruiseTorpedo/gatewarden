#!/usr/bin/env bash
# Asserts every @gatewarden/* dependency pin matches the sibling package's own
# version.
#
# Why this guard exists. packages/* depend on each other by concrete version
# ("0.1.0") rather than by the "workspace:" protocol, because npm cannot parse
# "workspace:" at all -- it exits EUNSUPPORTEDPROTOCOL -- and without an
# npm-readable manifest set there is no package-lock.json, and without a
# package-lock.json GitHub's dependency graph sees only direct dependencies and
# Dependabot can never raise a security alert on a transitive one. The concrete
# pin buys that coverage back.
#
# The cost is this failure mode, measured 2026-07-30: bump a sibling to 0.2.0
# while a dependent still pins "0.1.0", and bun resolves the dependent against
# the REGISTRY-PUBLISHED 0.1.0 tarball instead of the local source tree. It is
# silent -- the install succeeds, and bun.lock still records
# "@gatewarden/govern@workspace:packages/govern" while the on-disk symlink
# actually points into node_modules/.bun/@gatewarden+govern@0.1.0/. Builds and
# tests then pass against stale published code.
#
# "workspace:*" has no such drift because it always means "whatever is local".
# This guard restores that invariant by making the drift loud instead.
#
# Usage: bash scripts/check-workspace-pins.sh

set -euo pipefail

cd "$(dirname "$0")/.."

fail=0

# Collect each workspace package's declared version.
declare -a names=()
declare -a versions=()
for pkg in packages/*/package.json; do
  [[ -f "$pkg" ]] || continue
  name=$(node -p "require('./$pkg').name")
  version=$(node -p "require('./$pkg').version")
  names+=("$name")
  versions+=("$version")
done

version_of() {
  local want="$1" i
  for i in "${!names[@]}"; do
    if [[ "${names[$i]}" == "$want" ]]; then
      printf '%s' "${versions[$i]}"
      return 0
    fi
  done
  return 1
}

# Check every dependency edge that points at a sibling workspace package.
for pkg in packages/*/package.json; do
  [[ -f "$pkg" ]] || continue
  while IFS=$'\t' read -r field dep spec; do
    [[ -n "$dep" ]] || continue
    if ! actual=$(version_of "$dep"); then
      continue # not a workspace sibling; npm/bun resolve it from the registry
    fi
    if [[ "$spec" == "$actual" ]]; then
      echo "$pkg: $dep@$spec matches sibling version: OK"
    else
      echo "$pkg: $field.$dep is pinned to '$spec' but $dep is version '$actual'" >&2
      echo "  A dependent pinned off its sibling resolves against the PUBLISHED" >&2
      echo "  tarball, not packages/. Update the pin to '$actual'." >&2
      fail=1
    fi
  done < <(node -e '
    const p = require("./'"$pkg"'");
    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
      for (const [dep, spec] of Object.entries(p[field] ?? {})) {
        if (dep.startsWith("@gatewarden/")) console.log([field, dep, spec].join("\t"));
      }
    }
  ')
done

if [[ "$fail" -ne 0 ]]; then
  echo "workspace pin check FAILED" >&2
  exit 1
fi

echo "workspace pins consistent with sibling versions"

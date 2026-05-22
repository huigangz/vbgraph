#!/usr/bin/env bash
#
# Rebuild src/extraction/wasm/vbnet.wasm from the pinned VB.NET tree-sitter
# grammar. Run this only when intentionally bumping the grammar — treat the
# commit pin like a code dependency: bumping it requires PR review.
#
# Requirements: git, npx, and Docker OR a WASI SDK reachable by the
# tree-sitter CLI (`tree-sitter build --wasm` downloads a WASI SDK on first
# use). tree-sitter-cli is fetched on demand via npx — it is NOT a project
# dependency, because the compiled .wasm is committed and shipping does not
# need the CLI.
#
# Usage:  scripts/build-vbnet-wasm.sh
set -euo pipefail

UPSTREAM_REPO="https://github.com/CodeAnt-AI/tree-sitter-vb-dotnet"
# Pinned grammar commit — keep in sync with vbnet.wasm.sha256 line 2.
UPSTREAM_COMMIT="cfca210ce8fdcb5245bd9cd5c47ce0a21a8488d5"
TS_CLI_VERSION="0.26.9"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WASM_OUT="${REPO_ROOT}/src/extraction/wasm/vbnet.wasm"
SHA_OUT="${WASM_OUT}.sha256"

BUILD_DIR="$(mktemp -d)/tree-sitter-vb-dotnet"
trap 'rm -rf "$(dirname "${BUILD_DIR}")"' EXIT

echo "Cloning ${UPSTREAM_REPO} @ ${UPSTREAM_COMMIT} ..."
git clone --quiet "${UPSTREAM_REPO}" "${BUILD_DIR}"
git -C "${BUILD_DIR}" checkout --quiet "${UPSTREAM_COMMIT}"

echo "Building WASM (tree-sitter-cli ${TS_CLI_VERSION}) ..."
( cd "${BUILD_DIR}" && npx --yes "tree-sitter-cli@${TS_CLI_VERSION}" build --wasm )

cp "${BUILD_DIR}/tree-sitter-vb_dotnet.wasm" "${WASM_OUT}"

# Line 1: SHA-256 of the .wasm (pinned by __tests__/wasm-integrity.test.ts).
# Line 2: the upstream grammar commit it was built from.
SHA="$(node -e "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync('${WASM_OUT}')).digest('hex'))")"
printf '%s\n%s\n' "${SHA}" "${UPSTREAM_COMMIT}" > "${SHA_OUT}"

echo "Wrote ${WASM_OUT}"
echo "  sha256: ${SHA}"
echo "  commit: ${UPSTREAM_COMMIT}"
echo "Done. Review the diff and update the pin in this script if intentional."

#!/usr/bin/env bash
# Syncs auto-generated Codama clients and IDL assets from the contracts repo.
# Run this after `yarn generate-svm-artifacts` in the contracts repo.
# See ACP-56 for context.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDK_ROOT="$(dirname "$SCRIPT_DIR")"
CONTRACTS_ROOT="${CONTRACTS_ROOT:-$(dirname "$SDK_ROOT")/contracts}"

if [ ! -d "$CONTRACTS_ROOT/src/svm" ]; then
  echo "Error: contracts repo not found at $CONTRACTS_ROOT"
  echo "Set CONTRACTS_ROOT env var to the contracts repo path."
  exit 1
fi

echo "Syncing SVM clients from $CONTRACTS_ROOT..."

# Sync Codama-generated clients
rm -rf "$SDK_ROOT/src/svm/clients"
cp -r "$CONTRACTS_ROOT/src/svm/clients" "$SDK_ROOT/src/svm/clients"

# Sync auto-generated assets (IDLs + Anchor types)
rm -rf "$SDK_ROOT/src/svm/assets"
cp -r "$CONTRACTS_ROOT/src/svm/assets" "$SDK_ROOT/src/svm/assets"

echo "Done. Synced clients/ and assets/ to sdk/src/svm/"

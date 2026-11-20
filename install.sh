#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_TESTS=0

for arg in "$@"; do
  case "$arg" in
    --test) RUN_TESTS=1 ;;
    *)
      echo "Unknown option: $arg" >&2
      echo "Usage: ./install.sh [--test]" >&2
      exit 1
      ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22.19 or 24.2+ is required and must be on PATH." >&2
  exit 1
fi

if [ "$RUN_TESTS" -eq 1 ]; then
  node --test "$REPO_ROOT"/*.test.mjs
fi

exec node "$REPO_ROOT/cli.mjs" install --host codex

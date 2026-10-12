#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
command -v bun >/dev/null || { printf '%s\n' 'Bun is required; no fallback runtime.' >&2; exit 1; }
exec bun "$HERE/scripts/cli.ts" "$@"

#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

for tool in node npm ffmpeg ffprobe; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'Post-merge setup requires %s on PATH. Install it before retrying.\n' "$tool" >&2
    exit 1
  fi
done

# Restore the exact locked dependencies without running dependency lifecycle scripts.
# This does not download AI models or contact configured analysis providers.
npm ci --ignore-scripts --no-audit --no-fund
npm run build

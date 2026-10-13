#!/usr/bin/env bash
# download-models.sh — compatibility wrapper: the implementation now lives in TypeScript
# as `bun run models-download` (scripts/models-download.ts), which reads the same .env.
#
#   scripts/download-models.sh            download whatever is missing (idempotent, resumable)
#   scripts/download-models.sh --check    verify only: exit 1 if any model file is missing
#   scripts/download-models.sh -h | --help
set -euo pipefail
ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
cd "$ROOT"   # so bun reads the project .env from the repo root, as `bun run` does
exec bun run scripts/models-download.ts "$@"

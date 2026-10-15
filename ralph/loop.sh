#!/usr/bin/env bash
# Ralph loop launcher (POSIX). Holds no policy: the loop lives in ralph/lib/run-loop.mjs so
# this script and loop.ps1 cannot drift.
#
#   ./ralph/loop.sh plan 1 specs/my-spec.md
#   ./ralph/loop.sh build 20
#   ./ralph/loop.sh review 5 --model opus
#   ./ralph/loop.sh status
#
# Options: --model M  --issue KEY  --skip-tracker  --no-transcripts
# Environment: RALPH_MODEL, RALPH_AGENT_CMD, RALPH_SUPERVISED=1 (confirm each iteration)

set -uo pipefail

RALPH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "[Ralph] ERROR: node (>= 20) is required and was not found on PATH" >&2
  exit 1
fi

exec node "$RALPH_DIR/lib/run-loop.mjs" "$@"

#!/usr/bin/env bash
# relay-llm: invoke any LM Studio model with auto-injected Relay memory context.
#
# Usage:
#   relay-llm <model> "<task>"
#
# Behaviour:
#   - Calls `relay context emit --target lmstudio-cli --workdir "$PWD"` to fetch
#     the recall layer for the current workdir.
#   - If the layer is non-empty, passes it as the system prompt (`-s`) to
#     `lms chat`. Otherwise falls through with no system prompt.
#   - All `lms chat` rules apply: model must be loaded in LM Studio first.
#
# Depends on: relay (this CLI), lms (LM Studio CLI). `relay context emit` is
# delivered by T3; until that lands the script will not inject context but
# will still pass the task through to `lms chat`.
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: relay-llm <model> \"<task>\"" >&2
  exit 2
fi

MODEL="$1"
shift
TASK="$*"

CTX="$(relay context emit --target lmstudio-cli --workdir "$PWD" 2>/dev/null || true)"

if [ -n "$CTX" ]; then
  exec lms chat "$MODEL" -s "$CTX" -p "$TASK"
else
  exec lms chat "$MODEL" -p "$TASK"
fi

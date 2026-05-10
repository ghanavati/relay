#!/usr/bin/env bash
# scripts/smoke-test.sh
#
# Pre-ship verification: simulate a fresh user installing Relay from scratch
# and using it once. Catches issues unit tests miss (link/path/HOME drift,
# missing commands, JSON contract drift).
#
# Usage:  ./scripts/smoke-test.sh
# Exit:   0 if every step passes, non-zero on first failure.
#
# Steps follow /tmp/relay-build-spec-wave3.md T55.

set -uo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PASS_COUNT=0
FAIL_COUNT=0
FAIL_STEPS=()

# Preserve real HOME so we can restore PATH side effects on cleanup.
REAL_HOME="$HOME"

step_pass() { printf '[PASS] %s\n' "$1"; PASS_COUNT=$((PASS_COUNT + 1)); }
step_fail() { printf '[FAIL] %s\n' "$1" >&2; FAIL_COUNT=$((FAIL_COUNT + 1)); FAIL_STEPS+=("$1"); }

# Allocate isolated HOME with empty .relay/ + .claude/.
TMP_HOME="$(mktemp -d -t relay-smoke-XXXXXX)"
mkdir -p "$TMP_HOME/.relay" "$TMP_HOME/.claude"

cleanup() {
  set +e
  ( cd "$REPO_DIR" && HOME="$REAL_HOME" npm unlink --silent >/dev/null 2>&1 )
  rm -rf "$TMP_HOME"
}
trap cleanup EXIT

cd "$REPO_DIR" || { step_fail "cd repo"; exit 1; }

# Step 2 — build from source.
if npm run build --silent >/tmp/relay-smoke-build.log 2>&1; then
  step_pass "npm run build"
else
  step_fail "npm run build (see /tmp/relay-smoke-build.log)"
  exit 1
fi

# Step 3 — npm link (local install, not global registry).
if npm link --silent >/tmp/relay-smoke-link.log 2>&1; then
  step_pass "npm link"
else
  step_fail "npm link (see /tmp/relay-smoke-link.log)"
  exit 1
fi

# Step 4 — switch HOME to tmp and pin DB path.
export HOME="$TMP_HOME"
export RELAY_DB_PATH="$HOME/.relay/relay.db"

# Step 5 — relay init --auto --json.
INIT_OUT="$(relay init --auto --json 2>/tmp/relay-smoke-init.err)"
INIT_RC=$?
if [ $INIT_RC -eq 0 ] && printf '%s' "$INIT_OUT" | jq . >/dev/null 2>&1; then
  step_pass "relay init --auto --json"
else
  step_fail "relay init --auto --json (rc=$INIT_RC, see /tmp/relay-smoke-init.err)"
fi

# Step 6 — relay memory remember.
REMEMBER_OUT="$(relay memory remember 'fresh smoke test fact' --type fact --json 2>/tmp/relay-smoke-remember.err)"
REMEMBER_RC=$?
if [ $REMEMBER_RC -eq 0 ] && printf '%s' "$REMEMBER_OUT" | jq . >/dev/null 2>&1; then
  step_pass "relay memory remember"
else
  step_fail "relay memory remember (rc=$REMEMBER_RC, see /tmp/relay-smoke-remember.err)"
fi

# Step 7 — relay memory recall and assert the fact is present.
RECALL_OUT="$(relay memory recall 'fresh' --json 2>/tmp/relay-smoke-recall.err)"
RECALL_RC=$?
if [ $RECALL_RC -eq 0 ] && printf '%s' "$RECALL_OUT" | jq -e '.. | strings | select(test("fresh smoke test fact"))' >/dev/null 2>&1; then
  step_pass "relay memory recall (memory present)"
else
  step_fail "relay memory recall (rc=$RECALL_RC, missing memory; see /tmp/relay-smoke-recall.err)"
fi

# Step 8 — relay context emit, validate hookSpecificOutput in JSON.
EMIT_OUT="$(relay context emit --target cc --workdir "$HOME" 2>/dev/null)"
EMIT_RC=$?
if [ $EMIT_RC -eq 0 ] && printf '%s' "$EMIT_OUT" | jq -e '.hookSpecificOutput' >/dev/null 2>&1; then
  step_pass "relay context emit --target cc"
else
  step_fail "relay context emit --target cc (rc=$EMIT_RC, missing hookSpecificOutput)"
fi

# Step 9 — relay doctor.
DOCTOR_OUT="$(relay doctor --json 2>/tmp/relay-smoke-doctor.err)"
DOCTOR_RC=$?
if [ $DOCTOR_RC -eq 0 ] && printf '%s' "$DOCTOR_OUT" | jq . >/dev/null 2>&1; then
  step_pass "relay doctor --json"
else
  step_fail "relay doctor --json (rc=$DOCTOR_RC, see /tmp/relay-smoke-doctor.err)"
fi

# Final tally.
printf '\n--- smoke-test summary ---\n'
printf 'pass: %d\n' "$PASS_COUNT"
printf 'fail: %d\n' "$FAIL_COUNT"
if [ "$FAIL_COUNT" -ne 0 ]; then
  printf 'failed steps:\n'
  for s in "${FAIL_STEPS[@]}"; do printf '  - %s\n' "$s"; done
  exit 1
fi
exit 0

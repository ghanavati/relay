#!/bin/bash
# scripts/extract-from-relay-mcp.sh
#
# One-time extraction of solo-CLI source from the relay-mcp monorepo.
# Copies only the keep-list paths, drops compliance / hosted / regulatory.
# Idempotent — safe to re-run.
#
# Usage:
#   ./scripts/extract-from-relay-mcp.sh [SOURCE_REPO]
#   default SOURCE_REPO: /Users/ghanavati/ai-stack/Projects/relay-mcp

set -euo pipefail

SRC="${1:-/Users/ghanavati/ai-stack/Projects/relay-mcp}"
DEST="$(cd "$(dirname "$0")/.." && pwd)"

if [[ ! -d "$SRC/src" ]]; then
  echo "ERROR: source $SRC/src not found" >&2
  exit 1
fi

echo "Extracting from $SRC -> $DEST"

# 1. mirror src/, then prune the lose-list
rsync -a --delete \
  --exclude='*.test.ts' \
  --exclude='/hosted/' \
  --exclude='/self-improve/' \
  --exclude='/skills/' \
  --exclude='/runtime/validations/' \
  --exclude='/runtime/oversight/' \
  --exclude='/runtime/intoto/' \
  --exclude='/runtime/retention/' \
  --exclude='/runtime/exceptions/' \
  --exclude='/runtime/drift/' \
  --exclude='/runtime/guardian/' \
  --exclude='/runtime/leases/' \
  --exclude='/runtime/store/sign-store.ts' \
  --exclude='/runtime/store/annotation-store.ts' \
  --exclude='/runtime/store/models-store.ts' \
  --exclude='/runtime/store/team-store.ts' \
  --exclude='/cli/cmd-sign-off.ts' \
  --exclude='/cli/cmd-validate.ts' \
  --exclude='/cli/cmd-team.ts' \
  --exclude='/cli/cmd-drift.ts' \
  --exclude='/cli/cmd-guardian.ts' \
  --exclude='/cli/cmd-exceptions.ts' \
  --exclude='/cli/report-*.ts' \
  --exclude='/cli/report.ts' \
  --exclude='/cli/backtest.ts' \
  --exclude='/tools/sign_off.ts' \
  --exclude='/tools/amend_sign_off.ts' \
  --exclude='/tools/validate.ts' \
  --exclude='/tools/export_aibom.ts' \
  --exclude='/tools/create-validation-*' \
  --exclude='/tools/list-validation-*' \
  --exclude='/tools/create-oversight-*' \
  --exclude='/tools/list-oversight-*' \
  --exclude='/tools/log-override.ts' \
  --exclude='/tools/list-overrides.ts' \
  --exclude='/tools/create-operator-annotation.ts' \
  --exclude='/tools/list-operator-annotations.ts' \
  --exclude='/tools/list-drift-events.ts' \
  --exclude='/tools/acknowledge-guardian-event.ts' \
  --exclude='/tools/list-guardian-events.ts' \
  --exclude='/tools/list-guardian-policies.ts' \
  --exclude='/tools/list-retention-events.ts' \
  --exclude='/tools/run-retention.ts' \
  --exclude='/tools/list-exceptions.ts' \
  --exclude='/tools/log-exception.ts' \
  --exclude='/tools/resolve-exception.ts' \
  --exclude='/tools/register-model.ts' \
  --exclude='/tools/get-model.ts' \
  --exclude='/tools/list-models.ts' \
  --exclude='/tools/update-model-status.ts' \
  --exclude='/tools/get_project_briefing.ts' \
  --exclude='/config/hosted-config.ts' \
  --exclude='/security/secret-guard.ts' \
  --exclude='/security/secret-rotation*' \
  --exclude='/contracts/sign_off.ts' \
  --exclude='/contracts/validate.ts' \
  --exclude='/contracts/export_aibom.ts' \
  --exclude='/contracts/oversight*' \
  --exclude='/contracts/validation-*' \
  --exclude='/contracts/operator-annotation*' \
  --exclude='/contracts/drift*' \
  --exclude='/contracts/guardian*' \
  --exclude='/contracts/retention*' \
  --exclude='/contracts/exception*' \
  --exclude='/contracts/model.ts' \
  --exclude='/contracts/get_project_briefing.ts' \
  "$SRC/src/" "$DEST/src/"

# 2. copy tests for kept paths only (memory + cli kept commands)
mkdir -p "$DEST/src/memory" "$DEST/src/cli" "$DEST/src/runtime" "$DEST/src/context" "$DEST/src/workers"

for testfile in \
  "src/memory/memory-lint.test.ts" \
  "src/memory/memory-upsert.test.ts" \
  "src/memory/memory-trust-tier.test.ts" \
  "src/memory/memory-gc.test.ts" \
  "src/memory/memory-recall-tracking.test.ts" \
  "src/memory/memory-lint-extra.test.ts" \
  "src/memory/budgeted-recall.test.ts" \
  "src/memory/consolidation.test.ts" \
  "src/memory/corpus-query.test.ts" \
  "src/memory/corpus-store.test.ts" \
  "src/cli/cmd-memory-ops.test.ts" \
  "src/cli/cmd-compare.test.ts" \
  "src/cli/cmd-corpus.test.ts" \
  "src/cli/cmd-diverge.test.ts" \
  "src/cli/cmd-get-run.test.ts" \
  "src/cli/cmd-capability.test.ts" \
  ; do
  if [[ -f "$SRC/$testfile" ]]; then
    mkdir -p "$DEST/$(dirname "$testfile")"
    cp "$SRC/$testfile" "$DEST/$testfile"
  fi
done

# 3. migration script (already shipped to src/scripts/ in S3)
if [[ -f "$SRC/src/scripts/migrate-cc-memory.ts" ]]; then
  mkdir -p "$DEST/src/scripts"
  cp "$SRC/src/scripts/migrate-cc-memory.ts" "$DEST/src/scripts/"
fi

# 4. summary
echo ""
echo "Extract complete. File counts:"
find "$DEST/src" -name '*.ts' -not -name '*.test.ts' | wc -l | xargs printf "  source files:   %s\n"
find "$DEST/src" -name '*.test.ts' | wc -l | xargs printf "  test files:     %s\n"
find "$DEST/src" -type d | wc -l | xargs printf "  directories:    %s\n"

echo ""
echo "Next: cd $DEST && npm install && npx tsc --ignoreDeprecations 5.0"

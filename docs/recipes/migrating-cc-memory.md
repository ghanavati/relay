# Recipe: Migrating Claude Code memory

If you've been using Claude Code's auto-memory at `~/.claude/projects/.../memory/`, you can migrate it into Relay's MemoryStore in 3 commands. The migration is idempotent and reversible.

## Why migrate

- Claude Code memory is a passive file index. Relay's MemoryStore has FTS5 + relevance scoring + the recalled_lessons context layer.
- After migration, your CC sessions auto-inject the same lessons into delegated workers (via the SessionStart hook).
- Single source of truth: stop maintaining memory in two places.

## Step 1: Inventory (read-only, no changes)

```bash
node dist/scripts/migrate-cc-memory.js --inventory --json
```

Output: how many files, distribution by prefix (feedback/project/reference), tombstones detected, estimated migration scope.

Run `relay-mcp doctor` first if you don't know the path — the migration script defaults to `~/.claude/projects/-Users-<you>-ai-stack-Projects-relay-mcp/memory`.

## Step 2: Dry run (transform, no DB writes)

```bash
node dist/scripts/migrate-cc-memory.js --dry-run --json > /tmp/migration-plan.json
less /tmp/migration-plan.json
```

Review the proposed mappings:
- `feedback_*` files → `memory_type: lesson`
- `project_*` files → `memory_type: context`
- `reference_*` and `user_*` files → `memory_type: fact`
- Tombstones (frontmatter.name=='SUPERSEDED' or description starting 'REMOVED'/'RESOLVED') are SKIPPED automatically.

If you see entries you don't want migrated, edit the source files first (delete, mark as superseded, or move to another dir).

## Step 3: Apply (writes to DB)

```bash
node dist/scripts/migrate-cc-memory.js --apply --json
```

Passes:
1. Re-runs inventory (might find new files)
2. Re-runs transform
3. Calls `MemoryStore.upsert()` for each — idempotent, safe to re-run
4. Verifies via `relay memory recall` round-trip on a sample
5. Reports counts: applied / skipped / failed

Every imported entry is tagged `migration:YYYY-MM-DD` for rollback.

## Step 4: Archive source (optional)

The migration script does NOT delete `~/.claude/projects/.../memory/`. If you want to archive it:

```bash
node dist/scripts/migrate-cc-memory.js --archive
```

Moves the source dir to `<dir>.archived-YYYY-MM-DD/`. NOT a delete. Restore by `mv <dir>.archived-YYYY-MM-DD/ <dir>/` if migration was wrong.

## Verification

```bash
relay memory recall 'berry verifier' --type lesson
relay memory show-context 'session resume'
```

If you see your old CC entries surfacing in the recall, migration succeeded.

## Rollback

Every imported entry has tag `migration:YYYY-MM-DD`. Roll back by SQL:

```sql
UPDATE memories
SET superseded_by='migration-rollback'
WHERE tags_json LIKE '%"migration:2026-05-02"%';
```

(Substitute the date you ran `--apply`.)

## What gets lost in migration

- File modification timestamps (replaced with import time)
- Frontmatter beyond name/description/type (stored in tags or content header)
- Inter-file links via `[name](file.md)` (preserved as text but not as graph edges)

What's preserved:
- Frontmatter `name` and `description` (prepended to content)
- Body text verbatim (subject to 100K char truncation; sanitizeContent redacts API key patterns)
- Tags (filename prefix + migration date + frontmatter type)
- `memory_source: human` + `pinned: true` → trust_level: 'trusted' (GC-exempt)
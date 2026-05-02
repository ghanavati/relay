# AGENTS.md — Relay (solo CLI)

Single source of truth for any AI working on this project. Read only the sections relevant to your task.

## What this is

Relay is a solo-use CLI for delegating bounded coding tasks to AI workers (Codex, OpenRouter, LM Studio, Anthropic) with a local SQLite audit trail and persistent memory. Extracted from the relay-mcp monorepo on 2026-05-02.

NOT in scope: compliance/regulatory artifacts, multi-tenant hosted mode, model registry lifecycle, billing, EU AI Act / SR 11-7 / DORA reports, oversight workflows.

## Code rules (non-negotiable)

- **Immutability**: never mutate objects in place — return new copies via spread.
- **No silent error swallowing**: every `catch` must log or rethrow with context.
- **Validate at boundaries**: external input (CLI args, env vars, API responses) validated with Zod.
- **Async I/O**: use `fs/promises`, never `readFileSync` in hot paths.
- **Functions < 50 lines**, files < 800 lines.
- **No hardcoded model names** — env vars only.
- **RelayError**: use `RelayError` from `src/errors.ts` for user-facing failures.

## Critical API patterns

### better-sqlite3 — SYNCHRONOUS

```typescript
const row = db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId);
db.prepare('INSERT INTO runs VALUES (?, ?)').run(id, status);
const tx = db.transaction(() => { db.prepare('...').run(...); });
tx(); // sync — NOT await tx()
```

NEVER use `async`/`await` on db operations. SQL inline as template strings.

### node:test (no Jest patterns)

```typescript
import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';

// In-memory SQLite for tests:
process.env['RELAY_DB_PATH'] = ':memory:';  // MUST be first line, before db imports
```

`mock.fn()`, `mockResolvedValueOnce()`, `mockReturnValue()` — DO NOT EXIST in node:test.

### MemoryStore.upsert() for migration writes

```typescript
store.upsert({
  entity_key: '...',          // collision key
  content: '...',
  memory_type: 'lesson',
  memory_source: 'human',
  pinned: true,               // makes entry GC-exempt
  // DO NOT pass source_run_id — bypasses write rate limit
  // DO NOT pass expires_at — null means permanent
});
```

## Dev environment tips

```bash
npm install                                    # better-sqlite3 + zod + typescript
npm run build                                  # tsc + chmod dist/cli.js
npm link                                       # makes 'relay' available globally for testing
```

Node >= 20 required (better-sqlite3 native module). On macOS install Xcode CLT first.

## Testing instructions

```bash
npm test                                       # node --test dist/**/*.test.js
RELAY_ALLOWED_ROOTS= npm test                  # skip env-gated tests
npm run typecheck                              # fast tsc, no dist output
```

Add or update tests for the code you change. v0.1.0 inherited tests from relay-mcp; many depend on dropped modules and need triage (see [Unreleased] in CHANGELOG.md).

## Recurrent failure patterns (across many sessions)

1. **Run tools before explaining them.** If a tool answers the question — run it.
2. **No silent drops.** After identifying N items, present a disposition table for ALL N.
3. **Read immediately before acting.** File state changes — re-read before edit.
4. **Code is truth, planning docs are intent.** Cite `src/file:line`, never planning docs.
5. **State intent before directional changes.** No silent pivots.
6. **`tsc --noEmit` is authoritative for compile claims.** Subagents miss split files. Always verify with the compiler.
7. **Check worker state before retrying a "failed" dispatch.** `ps aux | grep <provider>`, `tail ~/.relay-mcp/run-*.log`, `ls ~/.relay/sessions/` — the worker may be alive even when the MCP tool returned an error.

## Dispatching workers

LM Studio concurrent rules + parallel dispatch patterns: see `docs/parallel.md`.
Headline: `isolation: "worktree"` + every prompt ends with `git add && git commit`. Without the commit, files are lost on merge.

## Extraction history

This repo was extracted from `relay-mcp` on 2026-05-02. If you need that context: `docs/findings/2026-05-02-extract-session-learnings.md`.

## What must not regress

- Relay is model-agnostic — never hardcode a provider or model in source.
- SQLite is the sole canonical store.
- `delegate.ts` stays focused — extract logic to helpers.
- Tests are the spec — preserve behavior through refactoring.

## PR instructions

- **Commit format:** `<type>(<scope>): <description>` — types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`. Commit per discrete task.
- **Title format:** match the first commit subject.
- **Before committing:** `npm run build && npm test`.
- **CHANGELOG:** every shipped change updates `[Unreleased]` (or the right milestone bucket).

## Provenance

Extracted from `github.com/ghanavati/relay-mcp` on 2026-05-02. See `docs/findings/2026-05-02-extract-session-learnings.md` for the extraction methodology.

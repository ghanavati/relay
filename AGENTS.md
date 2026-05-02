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

## Build & test

```bash
npm run build                                  # tsc + chmod
node --test dist/**/*.test.js                  # full suite
RELAY_ALLOWED_ROOTS= node --test dist/**/*.test.js   # skip env-gated tests
```

## Recurrent failure patterns (across many sessions)

1. **Run tools before explaining them.** If a tool answers the question — run it.
2. **No silent drops.** After identifying N items, present a disposition table for ALL N.
3. **Read immediately before acting.** File state changes — re-read before edit.
4. **Code is truth, planning docs are intent.** Cite `src/file:line`, never planning docs.
5. **State intent before directional changes.** No silent pivots.
6. **`tsc --noEmit` is authoritative for compile claims.** Subagents miss split files. Always verify with the compiler.
7. **Check worker state before retrying a "failed" dispatch.** `ps aux | grep <provider>`, `tail ~/.relay-mcp/run-*.log`, `ls ~/.relay/sessions/` — the worker may be alive even when the MCP tool returned an error.

## Dispatching to LM Studio — concurrent invocation rules

Validated by peer session 2026-04-09 (24 tasks across 3 batches, 83% success). See
`docs/findings/2026-05-02-extract-session-learnings.md` for full evidence.

- **Always** use `isolation: "worktree"` for parallel LM Studio dispatch. `isolation: "none"` serializes through workdir mutex even when `delegate_parallel` is used.
- **Every task prompt MUST end with**:
  ```
  Do not build. Do not run tests. Do not run npm. Do not modify any config file.
  git add <output-file> && git commit -m '<message>'
  ```
  Without the commit, files in the worktree are LOST when the worktree merges back.
- 1 file in, 1 file out. No multi-file wiring (timeouts).
- Include all API method signatures inline. Don't make the worker discover them by reading files (#1 timeout cause).
- `timeout_ms: 360000` if heavy context, `180000` floor for tight tasks.
- `context_mode: "minimal"` to keep prefill < 2K tokens; full context with 8 lanes saturates and all tasks time out at 180s with token_estimate=0.

## Extraction methodology (this codebase came from a monorepo)

If you ever need to fork another part of relay-mcp into a new distro:

- **Whitelist > exclude.** Tightly-coupled codebases cascade on every drop. Default to writing an INCLUDE list, not an EXCLUDE list.
- **Leaf vs orchestration.** Leaf modules (types, utilities, single-purpose stores) extract cleanly. Orchestration (dispatchers, entry points, runners) is faster to write fresh than to fix transitive deps. If a file imports > 3 modules from outside its own subsystem, treat it as orchestration.
- **Switch tactics at the residual.** Bulk drops while error count drops ≥5/cycle. At ≤3/cycle, switch to surgical fixes or fresh writes.
- **Test files in a separate pass.** After source code compiles, triage test files separately. Tests that depend on dropped modules go away — don't "fix later", they rot.

## What must not regress

- Relay is model-agnostic — never hardcode a provider or model in source.
- SQLite is the sole canonical store.
- `delegate.ts` stays focused — extract logic to helpers.
- Tests are the spec — preserve behavior through refactoring.

## Commit format

```
<type>: <description>
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`. Commit per discrete task.

## Provenance

Extracted from `github.com/ghanavati/relay-mcp` on 2026-05-02. See `docs/provenance.md` for the keep/lose list and extraction script.

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
8. **Subagent worktree-cwd discipline:** subagents that land code MUST verify cwd is the worktree path before each Edit. Multiple wave-1 agents misdirected edits to the main repo.
9. **Add-don't-refactor for shared files:** extending an existing file by adding new exports is safe. Replacing the file (T23 wave 2 doctor.ts) breaks consumers' tests.
10. **Hook contract:** SessionStart stdout becomes additionalContext OR JSON `{hookSpecificOutput:{hookEventName:'SessionStart',additionalContext:'...'}}`. Raw `{memories:[...]}` is undocumented behavior — use `relay context emit --target cc`.
11. **Stop hook fires per-turn; SessionEnd fires once at termination.** Use SessionEnd for distillation, not Stop.
12. **Auto-extracted entries MUST never auto-pin** (memory-store.ts:529-541 has the SQL fence).

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
- Auto-extract entries (tag `auto-extract`) excluded from autoPin in markRecallSuccess.
- Hook scripts ALWAYS check pause sentinel (`~/.relay/paused`) before recall.
- `memory_source` labels are unforgeable from the CLI: `relay memory remember` always tags `human`; only internal `handleRemember(args, sourceArg)` can set other sources.

## PR instructions

- **Commit format:** `<type>(<scope>): <description>` — types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`. Commit per discrete task.
- **Title format:** match the first commit subject.
- **Before committing:** `npm run build && npm test`.
- **CHANGELOG:** every shipped change updates `[Unreleased]` (or the right milestone bucket).

## Provenance

Extracted from `github.com/ghanavati/relay-mcp` on 2026-05-02. See `docs/findings/2026-05-02-extract-session-learnings.md` for the extraction methodology.

## Wave 4 Lessons

Lessons surfaced during the wave 4 parallel-subagent run. Read these before dispatching subagents that touch loggers, hooks, settings files, LIKE queries, init flows, doctor checks, or LLM context emission.

### 1. Path unification discipline

When migrating loggers or log paths, every reader and every writer must change in the same atomic commit. Wave 4 shipped a state where `relay memory tail` read one path while the auto-extract pipeline wrote a different one — Codex review flagged this HIGH because the user saw an "empty" tail despite live writes happening. If you split the migration across PRs, at least one revision will be observably broken. Grep for the old path before declaring done.

### 2. Hook marker discipline

Install/uninstall must match by a stable marker field (e.g. `name: "relay-context"`), not by substring-matching the command line. Codex flagged a Wave 4 uninstaller that grep'd for `relay context emit` in user shell hooks — a user with their own hook calling that command would have it silently removed. Always pair install with a unique marker and uninstall by exact-marker equality.

### 3. Settings ENOENT vs EPARSE

When manipulating user JSON config files (settings, hooks, env), distinguish missing-file from parse-error. Missing → safe to write a fresh file. Parse error → STOP and surface the error; do not overwrite. Wave 4 had an init path that treated both cases the same way and would have nuked a user's broken-but-recoverable JSON. Read first, parse with try/catch, branch on the error code.

### 4. Wildcard escape in LIKE queries

Every `LIKE` query against user-supplied strings must use `ESCAPE '\'` and pre-escape `_`, `%`, and `\` in the user input. Without it, a search for `foo_bar` matches `fooXbar` and a search for `100%` matches everything. Wave 4 added a memory-search filter that was missing this — caught before it shipped. Pattern: `escapeLike(s)` helper that returns `s.replace(/[\\_%]/g, '\\$&')`, then pass the result with `ESCAPE '\\'`.

### 5. Hardcoded model names violate model-agnostic spec

Restating "What must not regress" with a Wave 4 incident: a new LM Studio caller hardcoded a specific model id as a fallback default. This violates the spec ("Relay is model-agnostic"). Pull the model id from `RELAY_LMSTUDIO_MODEL`, or discover via `lms ps` at runtime. If neither yields a value, fail with `RelayError`, do not paper over with a literal.

### 6. Status taxonomy completeness

When you add a new pipeline branch, audit the status enum before merging. Wave 4 introduced multi-lesson auto-extract, which created a new partial-failure case (some lessons written, some failed). The existing `success | failure` enum could not represent it, so we added `partial:write`. If your new code has any branch the existing taxonomy can't describe, extend the enum in the same PR — do not silently coerce to the closest existing value.

### 7. Berry MCP path, not HTTP

Berry hallucination-detection integration must call the MCP tool `mcp__berry__detect_hallucination`. Do not assume an HTTP endpoint at `http://localhost:<port>/detect` or similar — Berry is exposed via MCP, not REST, and any HTTP path will silently fail. If you are tempted to add a `fetch()` call to Berry, you have the wrong mental model.

### 8. Auto-detect + auto-wire in init

Providers detected during `relay init` (Codex CLI, LM Studio, OpenRouter API key) should be wired automatically with a confirm prompt — or skipped silently in `--auto` mode. Wave 4 found a flow that detected LM Studio but then required a separate `relay setup-llm` invocation to actually wire it. That is two mental steps where one will do. Detection without wiring is friction; wire on detect, prompt for confirmation in interactive mode, write through in `--auto`.

### 9. Doctor checks are append-only (T23 repeat)

This is the second time we have hit it. Adding a new doctor check must NOT touch existing exports, signatures, or check IDs. T23 (wave 2) broke the doctor JSON output because a new check's refactor renamed an existing field. Wave 4 had a near-miss with the same shape. Treat `src/doctor.ts` as append-only: add new check functions, register them in the checks array, do not edit the existing check signatures or their output keys.

### 10. Default `--min-trust provisional` for LLM context emission

Context emission to live LLM sessions should default `--min-trust provisional`, not `--min-trust speculative`. Wave 4 shipped an early default of speculative which would have surfaced unverified, low-trust memories into running LLM sessions as authoritative context. The provisional floor matches what a human reviewer would expect: "include things we have at least one signal for, exclude raw guesses." If the user wants speculative content they can opt in explicitly.

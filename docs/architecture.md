# Architecture

Relay is a solo CLI (~70 source files) extracted from the relay-mcp monorepo. This doc explains the layout for someone making changes.

## Repo layout

```
src/
├── cli.ts                    # Entry point: argv parsing + dispatch
├── cli/                      # Subcommands
│   ├── commands.ts           # CliIO type (only)
│   ├── cmd-memory-ops.ts     # remember/recall/show-context/get/hook/to-rules
│   ├── cmd-corpus.ts         # Corpus subsystem (deferred for v0.1.0)
│   ├── cmd-run.ts            # Single-task delegation
│   ├── cmd-doctor.ts         # Provider/DB health probe
│   ├── cmd-history.ts        # Browse past runs
│   ├── cmd-diff.ts           # Show files_changed for a run
│   ├── cmd-compare.ts        # Side-by-side run comparison
│   └── cmd-init.ts           # Interactive setup wizard
├── memory/                   # MemoryStore (FTS5 + lint + GC)
├── workers/
│   ├── codex.ts              # Subprocess via codex-cli 0.128+
│   ├── generic-http-runner.ts# Slim chat-completions client (base for OR + LMS)
│   ├── lmstudio.ts
│   ├── openrouter.ts
│   ├── runner.ts             # WorkerRunner interface
│   └── types.ts              # WorkerTask + WorkerResult
├── tools/                    # MCP-tool-style handlers, used by cmd-* CLI
├── runtime/
│   ├── store/                # SQLite + db.ts + run-store + cost-store
│   ├── budget/               # Per-scope cost cap tracking
│   ├── capability/           # Worker capability registry
│   └── intent-classifier.ts  # Used during delegate
├── context/                  # Context layer providers (recalled_lessons, etc.)
├── contracts/                # Zod schemas + TS types
├── config/                   # providers.ts + runtime.ts + constants.ts
├── security/redaction.ts     # API key redaction in sanitizeContent
└── errors.ts                 # RelayError + makeError

scripts/
└── extract-from-relay-mcp.sh # One-time bootstrap (kept for provenance)

src/scripts/
└── migrate-cc-memory.ts      # Compiled to dist/scripts/migrate-cc-memory.js

docs/                        # User-facing docs
AGENTS.md                    # Rules for AI agents working on this code
```

## Data flow: a single `relay run`

```
1. user runs:   relay run "<task>" --provider lmstudio --model glm-4.7-flash
2. cli.ts       parseFlags + dispatch to executeRunCommand
3. cmd-run.ts   RunStore.create({status: 'running'}) → inserts row, returns void
                RunStore.recordEvent('started', ...)
4. cmd-run.ts   instantiates LmStudioRunner from src/workers/lmstudio.ts
5. LmStudioRunner.run(task) → GenericHttpRunner.run
                (HTTP POST to /v1/chat/completions, 5min timeout)
6. cmd-run.ts   on response: RunStore.complete(run_id, {status, duration_ms, token_usage, ...})
                or RunStore.recordError on failure
7. cmd-run.ts   emit JSON or human-readable to stdout
```

## Data flow: memory recall

```
1. user runs:   relay memory recall "berry hallucination check"
2. cmd-memory-ops.ts → handleRecall (from src/tools/recall.ts)
3. handleRecall builds RecallQuery{ query, types, token_budget, ... }
4. MemoryStore.getCandidates(query) → SQLite FTS5 + recency fallback
5. budgetedRecall(candidates, query, now) → ranks within token budget,
                                            increments recall_count
6. Output: array of {memory_id, content, score, ...} as JSON or text
```

## Database

Single SQLite file at `~/.relay/relay.db` (or `$RELAY_DB_PATH`). Schema includes:

- `runs` — every dispatch (status, provider, model, duration, tokens, files_changed_json)
- `run_events` — timeline events per run
- `run_diffs` — per-file diff text (optional, only populated when filesystem snapshot diff is computed)
- `memories` — the MemoryStore
- `memory_reads` — recall access log
- `cost_events` — per-run cost records
- `budget_limits` — caps + spend tracking
- `idempotency_keys` — dedup window for repeated dispatches

Everything is single-writer. Don't run two `relay` processes against the same DB simultaneously.

## Key invariants (don't break)

- `delegate.ts` (when re-added in v0.2) stays thin: validate → create run → dispatch → record. Logic goes into helpers.
- No hardcoded model names — env vars or config only.
- SQLite is the sole canonical store — no parallel persistence systems.
- AGENTS.md stays under ~5KB. New rules earn their always-loaded slot.

## v0.1.0 limitations

- No agentic tool-loop in workers (single-shot text generation only). Codex has its own tool surface.
- Anthropic worker dropped (re-added in v0.2 with text-only first, agentic later).
- `relay parallel`, `relay budget`, `relay corpus` deferred to v0.2.
- Test suite inherited from relay-mcp — several tests have broken imports from dropped modules and need triage.
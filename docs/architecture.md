# Architecture

System overview for contributors. The companion to [AGENTS.md](../AGENTS.md): AGENTS.md tells you the rules, this tells you the map.

## 1. High-level purpose

Relay is a model-agnostic, local-first CLI that bridges AI delegation and persistent memory across the four frontier surfaces a solo developer actually uses (Claude Code, Codex CLI, LM Studio, OpenRouter/Anthropic). It carries hard-won lessons forward across stateless sessions by writing a single SQLite store, then injects relevant entries into each new session through per-target wrappers. No external services, no hosted backend, no provider lock-in — every byte of memory lives in `~/.relay/relay.db` and every API key stays in your shell.

## 2. Module map

| Module | Path | Responsibility |
|---|---|---|
| CLI entry | [`src/cli.ts`](../src/cli.ts) | argv parsing, command dispatch, `--help` text, version |
| Subcommands | [`src/cli/`](../src/cli/) | one file per command (`cmd-*.ts`); thin glue between argv and tools/memory |
| Memory store | [`src/memory/`](../src/memory/) | `MemoryStore` (CRUD + FTS5), scoring (`memory-engine.ts`), trust tiers (`computeTrustLevel`), GC, lint, schema migrations |
| Context layers | [`src/context/`](../src/context/) | `loadRecalledLessonsContent` + provider registry (recalled_lessons, brief, run history, session scope) |
| Runtime | [`src/runtime/`](../src/runtime/) | SQLite (`store/db.ts`), `RunStore`, `relay-log.ts` (NDJSON), capability + budget tables |
| Security | [`src/security/`](../src/security/) | secret redaction (`redaction.ts`) at write-time, PII redaction (`redaction-pii.ts`) for auto-extract |
| Workers | [`src/workers/`](../src/workers/) | per-provider runners: `codex.ts`, `openrouter.ts`, `lmstudio.ts`, `anthropic.ts`, base `generic-http-runner.ts` |
| Tools | [`src/tools/`](../src/tools/) | MCP-style handlers wrapped by the CLI (`remember.ts`, `recall.ts`, `get_memory.ts`, …) |
| Contracts | [`src/contracts/`](../src/contracts/) | Zod schemas + TS types shared across boundaries |
| Config | [`src/config/`](../src/config/) | env var resolution, provider config, constants |
| One-shot scripts | [`src/scripts/`](../src/scripts/) | `migrate-cc-memory.ts` — port Claude Code auto-memory into SQLite |
| Errors | [`src/errors.ts`](../src/errors.ts) | `RelayError` + `makeError` (canonical user-facing failure type) |

## 3. Data flow — write path

```
user (CLI or Codex MCP)
  → src/cli.ts                 parseFlags, dispatch
  → src/cli/cmd-memory-ops.ts  executeRememberCommand
  → src/tools/remember.ts      handleRemember(args, source)
  → src/memory/memory-store.ts MemoryStore.remember()
                                 ├─ sanitizeContent (strip <private>, redact secrets, cap length)
                                 ├─ assertWorkdirAllowed (RELAY_MEMORY_ALLOWED_WORKDIRS)
                                 ├─ INSERT into memories + memories_fts (FTS5 trigger)
                                 ├─ gcByTokenBudget (evict non-pinned if over cap)
                                 └─ purgeSuperseded (drop 30+ day tombstones)
  → SQLite ~/.relay/relay.db   tables: memories, memories_fts
```

`memory_source` is unforgeable from the CLI: `relay memory remember` always passes `'human'`; only internal `handleRemember(args, sourceArg)` callers (auto-extract, migration) can set other sources. See [memory-store.ts:31](../src/memory/memory-store.ts) `computeTrustLevel` for the tier derivation.

## 4. Data flow — read path

```
hook fires (CC SessionStart, or `relay context emit`)
  → src/cli/cmd-context-emit.ts  executeContextEmitCommand(target)
  → src/context/layers.ts        loadRecalledLessonsContent(workdir, task, opts)
  → src/memory/memory-store.ts   MemoryStore.getCandidates(query)
                                   ├─ FTS5 match on memories_fts
                                   ├─ recency fallback when query empty
                                   ├─ min_trust SQL guard
                                   └─ workdir scope (or global)
  → src/memory/memory-engine.ts  budgetedRecall (rank within token_budget)
                                   ├─ score = recency × type weight × tag boost
                                   └─ increment recall_count (audit)
  → guardMemoryContent           strip markdown headers, HTML, injection phrases
  → render per-target            cc | codex | lmstudio-http | lmstudio-cli
  → memory_reads audit row       INSERT (memory_id, run_id, read_source, workdir, created_at)
```

The same loader feeds both the SessionStart hook and `relay run` delegations when `RELAY_RECALLED_LESSONS=1` is set ([layers.ts:263](../src/context/layers.ts)).

## 5. Auto-extract pipeline

Wires Claude Code's SessionEnd hook to a local model that mines lessons from the transcript and writes them back as unverified memories.

```
CC SessionEnd hook
  → relay memory auto-extract --from-stdin
  → src/cli/cmd-memory-auto-extract.ts executeMemoryAutoExtractCommand
       1. parse + Zod-validate hook payload (session_id, transcript_path, cwd)
       2. loadConsent(cwd) → <cwd>/.relay/auto-extract.json (opt-in; ENOENT → skip)
       3. block remote providers when consent.allow_remote=false (v1 local only)
       4. loadRecentTranscriptWindow (trailing N bytes, configurable)
       5. redactSecretsAndPII (src/security/redaction-pii.ts)
       6. extractLessonsViaLmStudio (LM Studio chat completion → raw JSON)
       7. cleanupAndValidate (Zod schema + min_confidence floor)
       8. checkLessonViaBerry (optional; RELAY_AUTO_EXTRACT_REQUIRE_BERRY=1)
       9. handleRemember(args, 'auto-run-recorder') per surviving lesson
            tag: 'auto-extract' → trust-tier fence blocks auto-pin (memory-store.ts:529)
      10. appendAudit → ~/.relay/auto-extract.log (one ndjson line per run)
```

Status taxonomy is closed: `ok`, `skipped:*`, `error:*`, `partial:berry-flag` ([cmd-memory-auto-extract.ts:70](../src/cli/cmd-memory-auto-extract.ts)). Hook discards exit code and stderr — every failure path catches, logs, exits 0.

## 6. Hook system

Two hooks installed by `relay memory hook --install [--session-end]`:

- **SessionStart** runs `relay context emit --target cc --workdir "$PWD"` → injects recalled memories as `hookSpecificOutput.additionalContext`. Pause sentinel (`~/.relay/paused` or `<workdir>/.relay/paused`) short-circuits before any DB read.
- **SessionEnd** runs `relay memory auto-extract --from-stdin` → see section 5.

Install/uninstall match by **stable marker field** (`_relay_id: 'relay-context-cc'`), never by substring on the command line. The matcher (`isRelayManagedHookEntry` in [cmd-memory-ops.ts:207](../src/cli/cmd-memory-ops.ts)) accepts three signals: marker equality, legacy `id` field, exact `command` string match. A user's own hook that happens to mention `relay context emit` is never silently removed. ENOENT vs EPARSE on the settings file is distinguished — missing → write fresh, parse error → abort.

## 7. Trust tiers

[`computeTrustLevel`](../src/memory/memory-store.ts) is the single derivation, applied at read time:

| Tier | Rule |
|---|---|
| `trusted` | `memory_source='human'` AND `pinned=true` (explicit human endorsement) |
| `trusted` | `success_recall_count >= 3` (proven useful across 3+ successful runs) |
| `provisional` | `memory_source='human'` OR `success_recall_count >= 1` |
| `unverified` | default for auto-written entries |

Threshold is overridable via `RELAY_MEMORY_AUTOPIN_THRESHOLD`. The recalled_lessons renderer prefixes unverified entries with `[UNVERIFIED]` and failure-tagged entries with `⚠ FAILED:` so workers can weight them. `relay context emit` defaults `--min-trust=provisional` to keep unverified auto-extracts out of live LLM sessions unless explicitly requested.

## 8. Logging

Two log streams, both append-only NDJSON:

- **`~/.relay/relay.ndjson`** — activity log: every recall, remember, wipe, forget, hook fire/skip, doctor run, context emit, pause/resume. Tailed by `relay memory tail`. Rotates at 10 MB or 30 days; archive format `relay.ndjson.<timestamp>`. See [runtime/relay-log.ts](../src/runtime/relay-log.ts).
- **`memory_reads` table** — per-recall audit row inside SQLite: `memory_id`, `run_id`, `read_source` (`mcp` / `context-layer` / `cli`), `workdir`, `created_at`. Lets `relay memory why <id>` reconstruct surfacing history. See [db.ts:243](../src/runtime/store/db.ts).
- **`~/.relay/auto-extract.log`** — one-line-per-run audit for the SessionEnd pipeline (status, model, turns_read, redaction_hits, lessons_written, duration_ms).

POSIX `O_APPEND` semantics make line-sized writes multi-process safe on local disks; rotation is decided by [`shouldRotate`](../src/runtime/relay-log.ts) (pure function, testable without filesystem mocking).

## 9. Per-LLM injection contracts

`relay context emit --target <t>` ([cmd-context-emit.ts](../src/cli/cmd-context-emit.ts)) emits a single command's stdout in the exact shape each LLM front-end expects — no jq pipelines downstream:

| Target | Output shape | Consumer wiring |
|---|---|---|
| `cc` | `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}` (one line) | `.claude/settings.json` SessionStart hook stdout |
| `codex` | plain markdown, no envelope, no trailing newline | pipe to a file, pass via `codex -c model_instructions_file=<path>` |
| `lmstudio-http` | `{"role":"system","content":"..."}` (one line) | concat into OpenAI-compatible chat completions `messages` array |
| `lmstudio-cli` | single-line text (newlines escaped as `\n`) | `lms chat -s "<text>"` |

When no memories match, every target emits an empty-but-valid wrapper so callers don't need conditional handling.

## 10. Privacy boundaries

Defence in depth, ordered by enforcement point:

1. **Per-workdir consent** — auto-extract refuses to run without `<cwd>/.relay/auto-extract.json` (opt-in; default opt-out). Consent declares `allow_remote`, `max_bytes`, `min_confidence`, `extra_redaction_patterns`. See [auto-extract-consent.ts](../src/memory/auto-extract-consent.ts).
2. **`RELAY_MEMORY_ALLOWED_WORKDIRS`** — colon-separated allowlist of workdir prefixes; unset = all allowed; set + non-matching workdir = `MEMORY_WORKDIR_FORBIDDEN`. Enforced in `assertWorkdirAllowed` at the store layer.
3. **`.relayignore`** — gitignore-syntax filter that scrubs tool-call results before transcript redaction (`relay project disable` writes one; `relay project enable` removes it).
4. **Redaction passes** — `redactSecrets` at write time (AWS / OpenAI / GitHub / Slack / Bearer / env-assignments / PEM keys), `redactSecretsAndPII` before any LLM send (adds emails, phone, IP, IBAN).
5. **`<private>...</private>` blocks** — stripped at write time inside `sanitizeContent`.
6. **Pause sentinel** — `~/.relay/paused` or `<workdir>/.relay/paused` blocks both hooks before any work. Created by `relay pause`, removed by `relay resume`.
7. **Provider API keys** — env vars only; never written to SQLite, never logged.

## 11. Build + test layout

```bash
npm install                              # better-sqlite3 native module + zod + typescript
npm run build                            # tsc → dist/; chmod +x dist/cli.js
npm run typecheck                        # tsc --noEmit (authoritative compile check)
npm test                                 # node --test --test-concurrency=1 dist/**/*.test.js
npm run clean                            # rm -rf dist tsconfig.tsbuildinfo
```

Tests are colocated next to source (`memory-store.ts` + `memory-remember.test.ts`, etc.). Test runtime is `node:test`; mocking patterns from Jest do not apply. SQLite tests set `process.env['RELAY_DB_PATH'] = ':memory:'` **before** any db import — the in-memory DB is opened lazily on first `getDb()` call.

`better-sqlite3` is a native module: requires Node >=20, a working C++ toolchain (Xcode CLT on macOS, `build-essential python3` on Linux), and is rebuilt on `npm install`. All DB operations are **synchronous** by design — never use `async`/`await` on `db.prepare(...)` chains.

## 12. Control fabric (Phase 8)

The control layer turns Relay from memory-plus-dispatch into an agent-control bus. Any supported LLM surface registers as a *control session*; one command surface (`relay session ...` for humans, Relay tools for models) drives them all.

- **Sessions + store** (`src/control/session-store.ts`) — synchronous better-sqlite3 over five v4 tables: `control_sessions`, `control_events`, `control_mailbox`, `control_grants`, `control_delivery_attempts`. Every boundary is Zod-validated; rows read back are re-validated so corrupted JSON fails loudly.
- **Broker** (`src/control/broker.ts`) — the single policy path. Human sends route straight through; model (`llm`) sends are default-deny and require a human-issued grant with a TTL and a message budget, plus content redaction and loop detection on repeated identical messages. These are guardrails on agent-initiated traffic, not a separate audit product — every decision (enqueued, blocked, delivered, failed) is recorded as a control event.
- **Adapter registry + capability taxonomy** (`src/control/adapter-registry.ts`, `src/control/types.ts`) — each adapter declares exactly what it supports (`register`, `observe`, `tail`, `context_inject`, `mailbox`, `resume_send`, `live_stdin`, `interrupt`, ...). Delivery routes to the strongest shared capability; unsupported operations are refused, never silently degraded. No adapter infers behavior from a provider name.
- **Adapters** (`src/control/adapters/`) — Claude Code (ambient hook context delivery), Codex (discovery-gated MCP/instructions), generic-HTTP (transcript-backed OpenRouter/Anthropic), and the deterministic fake used in tests. None claim a live stdin channel.
- **Relay-owned processes** (`src/control/pty-session.ts`) — the one strong-control path. `relay session spawn` launches a child through node `child_process` pipes (no PTY dependency in v1): Relay tails its output as events, writes to its stdin (`live_stdin`), interrupts it (SIGINT), and records stopped-state on exit. Full-TTY CLIs detect non-TTY stdio, so they report `live_stdin` absent.
- **Read model** (`src/control/read-model.ts`) — a bounded `ControlSnapshot` for the terminal Command Central, built only from store/broker helpers (no UI-local SQL).

Diagnostics surface this layer: `relay verify` runs a rolled-back control smoke (broker send → delivered, zero residue), `relay doctor` reports session/queued/blocked counts, and `relay info` shows the session rollup plus the truthful adapter capability catalog.

## See also

- [AGENTS.md](../AGENTS.md) — contributor operating manual (code rules, recurrent failure patterns)
- [docs/memory.md](./memory.md) — memory model, trust tiers, FTS5 recall, GC
- [docs/configuration.md](./configuration.md) — env vars, config.json, consent files
- [docs/providers.md](./providers.md) — Codex / OpenRouter / LM Studio / Anthropic setup
- [docs/commands.md](./commands.md) — every command, every flag

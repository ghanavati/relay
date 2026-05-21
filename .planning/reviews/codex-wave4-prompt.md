You are reviewing the Wave 4 changes to Relay (https://github.com/ghanavati/relay) — a TypeScript CLI for cross-LLM memory and delegation. Base = tag v0.1.0, head = current HEAD (v0.1.1). 50 commits, 102 source files changed, ~23k LOC added.

# Project context

**What Relay is:** A local-first CLI that gives every LLM (Claude Code, Codex, LM Studio, OpenRouter, Anthropic API) access to:
1. A persistent memory store (SQLite at `~/.relay/relay.db`)
2. A unified delegation interface (`relay delegate`, `relay run`)
3. Session-aware context injection via provider-specific mechanisms (CC SessionStart hook, Codex AGENTS.md, LM Studio `lms chat -s`, OpenAI/Anthropic system role)

**Architecture:** TypeScript ESM, better-sqlite3 (synchronous), Zod schemas at all IO boundaries, node:test runner. No Express, no async DB. All providers go through a unified `Runner` interface.

# Wave 4 themes

1. **Memory hardening** — workdir scoping guard (SHIP-70), trust tier system (unverified → provisional → trusted), supersedes chains, regex search, tag-stats analytics
2. **Auto-extract pipeline** — SessionEnd hook reads transcript window → PII redaction → LM Studio extraction → Zod validate → Berry hallucination check → handleRemember. Extensive failure-mode enum (`error:write-all-failed`, `partial:berry-flag`, etc.)
3. **Cross-LLM context injection** — `relay context emit` writes per-provider context format. CC hook injection format, Codex `model_instructions_file`, LM Studio system prompt, generic OpenAI/Anthropic system role.
4. **New CLI commands** — `relay memory {chain, tag-stats, search, rollback, consolidate, diff, why, recent, forget, tail}`, `relay tui`, `relay info`, `relay setup-llm`
5. **Dynamic provider system** — `src/config/providers.ts` supports any OpenAI/Anthropic-compatible API via `RELAY_PROVIDER_<NAME>_*` env vars
6. **TUI** — Ink-based 3-panel dashboard (activity log, recall preview, status bar)

# Review priorities (in order)

## CRITICAL — must-find
1. **Security**
   - `src/memory/memory-store.ts:49` `assertWorkdirAllowed` — does the env-var-based allowlist have bypass paths? Check for path normalization, symlink escape, prefix attack (e.g., `/foo/barx` matching `/foo/bar`).
   - Secret redaction in `sanitizeContent` — does it cover OpenAI keys, Anthropic keys, GitHub tokens (ghp_), AWS keys (AKIA prefix), generic high-entropy strings?
   - `<private>` tag stripping — does it handle nested tags, malformed tags, ReDoS-prone regex?
   - Auto-extract pipeline — can adversarial transcript content cause prompt injection into the LM Studio extractor? Can a poisoned extraction overwrite an existing trusted memory?
   - Berry hallucination check — what happens if Berry returns malformed JSON? Is the failure handled or does it crash the pipeline?
   - HTTP providers — are responses validated with Zod before being trusted? Any place where raw API output flows directly to user-visible output without sanitization?

2. **Concurrency / data integrity**
   - better-sqlite3 is synchronous — but the auto-extract pipeline runs in a SessionEnd hook concurrently with other CLI calls. Check for:
     - Missing transactions on multi-step writes (handleRemember + chain update)
     - Race between supersedes chain walk and concurrent remember
     - File lock on `~/.relay/relay.db` — what if two Claude Code sessions end at the same time?
   - WAL mode enabled? Check `MemoryStore` constructor.

3. **Pipeline failure modes**
   - `src/cli/cmd-memory-auto-extract.ts` has a 20-value status enum. For each `error:*` and `partial:*` value, does the calling code (hook, manual invocation, test) handle it correctly, or do some statuses cause silent data loss?
   - If LM Studio is partially down (HTTP 500), what happens? If Berry is unreachable? If Zod validation fails halfway through a batch of 5 extractions?

## HIGH — should-find
4. **API contract stability** — did Wave 4 break any signatures? `MemoryStore` constructor, `Memory` interface fields, CLI flag names, exit codes, JSON output shape, environment variable names. Compare git tags v0.1.0 vs HEAD.
5. **Provider system** — `src/config/providers.ts` dynamic provider URL/key handling. Edge cases: missing key, malformed URL, headers with `\r\n` injection, OpenAI-Responses vs Chat-Completions endpoint dispatch correctness.
6. **TUI** — `src/cli/cmd-tui.ts` `gatherSnapshot` calls 6 things in parallel (`Promise.all`). Any of them failing should not crash the whole snapshot. Currently `readRecallPreview` and `readRecentActivity` have try/catch returning `[]`, but `probeCodex`, `probeLmStudio`, `readDbEntries`, `readHookInstalled` — do they all handle failure?

## MEDIUM — quality
7. **Test coverage gaps** — list any new code without tests. Especially around: provider catalog, dynamic provider dispatch, TUI panels (Ink rendering), CLI dispatchers.
8. **Code organization** — `src/cli.ts` is becoming a giant dispatcher. Any opportunities to break it up?
9. **Error messages** — do user-facing errors say what to do, not just what failed?

## LOW — nice-to-have
10. **Documentation** — README.md was rewritten. Is the command surface accurate? Any commands shipped without docs? Any docs referencing commands that don't exist?
11. **Naming / consistency** — are flag names consistent across commands (`--json` everywhere? `--workdir` vs `--cwd`?)
12. **Dead code** — any unused exports, unreachable branches, unused env vars?

# Output format

Produce findings in this exact structure (one block per finding):

```
### [SEVERITY] [CATEGORY] <Short title>
**File:** `path/to/file.ts:LINE`
**Issue:** <one paragraph>
**Why it matters:** <one paragraph — concrete failure mode>
**Suggested fix:** <one paragraph or code block>
```

SEVERITY: CRITICAL | HIGH | MEDIUM | LOW
CATEGORY: security | concurrency | pipeline | api-contract | provider | tui | tests | organization | error-messages | docs | consistency | dead-code

After findings, end with:

```
## Summary
- Critical: <count>
- High: <count>
- Medium: <count>
- Low: <count>

## Ship verdict
SHIP | SHIP-WITH-FIXES | DO-NOT-SHIP

## One-paragraph rationale
<your overall take>
```

# Constraints

- Be brutal but accurate. No false positives. No "consider" or "might want to" — say "this is a bug" or don't say it.
- If a concern is theoretical (no concrete failure mode), drop to LOW or don't include it.
- Don't review unchanged code. Only the diff from v0.1.0..HEAD.
- Cite line numbers. Cite file paths.
- Don't suggest stylistic changes (semicolons, formatting, var naming) unless they create real bugs.
- Don't recommend tests for tested code.

Start by running `git log v0.1.0..HEAD --oneline | head -50` to see the commits, then `git diff v0.1.0..HEAD --stat` for scope, then dive in.

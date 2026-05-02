# Recipe: Morning startup

The 5-command sequence to start a productive coding session with Relay.

## 1. Health check

```bash
relay doctor
```

Verifies: codex CLI version, OPENROUTER_API_KEY set, LM Studio reachable, Anthropic key (if you have one), DB writable. Catch broken setup before you start work.

## 2. Yesterday's runs

```bash
relay history --limit 10
```

What did you actually do yesterday? Filter by status to see only failures:
```bash
relay history --status error --limit 5
```

## 3. Recall relevant lessons for today's task

```bash
relay memory recall "authentication flow rewrite"
```

Returns FTS5 + relevance-scored matches from your memory store. Skim in 30 seconds.

## 4. Dispatch first task

Simple: one-shot to local LM Studio (zero cost):
```bash
relay run "summarize the diff in src/auth/" --provider lmstudio --model zai-org/glm-4.7-flash
```

Cross-file reasoning: route to codex (frontier):
```bash
relay run "refactor src/auth/ to use the new session model" --provider codex --model gpt-5.3-codex
```

The SessionStart hook (installed via `relay memory hook --install`) means CC sessions automatically receive recalled lessons — no need to invoke separately.

## 5. Save what you learned

End of the session, save anything worth remembering:
```bash
relay memory remember 'Berry verifier needs gpt-4.1-nano direct OpenAI not OpenRouter' --type lesson --tag verification --pinned
```

Use `--type` accurately:
- `fact` for stable knowledge
- `decision` for chosen approaches with rationale
- `lesson` for failure-driven learnings
- `context` for project-specific background

Use `--pinned` for high-trust entries (they're GC-exempt forever).

## Bonus: hook into Claude Code

If you haven't already:
```bash
relay memory hook --install
```

Now every new CC session in this project auto-receives your top lessons via the recalled_lessons context layer. No re-explaining context.

## When something feels stale

`relay memory lint` and `relay memory gc` are deferred to v0.2. For now, query directly:

```bash
sqlite3 ~/.relay/relay.db "SELECT memory_id, content FROM memories WHERE last_accessed_at < datetime('now', '-90 days') AND pinned = 0;"
```

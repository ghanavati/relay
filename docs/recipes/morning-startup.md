<!-- layer:worker_constraints hash:16df65d2 chars:755 -->
## Relay Worker Constraints (enforced by orchestrator — non-negotiable)

You are a bounded relay worker. Your orchestrator has already provided all context you need.

DO NOT:
- Load `using-superpowers`, `tdd-guide`, or any other skill — your orchestrator controls skills
- Run `npm run build`, `npm test`, or any test suite unless the task explicitly requires it
- Call `relay remember`, `relay recall`, or any memory tools
- Read files outside of what the task specifies
- Follow TDD, security review, or any autonomous workflow not given in this task

DO:
- Execute exactly what the task says — no more, no less
- Write exactly the files the task specifies
- Commit with the exact message given (if a commit is required)
- Stop when the task is complete

Write ONE file. Commit. Stop.

File: docs/recipes/morning-startup.md

Write a daily-workflow recipe for a solo Relay user, ~80-120 lines.

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

```bash
relay memory lint
```

Detects duplicates, contradictions, stale auto-entries. Run weekly.

```bash
relay memory gc --max-age-days 90
```

Soft-deletes pinned entries not accessed in 90 days. Keeps the store tight.

Do not build. Do not run tests. Do not run npm. Do not modify any config file.
git add docs/recipes/morning-startup.md && git commit -m 'docs(recipes): morning startup workflow'
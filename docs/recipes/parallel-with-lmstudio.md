# Recipe: Parallel dispatch with LM Studio

LM Studio supports up to 16 lanes of true parallel inference (Qwen3.6 = 8 lanes, GLM-4.7-Flash = 16 lanes). This recipe shows how to use that capability efficiently.

## v0.2 (planned)

```bash
relay parallel <task-spec.json> --isolation worktree
```

Where task-spec.json is:
```json
{
  "tasks": [
    {"id": "task-1", "task": "write tests for src/auth.ts", "provider": "lmstudio", "model": "zai-org/glm-4.7-flash"},
    {"id": "task-2", "task": "write tests for src/session.ts", "provider": "lmstudio", "model": "zai-org/glm-4.7-flash"}
  ],
  "max_concurrency": 4,
  "timeout_ms": 360000
}
```

## v0.1.0 workaround

Until v0.2 ships, dispatch parallel via the relay-mcp parent project (which still has the full delegate_parallel surface):

```bash
cd /path/to/relay-mcp
# Use mcp__relay-mcp__delegate_parallel via Claude Code, OR via the relay-mcp CLI directly
```

## Critical rules (validated 2026-04-09 across 24 tasks)

### Rule 1: isolation:worktree, never isolation:none

LM Studio's batched inference is real, but relay's `acquireWorkdirMutex` serializes tasks sharing a workdir. Only `isolation: worktree` gives each task its own workdir → separate mutex → true parallel.

Evidence:
- isolation:none, 6 tasks: 51s wall (sequential, staggered spawn)
- isolation:worktree, 4 tasks: 24-34s wall (true parallel)
- isolation:worktree, 8 tasks @ Max Concurrency 8: 35s wall (same as 1 task)

### Rule 2: every prompt MUST end with a commit instruction

```
Do not build. Do not run tests. Do not run npm. Do not modify any config file.
git add <output-file> && git commit -m '<message>'
```

**Why:** files written in the worktree but not committed are LOST when the worktree merges back to main. The commit makes them durable.

### Rule 3: 1 file in, 1 file out

LM Studio handles single-file work well. Multi-file wiring causes timeouts. If a task needs multiple files, split into multiple parallel tasks.

### Rule 4: Inline ALL API signatures the task needs

Don't make the worker discover types by reading additional files. That's the #1 timeout cause. Paste the relevant TypeScript signatures directly into the prompt.

### Rule 5: Use minimal context mode

`context_mode: minimal` keeps prefill tokens under ~2K. Full context with 8 lanes (8 × 10K AGENTS.md) saturates the model and ALL 8 tasks time out at 180s with token_estimate=0.

### Rule 6: Timeout floor 180s, ceiling 360s

- Tight 1-file edits: 180000ms
- Heavier work, full context, or first run with cold-load: 360000ms

## Routing rules

| Task type | Provider/Model | Lanes |
|---|---|---|
| Schema/contract test generation | LM Studio (GLM-4.7-Flash) | up to 16 |
| Logic/implementation tests | LM Studio (Qwen3.6-35b) | up to 8 |
| Frontier reasoning critique | OpenRouter (claude-opus / deepseek-r1) | 2-3 |
| Cross-file architectural critique | Codex (gpt-5.3-codex xhigh) | 1 |

## Dispatch decision matrix

```
Is the task pattern-repetition across 2+ independent files?
  YES → LM Studio parallel (worktree+commit)
  NO  → single-shot Codex or OpenRouter
```

Do not build. Do not run tests. Do not run npm. Do not modify any config file.
git add docs/recipes/parallel-with-lmstudio.md && git commit -m 'docs(recipes): parallel dispatch rules + workaround for v0.1.0'
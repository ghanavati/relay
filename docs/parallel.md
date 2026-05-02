# Parallel dispatch

Relay can fan a single bounded task out to N workers running concurrently. v0.1.0 ships memory + single-task delegation only — parallel dispatch arrives in v0.2.

## Why parallel

- LM Studio with Max Concurrency: 8 (or 16 for GLM-4.7-Flash) supports true batched inference. 8 tasks complete in ~30s wall-time, same as 1 task.
- Cost: $0 for local models (LM Studio).
- Variety: dispatch the same task to multiple frontier models (claude / deepseek-r1 / gemini) and pick the best.

## Routing rules (v0.2 design)

Relay's routing follows the rules from the relay-mcp parent:

| Task type | Provider | Lanes |
|---|---|---|
| Schema/contract test generation | LM Studio (GLM-4.7-Flash) | up to 8 |
| Logic/implementation tests | LM Studio (Qwen3.6-35b) | up to 4 |
| Frontier reasoning critique | OpenRouter (claude-opus / deepseek-r1) | 2-3 |
| Mixed batch | GLM for schema, Qwen for logic | combined |

## Isolation modes

Relay's `delegate_parallel` accepts an `isolation` field:

- `worktree` — each task gets a separate git worktree, separate workdir mutex. **TRUE PARALLEL.** Use this for all parallel dispatch.
- `none` — all tasks share the same workdir. Relay's `acquireWorkdirMutex` serializes them. Sequential, not parallel. Use this only for single-task dispatch.

**Critical:** with `isolation: worktree`, every task prompt MUST end with a git commit instruction. Otherwise files written in the worktree are LOST when the worktree merges back.

## Spec discipline (v0.2 design, validated 2026-04-09 across 24 tasks)

For LM Studio workers (GLM, Qwen):

- 1 file read + 1 file write per task. No multi-file wiring.
- Include all API method signatures inline. Don't make the worker discover them by reading additional files (that's the #1 timeout cause).
- End every prompt with: `Do not build. Do not run tests. Do not run npm. Do not modify any config file. git add <file> && git commit -m '<message>'`
- 180s timeout floor. 360s if context per task is heavy.

## Throughput evidence (2026-04-09)

| Mode | Tasks | Wall time | Cost |
|---|---|---|---|
| sequential (isolation:none) | 6 | 51s | $0 |
| parallel (isolation:worktree) | 4 | 24-34s | $0 |
| parallel (8-lane LM Studio Max) | 8 | 35s | $0 |

Wall time is bounded by the longest single task, NOT the sum.

## Workaround for v0.1.0

Until `relay parallel` ships, you can dispatch parallel work via the existing relay-mcp tooling:

```bash
# Drop the current Relay session, fall back to relay-mcp's CLI:
cd /path/to/relay-mcp
relay-mcp parallel --tasks-file tasks.json --workdir . --isolation worktree --json
```

The relay-mcp parent project still has the full delegate_parallel surface. Relay v0.2 will port it slim.

## Failure modes (proven)

- **Context saturation** (8+ lanes with full AGENTS.md injection): all tasks return token_estimate: 0, timeout at 180s. **Fix:** use `context_mode: minimal` OR raise timeout to 360s.
- **Worktree merge-back conflict** on auto-generated files (STATE.md, AGENTS.md, AGENTS-COMPACT.md modified by post-commit hooks). **Fix:** for doc-only edits, use `isolation: none` with `max_concurrency: 1` (serial, slower but no conflict). For source files where you need true parallel, use `isolation: worktree` and accept occasional retries.

## Future (v0.2+)

- `relay parallel <task-spec.json> --workdir . --isolation worktree`
- `relay run --parallel N "<task>" --provider lmstudio` (fan one task to N workers, return best)
- `relay diverge <run_id>` (run divergence analysis across parallel results)
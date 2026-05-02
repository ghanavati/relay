# Relay CLI cheatsheet

## Memory
| Command | Purpose |
|---|---|
| `relay memory remember <content> [--type T] [--tag T] [--pinned]` | Save a memory entry |
| `relay memory recall [<query>] [--type T] [--token-budget N]` | Recall memories matching a query |
| `relay memory show-context <query> [--token-budget N]` | Preview the recalled_lessons context layer |
| `relay memory get <memory_id>` | Inspect one memory entry |
| `relay memory hook --install` | Install Claude Code SessionStart hook |
| `relay memory hook --uninstall` | Remove Claude Code SessionStart hook |
| `relay memory to-rules <memory_id>` | Promote a memory to .claude/CLAUDE.md |

## Delegation
| Command | Purpose |
|---|---|
| `relay run <task> [--provider P] [--model M] [--workdir W] [--timeout-ms N]` | One-shot delegation to a worker |
| `relay parallel <spec.json> [--max-concurrency N]` | Fan out N tasks concurrently |

## Inspection
| Command | Purpose |
|---|---|
| `relay history [--limit N] [--provider P] [--status S]` | List recent runs |
| `relay diff <run_id>` | Files changed in a run |
| `relay compare <run_a> <run_b>` | Side-by-side diff of two runs |
| `relay doctor` | Probe provider + DB health |

## Setup
| Command | Purpose |
|---|---|
| `relay init` | Interactive first-run wizard |
| `relay init --auto` | Non-interactive setup, accept all defaults |
| `relay init --quick` | Bare minimum (~/.relay/, empty config) |
| `relay completion bash` | Emit bash completion script |
| `relay completion zsh` | Emit zsh completion script |
| `relay completion fish` | Emit fish completion script |

## Common flags
| Flag | Effect |
|---|---|
| `--json` | Compact JSON output for piping (NDJSON for history/parallel) |
| `--workdir <path>` | Override the working directory for the operation |
| `--provider <p>` | codex \| lmstudio \| openrouter \| anthropic |
| `--model <id>` | Provider-specific model ID |
| `--color auto\|always\|never` | Force/suppress ANSI colors |
| `--help`, `-h` | Show help |
| `--version`, `-V` | Show version |

## Examples
```bash
relay memory remember 'tag SQL injection bug' --type lesson --tag security --pinned
relay run 'fix the failing test' --provider codex --model gpt-5.4
relay history --limit 5 --status error --json | jq -c
relay doctor --json
relay completion zsh > "${fpath[1]}/_relay"
```
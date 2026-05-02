# Short flag aliases

Relay supports short-flag aliases for the most common options. Use whichever is more convenient.

## Aliases
| Short | Long | Type | Example |
|---|---|---|---|
| `-p` | `--provider` | string | `relay run -p codex 'task'` |
| `-m` | `--model` | string | `relay run -p lmstudio -m glm-4.7-flash 'task'` |
| `-w` | `--workdir` | path | `relay history -w /Users/jo/repos/api` |
| `-l` | `--limit` | number | `relay history -l 5` |
| `-j` | `--json` | bool | `relay doctor -j` |
| `-h` | `--help` | bool | `relay -h` |
| `-V` | `--version` | bool | `relay -V` |

## Reserved single-char flags
These single-char flags are reserved for the values above. Don't try to use them for other purposes:
- `-h`, `-V` (always help/version, never composeable)

## Combining
Short flags are NOT combinable POSIX-style; `-pj` is parsed as `--pj` not `--p --j`. Use them separately:
```bash
relay run -p codex -j 'task'           # correct
relay run -pj codex 'task'              # WRONG — treated as --pj
```

## Examples
```bash
relay run -p codex 'fix the failing test'
relay run -p lmstudio -m zai-org/glm-4.7-flash -j 'summarize the diff'
relay history -l 5 -p codex
relay memory recall 'auth flow' -j
```
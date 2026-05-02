# Exit codes

Relay follows the sysexits convention.

| Code | Name | Meaning |
|---|---|---|
| 0 | OK | Command succeeded |
| 1 | EX_SOFTWARE | Runtime error (worker failed, dispatch failed, DB error, etc.) |
| 2 | EX_USAGE | Invalid arguments (missing required flag, bad value, unknown command) |
| 64 | EX_USAGE | Subcommand deferred / not implemented |

## Per-command behavior
| Command | 0 | 1 | 2 |
|---|---|---|---|
| `relay run` | success status from worker | worker error/timeout | bad provider, missing task, missing model |
| `relay parallel` | all tasks success | one or more tasks error/timeout | bad spec.json, unreadable file, empty tasks |
| `relay history` | rows printed (or no-runs message) | DB read error | invalid limit/provider/status |
| `relay diff` | files printed | run not found, DB error | missing <run_id> |
| `relay compare` | side-by-side printed | runs not found, DB error | missing <run_a> or <run_b> |
| `relay doctor` | all probes ok | one or more probes failed | n/a (no positional args) |
| `relay init` | config written | config write failed, no providers | n/a |
| `relay completion` | script emitted | n/a | unknown shell |
| `relay memory remember` | stored | DB write error | empty content, bad type |
| `relay memory recall` | results printed | DB read error | n/a |
| `relay memory get` | entry printed | not found | missing <memory_id> |
| `relay memory hook` | hook updated | settings write error | neither --install nor --uninstall |
| `relay memory to-rules` | rule appended | not found, write error | missing <memory_id> |

## Examples
```bash
relay run 'task' && echo OK || echo failed   # exit 0 = success
relay run --provider bogus 'task'              # exit 2 = invalid args
relay budget set 10                            # exit 64 = deferred
```
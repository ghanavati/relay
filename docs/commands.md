# Commands

## relay memory

### relay memory remember <content>
Flags: `--type <fact|decision|lesson|context|state|handoff>` (default fact), `--tag <tag>` (repeatable), `--pinned`, `--workdir <path>`, `--expires-in <hours>`, `--json`.
Example: `relay memory remember 'Berry uses gpt-4.1-nano' --type lesson --tag verification`.

### relay memory recall [<query>]
Flags: `--tag <tag>` (repeatable), `--type <type>` (repeatable), `--token-budget <N>` (default 4000), `--workdir <path>`, `--include-expired`, `--created-after <unix-ms>`, `--created-before <unix-ms>`, `--file <path>`, `--json`.
Example: `relay memory recall 'authentication' --type lesson --token-budget 2000`.

### relay memory show-context <query>
Flags: `--type <type>` (repeatable, default lesson + decision), `--token-budget <N>` (default 800), `--workdir <path>`, `--json`.
Previews what the recalled_lessons context layer would inject for a query.

### relay memory lint
Detects duplicates, stale entries, contradictions. Flags: `--workdir <path>`, `--json`.

### relay memory gc
Flags: `--max-age-days <N>` (default 30), `--json`. Soft-deletes stale pinned entries + purges superseded.

### relay memory status
Flags: `--workdir <path>`, `--json`. Token budget + entry stats.

### relay memory promote <memory_id>
Moves a workdir-scoped entry to global scope.

### relay memory consolidate
Flags: `--workdir <path>`, `--dry-run`, `--min-shared-tags <N>` (default 2), `--json`. Merges memories with shared tag clusters.

### relay memory hook --install | --uninstall
Installs or removes a SessionStart hook in `.claude/settings.json` that injects recalled lessons into every CC session.

### relay memory to-rules <memory_id>
Flags: `--rules-file <path>` (default .claude/CLAUDE.md). Promotes a memory entry to a static rules file.

## relay corpus

### relay corpus build
Builds the corpus from source files.

### relay corpus query <text>
Searches the corpus for matching text.

### relay corpus list
Lists all corpus entries.

### relay corpus remove <name>
Removes a corpus entry by name.

## relay compare <run_id> <run_id>
Diff two delegate runs.

## Migration script

`node dist/scripts/migrate-cc-memory.js [--inventory|--dry-run|--apply|--archive]` — see docs/memory.md.
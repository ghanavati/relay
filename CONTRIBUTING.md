# Contributing

Relay is currently maintained by a single author. Outside contributions are welcome but please follow the conventions below.

## Repo layout

```
src/
├── cli.ts                   # entry point
├── cli/                     # subcommands (cmd-*.ts)
├── memory/                  # MemoryStore + recall + lint
├── workers/                 # codex / lmstudio / openrouter runners
├── runtime/store/           # SQLite + run/budget/capability stores
├── context/                 # context layer providers
├── contracts/               # Zod schemas + TS types
├── config/                  # provider + runtime config
├── security/                # secret redaction
└── scripts/                 # one-off scripts (migrate-cc-memory.ts)

docs/                       # user-facing documentation
AGENTS.md                   # rules for AI agents working on this codebase
```

## Build + test

```bash
npm install
npm run build               # tsc + chmod
npm test                    # node --test dist/**/*.test.js
npm run typecheck           # fast, no dist output
```

## Code rules (non-negotiable)

- Immutability: never mutate objects. Return new copies via spread.
- No silent error swallowing: every catch must log or rethrow with context.
- Validate at boundaries: external input (CLI args, env, API responses) validated with Zod.
- Async I/O: `fs/promises`, never `readFileSync` in hot paths.
- Functions <50 lines, files <800 lines.
- No hardcoded model names — env vars only.
- `RelayError` from `src/errors.ts` for user-facing failures; never plain `Error`.

## Critical patterns (gotchas from upstream)

- better-sqlite3 is **synchronous** — NEVER `await` db operations.
- node:test only — no `mock.fn()`, `mockResolvedValueOnce()`, `mockReturnValue()` (those don't exist).
- In-memory test DB: `process.env['RELAY_DB_PATH'] = ':memory:'` MUST be the first line of any test file before db imports.
- TypeScript `.optional().default(x)` makes the field REQUIRED in the inferred output type — prefer `.optional()` + code-side default unless the field must always have a value.

## Commit format

```
<type>(<scope>): <description>
```

Types: feat, fix, refactor, docs, test, chore, perf. Scopes are file-area (cli, memory, workers, etc.). Keep subject under 72 chars. Body explains the why.

Commit per discrete task. Don't batch unrelated changes.

## Pull requests

1. Branch from `main`.
2. Run `npm run build` and `npm test` locally before opening the PR.
3. Update CHANGELOG.md `[Unreleased]` section with your change.
4. PR title = first commit subject.

## What to work on

Priorities (open issues if you want to tackle one):

1. `relay run` implementation — single-task delegation to codex / lmstudio / openrouter
2. Test suite cleanup — several inherited test files have broken imports from dropped modules
3. `relay init` interactive wizard
4. `relay doctor` provider health probe
5. npm publish workflow

## Reporting bugs

Open an issue at https://github.com/ghanavati/relay/issues with:
- Node version (`node --version`)
- Relay version (`relay --version`)
- The exact command + observed vs expected output
- Stack trace if any

## License

By contributing, you agree your contributions will be licensed under AGPL-3.0-or-later.
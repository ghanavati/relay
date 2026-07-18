# Relay productization — Step 1 gap table (2026-07-18)

Verified on worktree `productize` (branch off phase-9-v04, c5a6262). Typecheck clean, 1984/1984 tests green.
Live verifications: real tarball packed + installed globally into clean prefix + scrubbed HOME + scrubbed env →
`relay memory remember` → `relay memory recall` roundtrip WORKS zero-config. libsql compat suite: 17/23, all
FTS5/WAL/transaction checks pass. Distribution = git clone + build or release tarball (registry parked per user).

| # | Gap | Blocks install? | Fix |
|---|-----|----------------|-----|
| 1 | Tarball ships 137 compiled test files + fixture .db — package.json `files` allowlist overrides .npmignore (verified in real pack listing) | No (bloat) | S — `files` negation globs |
| 2 | `ink` + `react` are runtime deps with ZERO imports anywhere in src (grep) | No (dead weight) | S — remove both |
| 3 | `relay init` tells every user to run migrate-cc-memory.js (cmd-init.ts:390) whose defaults are hardcoded /Users/ghanavati paths (migrate-cc-memory.ts:31-32) | YES — broken step in init output | S — gate or remove |
| 4 | Fatal errors print raw stack traces w/ internal paths (cli.ts:996-999); demonstrated live on gated first save | YES — first-error UX | S — friendly msg, stack behind debug flag |
| 5 | NO MCP config writer for any client (Claude Code/.mcp.json, Desktop, Cursor, Codex TOML all manual copy-paste); hook installer (cmd-memory-ops.ts:271-369) is the proven idempotent template | YES — core of "init wires everything" | M — 4 writers, 3 share JSON shape |
| 6 | Codex asymmetry: probes `[mcp_servers.relay]` in config.toml (codex.ts:57,92-104) but never writes it | YES (Codex) | S |
| 7 | GUI clients (Claude Desktop) need absolute binary path; no print-config helper, no doctor check for MCP registration | YES (Desktop) | S |
| 8 | better-sqlite3 prebuild worked here; other platform/ABI combos unverified. libsql swap removes risk class (N-API, 9 platform prebuilds incl musl/arm) | Some machines | folded into #9 |
| 9 | BYO-DB: seam ALREADY EXISTS — single `getDb()` factory (db.ts:146-164), all stores consume it, one DB file `~/.relay/relay.db`. libsql is API-compatible for everything repo uses EXCEPT `db.backup()` (backup-v1.ts:90 → VACUUM INTO) + verify `{readonly, fileMustExist}` ctor opts. No user_version pragma use (schema_version table instead) | — | M — dep swap + backup + remote URL mode + RELAY_DB_URL/RELAY_DB_AUTH_TOKEN precedence + roundtrip tests |
| 10 | Remote/embedded-replica mode dials network at constructor (verified); needs real endpoint (local sqld or Turso) to prove in Step 2 | — | Step 2 verify |
| 11 | docs: install.md + database.md MISSING; commands.md stale (≥1 confirmed false claim: "relay mcp has no flags", :187); quickstart.md never mentions MCP; mcp.md verified current; remaining ~13 docs NOT line-audited (agents died on spend limit — folded into Step 2 E, flagged honestly) | install.md: by definition | M |
| 12 | CLI verb is `remember`, MCP tool is `relay_memory_save`, brief says `save` — naming drift across surfaces | No (confusing) | S (docs or alias) |
| 13 | Distribution channel: git repo URL (github.com/ghanavati/relay) publicness unverified; no release workflow for tarballs (.github/workflows has test.yml only, contents unread) | YES — no channel = no strangers | user decision + S |

Non-gaps (verified working): init/setup/doctor all exist (cli.ts:807/852/776); DB zero-config auto-create chmod 600;
workdir gate OFF by default for fresh users (memory-store.ts:69-71 — only fires when env set; my earlier scare was
my own shell's exported var); prepare-script build on clone install; shebang + exec bit; stdout-clean MCP server;
scope: BYO-DB doesn't collide with kill list (hosted-Relay ≠ hosted-DB), needs scope addendum commit in Step 2.

Salvaged agent report: step1-C-mcp.md (full MCP wiring audit). Other 5 agents died on monthly spend limit; their
scopes re-done inline (A/B/D/E fully, F partially — see row 11).

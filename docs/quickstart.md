# Quickstart

## 1. Install

```bash
npm install -g github:ghanavati/relay
```

Requires Node >=20 and `better-sqlite3` (native module).

## 2. First-run setup

```bash
# Create config directory
mkdir -p ~/.relay

# Set provider env vars
export OPENROUTER_API_KEY="sk-or-v1-..."
export LMSTUDIO_ENDPOINT="http://localhost:1234"
export RELAY_DB_PATH="$HOME/.relay/relay.db"
```

## 3. Migrate Claude Code memory (if you have it)

```bash
# Scan inventory (read-only)
node dist/scripts/migrate-cc-memory.js --inventory

# Dry-run to preview
node dist/scripts/migrate-cc-memory.js --dry-run

# Apply migration
node dist/scripts/migrate-cc-memory.js --apply
```

Phases:
- Scan ChatHistory for user patterns
- Extract memory candidates
- Deduplicate
- Store in SQLite
- Verify migration success

## 4. Memory recall

```bash
# Remember something
relay memory remember 'Berry verifier uses gpt-4.1-nano direct OpenAI'

# Retrieve
relay memory recall 'berry'
```

## 5. Hook into Claude Code sessions

```bash
relay memory hook --install
```

Writes to `.claude/settings.json` `SessionStart` array.

## 6. Where to next

- `relay memory --help`
- docs/commands.md
- docs/configuration.md
- docs/providers.md
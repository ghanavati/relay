# Your database

Relay stores everything — memories, run history, telemetry — in one SQLite database you own. By default it's a local file; set one connection string and the same database lives in the cloud instead. Same schema, same commands, nothing else changes.

## Local (the default)

Zero configuration. On first use Relay creates `~/.relay/relay.db` (file mode 600). Move it with:

```bash
export RELAY_DB_PATH=/somewhere/else/relay.db
```

Back it up like any file — copy it while nothing is writing, or take a consistent snapshot from a live database:

```bash
sqlite3 ~/.relay/relay.db "VACUUM INTO '/backups/relay-$(date +%F).db'"
```

Restore = put the file back.

## Hosted (one connection string)

Point Relay at any libsql server — [Turso](https://turso.tech) or your own `sqld`:

```bash
export RELAY_DB_URL="libsql://your-db-yourname.turso.io"
export RELAY_DB_AUTH_TOKEN="..."        # if your server requires auth
```

That's the whole switch. Every machine and every tool configured with the same URL now shares one memory.

Accepted schemes: `libsql://`, `https://`, `http://`. Anything else is rejected with a clear error. Both variables are treated as secrets — validated at the boundary, never logged, never echoed back in error messages. You can also set `db_url` in `~/.relay/config.json`; the environment variable wins if both are set.

**Turso in three commands:**

```bash
turso db create relay-memory
turso db show relay-memory --url          # → RELAY_DB_URL
turso db tokens create relay-memory       # → RELAY_DB_AUTH_TOKEN
```

## How hosted mode works

Relay keeps an embedded replica — a local SQLite file per remote, at `~/.relay/replica-<hash>.db` — synced against your server. Reads are local-fast. Writes go to the server and are pushed when a command finishes and after every MCP save, so a memory saved on one machine is there when the next machine asks.

## What happens offline

Reads keep working from the local replica; you'll see a one-line warning. Saving is paused with a clear message until the server is reachable again. That's deliberate: a write made while detached from the server would be silently discarded on reconnect, and a save that pretends to succeed but evaporates is worse than one that asks you to retry.

## Moving an existing local database to hosted

Your local file imports directly:

```bash
turso db create relay-memory
sqlite3 ~/.relay/relay.db .dump | turso db shell relay-memory
export RELAY_DB_URL="libsql://relay-memory-yourname.turso.io"
export RELAY_DB_AUTH_TOKEN="..."
```

Verify with `relay memory recall --query "anything you remember"`, then archive the old local file.

## Moving back to local

The replica is a plain SQLite file. Copy it over the local default and drop the URL:

```bash
cp ~/.relay/replica-*.db ~/.relay/relay.db
unset RELAY_DB_URL RELAY_DB_AUTH_TOKEN
```

Nothing is lost in either direction — it's the same schema everywhere.

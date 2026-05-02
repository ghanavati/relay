# Relay

Solo CLI for delegating bounded coding tasks to AI workers (Codex, OpenRouter, LM Studio, Anthropic) with audit trail, memory, and parallel dispatch.

## Install

```bash
npm install -g github:ghanavati/relay
```

## Quickstart

```bash
relay init           # interactive setup: providers, hooks, memory migration
relay run "<task>"   # delegate to default provider
relay history        # browse past runs
relay --help
```

See [docs/quickstart.md](docs/quickstart.md) for the full walkthrough.

## What it does

- **Delegate**: dispatch coding tasks to Codex CLI, OpenRouter, LM Studio (local), or Anthropic. One worker or many in parallel.
- **Audit trail**: every run captures filesystem diff, event timeline, and worker output to a local SQLite store.
- **Memory**: persistent recall across CC sessions via context-layer injection.
- **Cost control**: per-provider budget caps with alerts.
- **Hallucination check**: optional Berry MCP integration to validate claims.

Model-agnostic. Single SQLite store. No external services required for solo use.

## Documentation

- [Quickstart](docs/quickstart.md)
- [Commands](docs/commands.md)
- [Configuration](docs/configuration.md)
- [Providers](docs/providers.md)
- [Memory](docs/memory.md)
- [Parallel dispatch](docs/parallel.md)
- [Troubleshooting](docs/troubleshooting.md)

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).

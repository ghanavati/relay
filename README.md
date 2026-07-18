# Relay

**The operations and control layer around AI coding agents.**

Relay makes agent work persistent, addressable, inspectable, and steerable
across the tools you already use. It is not another frontier model: it is the
memory, delegation, and audit layer around them.

## Status

Relay is pre-release software. It is available for development and evaluation,
but there is currently **no supported public installation or upgrade path** and
no package published to a public registry. Do not treat a source checkout as a
stable end-user install.

## What Relay does

- **Persistent memory** — record decisions, lessons, facts, and working
  context; recall them across sessions and tools with trust-aware filtering.
- **Context delivery** — inject or expose relevant memory through Claude Code
  hooks, `relay context emit`, and an MCP memory server.
- **Delegation and control** — run one task or bounded parallel work across
  supported coding-agent providers; keep a durable run history and a truthful
  control surface for sessions Relay owns.
- **Command Central** — `relay tui` is Relay's terminal operator console.
  Live stdin control is available only for Relay-owned processes launched with
  `relay session spawn`; other adapters expose only the capabilities they
  actually support.
- **Local-model harnessing** — use LM Studio or oMLX as bounded workers for
  focused tasks. Relay supports model-specific inference profiles and agentic
  tool loops; it does not pretend a small local model is a replacement for a
  frontier lead agent.
- **Audit and provenance** — retain task inputs, provider/model identity,
  status, duration, tool-loop results, and memory read/write history.

Relay is model-agnostic. The lead model (Codex, Claude Code, or another agent)
remains responsible for task decomposition and final judgment; local models
are most useful as scoped, parallel helpers.

## What Relay is not

- Not a hosted team platform, billing system, or compliance product.
- Not a model registry or a replacement for the coding agent you choose.
- Not an unattended autonomous coding system. Parallel agents need isolated
  workdirs, bounded tasks, and review of their outcomes.
- Not a public package yet.

## Data and privacy

Relay keeps its canonical data locally by default. The store is a
SQLite-compatible database under `~/.relay/`; optional libSQL remote replica
support is documented separately. MCP memory writes are quarantined at an
unverified trust level, and the pause sentinel blocks MCP recall as well as
hook-driven context delivery.

Read the [security policy](SECURITY.md) before enabling agentic shell tools or
exposing an MCP endpoint beyond your machine.

## Documentation

- [Distribution status](docs/install.md)
- [Memory model](docs/memory.md)
- [MCP memory server](docs/mcp.md)
- [Database and optional remote replica](docs/database.md)
- [Configuration](docs/configuration.md)
- [Provider reference](docs/providers.md)
- [Command reference](docs/commands.md)
- [Parallel worker guidance](docs/parallel.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

## For contributors and evaluators

The repository includes the development workflow and test suite, but that is
not a public product-installation guide. See [CONTRIBUTING.md](CONTRIBUTING.md)
for the supported contributor setup and [AGENTS.md](AGENTS.md) for the project
engineering contract.

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).

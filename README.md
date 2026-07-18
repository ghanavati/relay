# Relay

**Make every AI coding session compound.**

Relay turns scattered AI coding sessions into a connected operating layer:
shared memory, deliberate delegation, and visible outcomes across the agents
you already use. It is the layer behind your lead model,not another model to
choose between.

## Status

Relay is released through GitHub, not npm. Download the archive for your
platform from [Relay v0.4.0-beta.1](https://github.com/ghanavati/relay/releases/tag/v0.4.0-beta.1),
verify its checksum, and run `relay setup --everything`.

Each archive includes Relay, its production dependencies, and the Node runtime
it needs. You do not need npm or a separate Node install to use Relay.

## What Relay does

- **Remember what matters:** carry durable decisions, lessons, facts, and
  project context across sessions and tools with trust-aware recall.
- **Start with the right context:** deliver useful memory through Claude Code
  hooks, `relay context emit`, and an MCP memory server.
- **Put the right model on the right job:** delegate bounded work across
  supported providers and see the outcome in one durable run history.
- **Command Central:** `relay tui` is the terminal operator console for
  active work. Live stdin control is available only for Relay-owned processes
  launched with `relay session spawn`; every other adapter shows exactly what
  it can do.
- **Make local models useful:** use LM Studio or oMLX as focused workers with
  model-specific inference profiles and agentic tool loops, while your
  frontier lead model keeps the architectural judgment.
- **See the work, not just the code:** retain task inputs, provider/model
  identity, status, duration, tool-loop results, and memory read/write history.

Relay is model-agnostic. The lead model (Codex, Claude Code, or another agent)
remains responsible for task decomposition and final judgment; local models
are most useful as scoped, parallel helpers.

## Built for focused, accountable work

- Relay is not a hosted team platform, billing system, or compliance product.
- It is not a model registry or a replacement for the coding agent you choose.
- Parallel work stays bounded: use isolated workdirs, focused tasks, and a
  lead-agent review of outcomes.

## Data and privacy

Your work stays yours. Relay keeps its canonical data locally by default in a
SQLite-compatible store under `~/.relay/`; optional libSQL remote replica
support is documented separately. MCP memory writes begin quarantined at an
unverified trust level, and the pause sentinel stops MCP recall as well as
hook-driven context delivery.

Read the [security policy](SECURITY.md) before enabling agentic shell tools or
exposing an MCP endpoint beyond your machine.

## Documentation

- [Installing from GitHub Releases](docs/install.md)
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

The repository includes the development workflow and test suite. See
[CONTRIBUTING.md](CONTRIBUTING.md) for contributor setup and
[AGENTS.md](AGENTS.md) for the project engineering contract.

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).

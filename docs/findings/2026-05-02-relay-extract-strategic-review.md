# Relay Extract — Strategic Review
**Verdict:** PROCEED WITH FIXES

## Top 3 strategic risks
1. Scope drift risk: extract still keeps broad monorepo surface (`server.ts`, `mcp/`, large `tools/`, `workers/`), which raises maintenance burden for a solo CLI and weakens product focus.
2. Adoption friction: install path (`npm install -g github:user/repo`) plus AGPL can reduce trust and trial velocity for solo users versus a signed npm release with clear upgrade channel.
3. Positioning risk: “delegate to many providers + audit + memory + parallel dispatch” is powerful but crowded; without a sharper “why Relay over direct Codex/OpenRouter CLI,” users may default to simpler tools.

## Anything missing from the extract that solo user hits day 1?
- A first-run `relay doctor` (provider auth, DB path, filesystem/root permissions, model env checks) to prevent setup churn.
- A stable release/update path (versioned npm package + changelog + rollback guidance).

## Anything overspecified for solo (still in extract but pointless)?
- Retained MCP/server-facing scaffolding and broad contracts/tooling surface beyond core `relay run/history/memory` workflows.

## One sentence verdict
Proceed, but aggressively trim to a “single-user core” and harden install/onboarding before expanding features.

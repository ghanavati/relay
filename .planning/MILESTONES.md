# Milestones

## v0.1.2 — 2026-05-11 (current)

Codex wave-4 audit fixes: 3 privacy P1s + 5 quality P2s. No new features. 972/972 tests passing.

**Shipped:**
- Pause sentinel gate on installed hooks (privacy P1)
- `.relayignore` honored before extraction (privacy P1)
- Workdir allowlist enforced in export (privacy P1)
- `trust_level` column kept in sync on recall + upsert
- Doctor detects new `context emit` hook pattern
- Verify smoke writes pass workdir correctly
- Hook uninstall idempotent on missing settings.json
- Doctor splits allowlist on `:` not `,`

## v0.1.1 — 2026-05-10

Wave 4a patch: hardened auto-extract + memory + context-emit. Added `relay verify`, `relay memory rollback`, `relay memory consolidate`. CI lit up via GitHub Actions.

## v0.1.0 — 2026-05-02

Initial release: memory store, workers (codex/lmstudio/openrouter/anthropic), `relay run`, `relay parallel`, basic doctor + info.

---

Last updated: 2026-05-18

# Relay v0.2 — Release Notes (Draft)

> **STATUS:** DRAFT. Held for publication until v0.2 ships and `/gsd-complete-milestone` runs.

## What's new

Relay v0.2 turns the local LM Studio runner into a real agent. Models you run on your own machine can now drive multi-step tasks — calling tools, reading their output, and deciding the next step — instead of producing one-shot text. The same loop powers a new pair of Figma tools, so a local model can read your design files and update tokens without going through a hosted API. Loop detection, an iteration cap, and a sandboxed shell tool that's clamped to the task's workdir keep agentic runs predictable and safe.

The memory layer got smarter too. Recall now uses semantic similarity from the shipped embedding client, so memories surface by meaning rather than just shared words — ask about "naming conventions for stylesheets" and Relay finds the lesson you wrote about kebab-case CSS, even if the wording is completely different. When two memories contradict each other, Relay notices at write time and annotates both sides at recall time so the model sees the conflict explicitly instead of silently picking one. Auto-extract has stopped re-learning the same lessons — it now reads what you already know about a workdir before processing a new transcript, and only surfaces what's new, refined, or in conflict.

Under the hood, the SQLite schema is on a versioned migration path for the first time. The first time you launch v0.2 against an existing database, Relay writes a `.v1-backup` next to your store, applies the v2 migration, and drops eleven legacy tables that no command had been reading or writing since the relay-mcp extraction. Your memories, runs, and budget rows are unaffected. `relay doctor` now reports the schema version so you can confirm a clean upgrade at a glance. Existing workflows — `relay run`, `relay parallel`, the SessionStart and SessionEnd hooks, the privacy off-switch — all keep working with no changes.

## Upgrade

```bash
npm install -g @ghanavati/relay@0.2.0
relay doctor          # confirm schema_version=ok
```

The migration is automatic on first launch. To skip the backup (CI / disposable fixtures only), set `RELAY_SKIP_V2_BACKUP=1`. The new agentic runner is opt-in: pass `--provider lmstudio-agentic` to `relay run` or any task in a `relay parallel` spec. The existing text-only `--provider lmstudio` path is unchanged.

Figma tools activate automatically when `FIGMA_API_TOKEN` is set in your environment. Without it, no Figma tool is registered — no error, no surprises.

See `CHANGELOG.md` for the full per-phase change list.

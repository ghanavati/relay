# Recipe: QMD as a search companion to Relay

[QMD](https://github.com/tobi/qmd) is an on-device search engine for markdown corpora — BM25 + vector + LLM rerank, all running locally via node-llama-cpp + GGUF models. It's complementary to Relay, not redundant.

## When to use which

| Use case | Tool |
|---|---|
| Save / recall a structured lesson, decision, fact (small, single-purpose) | `relay memory remember/recall` |
| Search across notebooks, meeting transcripts, design docs (large, free-form prose) | `qmd query` |
| Find similar past runs by output content | `qmd query` over indexed `relay history` exports |
| Re-rank semantic candidates by relevance to current task | `qmd query` (uses local LLM reranker) |

Relay's MemoryStore is FTS5-only and tops out at ~100K chars per entry. QMD handles arbitrary markdown documents and has true semantic search.

## Install QMD

```bash
npm install -g @tobilu/qmd
# or
bun install -g @tobilu/qmd
```

## Recommended setup for a Relay user

```bash
# 1. Index Relay's docs/findings (decisions + retrospectives)
qmd collection add ~/code/relay/docs/findings --name relay-findings
qmd context add qmd://relay-findings 'Decisions, learnings, retrospectives from Relay sessions'

# 2. Index your Claude Code memory dir (if you haven't migrated to Relay yet)
qmd collection add ~/.claude/projects/-Users-you-code-myproject/memory --name cc-memory
qmd context add qmd://cc-memory 'Hand-curated lessons and project context from CC sessions'

# 3. Index any project notebooks / personal notes
qmd collection add ~/notes --name notes
qmd context add qmd://notes 'Personal notes and ideas'

# 4. Generate embeddings (one-time, ~5 min for ~500 docs)
qmd embed
```

## Daily workflow

```bash
# Recall a structured lesson
relay memory recall "berry hallucination check"

# Search across all your prose
qmd query "berry hallucination check"          # hybrid + reranked

# Find a specific document
qmd get "findings/2026-04-03-berry-failure.md"

# Search within a single collection
qmd search "deployment" -c relay-findings
```

## Use Relay + QMD together in Claude Code

Both expose MCP servers. Add both to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "qmd": { "command": "qmd", "args": ["mcp"] },
    "relay": { "command": "relay", "args": ["mcp"] }
  }
}
```

(Relay's MCP server arrives in v0.2; for v0.1.0, relay is CLI-only.)

When CC starts a session, both tools' contexts are available:
- `qmd query` for unstructured retrieval
- `relay memory recall` for structured fact/lesson injection

## Future: tighter integration (v0.2+ candidate)

Possible future Relay commands that wrap QMD:
- `relay corpus add-qmd <path> --name <name>` — wraps `qmd collection add` and registers in Relay's `corpus` table for audit.
- `relay search "<query>"` — hybrid: query Relay's MemoryStore + invoke `qmd query` if installed; deduplicate and rank results.
- The `recalled_lessons` context layer (currently MemoryStore-only) could optionally call `qmd query` for document-level matches.

These are NOT shipped in v0.1.0. The current recommendation: install both, use them side-by-side via separate commands. See how the workflow shakes out before designing tighter integration.

## Why not just merge QMD into Relay?

- QMD ships GGUF models (50-500 MB). Bundling would balloon Relay's install size.
- QMD's surface (BM25 + vector + rerank, embeddings, model lifecycle) is its own product.
- Relay stays focused: delegation + audit trail + structured memory. Search is delegated to QMD.

This is the same Unix philosophy the rest of Relay follows: each tool does one thing, and the workflow composes them.

---
name: relay-memory
description: Use Relay's persistent cross-tool memory whenever the user asks about past decisions, agreements, lessons, prior work, or project history ("what did we decide/agree", "why did we", "last time", "remind me"), and save new durable decisions or lessons the user states. Relay memory is shared with Claude Code, Cursor, and the terminal — it contains context this conversation does not have.
---

# Relay memory

Relay is the user's local, cross-tool memory store. Claude Code, Cursor, the terminal, and this app all read and write the same store. Chat history only covers THIS app; Relay covers all of them. When a question concerns past work, Relay is the source of truth.

## When to recall (do this BEFORE answering from chat history)

Call `relay_memory_recall` first when the user asks anything like:
- "What did we decide / agree on ...?"
- "Why did we choose ...?" / "What was the reasoning for ...?"
- "What did I do in Claude Code / Cursor about ...?"
- "What are the rules / constraints / scope for <project>?"
- "Remind me ..." / "last time ..." / "have we tried ...?"

How to call:
- `query`: the topic in a few keywords (e.g. "anti-bloat scope agreement").
- `token_budget`: 800 is a good default; 400 for a quick check.
- `workdir`: the project's absolute path. If the user named a project, use its path; otherwise omit it — the server falls back to its configured default project.

Treat results marked unverified with mild caution; pinned and trusted entries are reliable. If recall returns nothing relevant, say so and answer from other sources — do not pretend memory confirmed something it didn't.

## When to save

Offer `relay_memory_save` (or save directly when the user asks) for things future sessions and OTHER tools should know:
- decisions ("we're going with X because Y") → `memory_type: "decision"`
- lessons learned ("X broke because Y — do Z instead") → `"lesson"`
- durable facts about the project → `"fact"`

Keep entries short and self-contained (one decision per save). Include the why. Never save secrets, API keys, tokens, or credentials. Do not save full transcripts — distill.

## What Relay is NOT

- Not a transcript archive: it stores distilled knowledge, not conversation recordings.
- Not this app's chat-history search: that only sees this app. Relay sees every tool.

# Relay agent direction

Captured 2026-06-28. Strategic frame for "Relay as an agent." Governance + ranked
options. Options are parked — see build-triggers and `BACKLOG.md` B-09. Nothing here
is an active phase.

## Thesis

Relay is an agent that makes the models smarter — it does not get smart itself. The
smarts stay in the models. The model drives; Relay is the body, memory, and nervous
system around it. Relay carries; the model decides.

This is not modesty. Context quality is the largest single lever on model output, so a
model with owned, verified, continuous memory beats the same model bare. Relay raises
the floor under every model that mounts it, by the amount good context helps — which is
a lot, and bounded, and honest.

## The invariant (scope-creep firewall)

**Relay is mechanism, not policy. The model is policy.**

Test every proposed feature: *does this require Relay to make a judgment a model should
make?* Yes → reject.

- Store a memory ✓ · rank a memory by score ✓ · decide a memory is relevant by reasoning ✗
- Dispatch to a provider ✓ · pick a provider by config rule ✓ · pick by inference ✗
- Record a verdict ✓ · produce a verdict ✗ (the model / Berry / the user produces it)

**Grep-able enforcement: Relay's own logic makes zero LLM calls to decide things.**
Relay may dispatch *to* models — that is the job. The day a prompt exists that Relay
uses to *make a choice*, it has grown a brain. That is the creep, every time.

Auto-extract passes this test: Relay ships the transcript to a model and stores what
comes back. The model reasons; Relay carries. Use it as the reference for the line.

This invariant is stronger than the kill-list because it is a structural property you
can check, not a judgment call. The predecessor (`LESSONS-FROM-RELAY-MCP.md`) died of
policy creep — features where the tool started deciding. Hold the line here.

## The world-class wedge

Cloud memory products are black boxes you do not own and cannot debug. Relay's position
is the opposite: memory and context that is transparent, owned, deterministic,
model-steered, and local. Every option below pulls one of those five.

## Options (ranked, all mechanism-not-policy)

Each carries an anti-creep status and a build-trigger. Creep-risk items are only safe in
their "dumb version" — the inference version is rejected.

### Top tier

1. **Git-native portable memory.** `relay memory export/import` to plain markdown/jsonl
   the user owns, diffs, edits, git-commits. Wins: trust (readable/correctable),
   ownership (your files, not a vendor DB), cross-machine sync for free (git remote you
   control — local-first, no SaaS). Pure serialization. *Trigger: second machine, or
   first "what does it actually remember" audit need.*

2. **Deterministic, debuggable context — `relay context explain`.** Show exactly what
   would be injected for a query, each piece's score, and what the budget dropped. Makes
   "deterministic context engineering" inspectable. Pure read. *Trigger: first "why did
   it surface that" confusion, or first recall that returned noise.*

3. **Model-facing curation tools (the "model drives" vision, literally).** MCP tools the
   model calls to steer its own memory mid-session: pin, forget, correct, scope. The
   model curates; Relay executes. Anti-creep form of intent — Relay never infers intent,
   the model declares it via a lever. *Trigger: first session where recall carried a
   wrong/stale memory the model should have been able to drop.*

4. **Be THE memory MCP — polish + open format.** Not more features: make the two MCP
   tools so good any host gets great memory by mounting Relay, and publish the memory
   format so others can read it. *Trigger: a second host (Cursor/Desktop) mounting it,
   or anyone asking for the format.*

### Second tier (amplifiers)

5. **Reproducible context snapshots / replay.** Record the exact context injected per
   session start; `relay context replay <session>` to see what the model had. Debug
   "why did it do that" by replaying real inputs. Record-and-replay, no decisions.
   *Trigger: first time you cannot reconstruct why a session went wrong.*

6. **Dispatch receipts with an outcome slot.** Every dispatch emits a structured receipt
   (tokens, result-ref) with an empty outcome field the model or user fills. Relay
   records the verdict, never produces it. Gives `relay why <output>` provenance.
   *Trigger: first need to know whether dispatched work actually landed.*

### Spine points (from the earlier read — kept for completeness, anti-creep forms only)

- **Intent object** — model-declared only (a tool the model calls), never Relay-inferred.
  Subsumed by option 3.
- **Feedback loop** — Relay records verdicts others produce, never judges. Subsumed by
  option 6.
- **Verification-native** — refusal-without-provenance + staleness flags. Pure
  bookkeeping; the safest of all. *Trigger: first stale-memory mislead (already fired —
  see the 2026-06-22 stale-cache incident).*
- **Capability router** — declarative capability-match rules ONLY. "Intelligent routing"
  is policy and is rejected. Highest creep risk of the set. *Trigger: enough providers
  that manual selection hurts.*
- **Proactive recall** — rule-triggered, score-ranked push (e.g. on file-open). The
  ranking is mechanical, never a relevance judgment. Needs the daemon (the one genuinely
  new architectural piece; needs explicit gate blessing). *Trigger: hooks proven
  insufficient for a host that matters.*

## Priority

The three that nobody else does and that are pure mechanism: **1 (own your memory),
2 (debug your context), 3 (model steers its memory).** Build those as the proof, hold
everything to mechanism-not-policy, then 4 is the distribution move. 5–6 follow once the
core is sharp. The architecture moves the outcome, not the feature count.

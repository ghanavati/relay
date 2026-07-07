# Learnings from inkField (external repo — code closed, techniques open)

**Compiled:** 2026-07-07 from a 3-agent full read of a shallow clone of `github.com/ileivoivm/inkField` (Aluan Wang; WebGL/p5.js ink-painting app). Every claim traces to a file the agents read; `script.js`/`shader.js` are obfuscated but class/method names survive, and the `tech/` explainer docs are plain prose. Paths below are repo-relative to that clone.

## Can we use the code? No.

The repo ships a custom **Open Creative License** (`LICENSE`, not SPDX). §1 keeps the source *closed* until the author stops maintaining, and explicitly reserves *"integrating the rendering engine into another application"* and *"building a derivative codebase."* The JS is also obfuscated (mangled `_j1`/`_x0` identifiers). So this is a **technique study, not a code source.** Reusable third-party libs it vendors (p5.js LGPL, p5.easycam LGPL, spectral.js MIT, p5.brush MIT) come from their own upstreams, not from here.

This is external-repo material per `feedback_relay_anti_bloat_gate` — everything below is **reference / backlog candidate only**, never active-phase Relay work until a trigger fires.

---

## Part A — Getting a weak model to emit reliable structured output (FLEET candidates, UNTESTED)

These extend the FLEET dispatch doctrine (`~/ai-stack/Projects/model-hardtest/FLEET-DOCTRINE.md`). inkField is a real, shipped case of forcing an LLM to produce a strict, large, bookkeeping-heavy artifact. **Not yet measured on our fleet — treat as hypotheses to test, then promote to doctrine.**

### A1. Make the model write a *generator*, not the artifact.

inkField's core decision (`tech/en/ai-json-generation.html`, Method D / Phase 5): a finished painting is 700–1400 timestamped events / 50–80KB. The LLM never emits that JSON as tokens. It writes a ~200-line deterministic JS generator (`tech/examples/agent-generator-logic.js`) that emits the JSON in-browser. That sidesteps the exact failure classes our fleet notes flag — density, counting, cumulative drift, running-total bookkeeping (each stroke's `mouseCountStart` = cumulative event count of all prior strokes).

→ **For large or bookkeeping-heavy structured outputs, dispatch "write the generator," not "write the artifact."** Contract-spec the generator (exact function names + one worked input→output), let a deterministic runtime produce the bulk. Maps to inspo-library bulk indexing and any Relay structured-generation dispatch.

### A2. Annotate every constraint with its failure symptom.

Their spec pairs each guardrail with what breaks (`tech/en/ai-json-generation.html`, "⚠️ For LLM / AI Agent"): "<20 drag events → strokes invisible," "brushMode 0 → silent no-op, nothing drawn," "gap <500ms → previous stroke gets erased," "x/y at event top level, not inside strokeData." The symptom is what makes a rule stick for a weak model.

→ **Write fleet + Codex-handoff specs as symptom-annotated constraints** ("do X; if you do Y instead, Z breaks"). This is the spec-writing form of our existing "name where the bug lives" + "retry once with the real compiler output."

### A3. Accept a minimal core; backfill the rest server-side; return a warning.

Their 2026-04 runtime auto-fills ~35 of 41 `strokeData` fields and logs `[autofill] warning: md density too low`. The model only has to get ~4 fields right (`brushMode, brushColorMode, baseBrushSize, initialSize`); the engine defaults the rest, and the warning is the retry signal that closes the loop.

→ **Design Relay MCP tool schemas + fleet contracts with a small required core + server defaults + a returned warning.** Shrinks the surface a weak model must nail from 41 fields to 4. The warning doubles as the "retry once with real output" trigger.

### A-bonus. Instrument params vs performance timing.

`tech/en/emotion-intention.html`: identical brush params read as five different emotions purely from hand speed and pauses. Intent lives in the `(t,x,y)` spacing, not the parameter block. Transferable to any temporal agent-trace analysis (Berry spans, fleet run trajectories): the *trajectory* carries signal the endpoint doesn't.

---

## Part B — Reproducibility / record-replay

### B1. Event-sourcing with a seed chain.

inkField records timestamped *input events* + seeds, not pixels, then replays to reconstruct the artwork (`tech/en/recording.html`; recorder `script.js:11479`, replay dispatcher `script.js:12241+`). Files are tens of KB, resolution-independent, and show process. Determinism is a 3-level seed chain (`script.js`): master seed (`randomSeed`/`noiseSeed`, :2793) → per-stroke seed stored *in the event* (`strokeData.strokeSeed`, :3917) → per-point reseed `strokeSeed + i*1e8` (:3604). Every random value is a pure function of recorded data.

→ We already event-source (Relay Workflow journals each agent return to `journal.jsonl` for unchanged-prefix resume). inkField adds the missing **discipline: route ALL non-determinism through one seeded RNG so a run is a pure function of its recorded inputs.** Upgrades reproducible fleet grading and Relay session replay.

### B2. Count RNG draws as a cheap divergence check.

`Crandom` (`script.js:9-96`) wraps p5 `random()` and counts every draw (`globalCount++`). `CrandomDebugger` snapshots the count at named checkpoints; `compareStroke()` (:133) diffs record-vs-replay draw counts per stroke with tolerance icons (✅ <50, ⚠️ <200, ❌ ≥200). A different draw count = a different code path, caught **without diffing full output.**

→ **Cheap integrity check for any deterministic replay:** if a resumed workflow or a re-graded fleet run drew the RNG a different number of times, it diverged. Add to Relay replay/verify and Berry divergence detection.

### B-caveat (honest). Their reproducibility is ~99.9% *perceptual*, not bit-exact or signed.

`tech/en/recording.html` claims "indistinguishable," with a documented residual of ±~25 RNG calls out of tens of thousands. Recordings carry **no hash, signature, or checksum** — "verification" is reproduce-and-eyeball. Real on-chain determinism only enters at the fxhash platform boundary (`assets/fxhash.min.js` is a local `Math.random` stub). **Borrow the seed-chain discipline; do NOT borrow this as a provenance/authenticity pattern — it isn't one.**

---

## Part C — Local-first / packaging

### C1. Portable bundle = vendor upstream + allowlist + arc-root + sha256 + version-stamp.

`scripts/build_mint_zip.py` (stdlib `zipfile`, no bundler): the app is already offline (deps vendored in `lib/`, shaders pre-inlined into `shader.js`, no CDN). The script selects a minimal runnable subset via an `INCLUDE_FILES` allowlist, drops `gallery/`, `tech/`, `sw.js` with documented reasons, nests everything under a versioned `inkfield-mint-vX.Y.Z/` arc-root, and emits a `.zip.sha256` sidecar. Each build stamps `engineVersion = "YYYY-MM-DD HH:MM:SS | commit: <hash>"` so any output traces to its build.

→ **The recipe for code-stick / Relay agent packaging / DNA distribution:** vendor everything (no CDN), allowlist-package with documented exclusions, checksum sidecar, version-stamp the output. Dependency-free, ponytail-clean. (`reference_code_stick`.)

### C2. Split cache strategy per route — the committed PWA post-mortem.

`tools/BUG-SW-GALLERY-CACHE.md`: a cache-first service worker silently pinned stale gallery data (needed 2–3 reloads to see updates), because gallery files hit the runtime cache and were served from it forever. Fix = **network-first for dynamic paths (`/gallery/`), cache-first for the app shell**, applied consistently at three layers: SW, dev server `Cache-Control: no-store` (`scripts/dev_server.py`), and `?v=` cache-busting on asset URLs.

→ **Direct DNA-viewer note (`project_dna_viewer`):** it's contractually local-first + installable, so it *will* ship a service worker and hit this exact stale-content bug. Bank the lesson before writing the SW. Also: **commit post-mortems as durable `BUG-*.md` artifacts** and trace the fix back into code comments — matches our lessons discipline.

---

## Part D — LLM-facing docs + process

### D1. Ship an `llms.txt` with agent-disambiguation tables, not just links.

`llms.txt` follows the emerging "robots.txt for LLMs" convention, but goes past a link dump: every link is `[Name](url): why to open it`, plus a **"do not confuse these two URL forms" table aimed at agents** (defensive context that pre-empts the wrong inference, e.g. "/#14 returns 404") and a dedicated **"For AI Agents"** action section.

→ **On-thesis for Relay** (`project_relay_product_vision`: any LLM plugs in and DO + REMEMBER): a Relay `llms.txt` that tells an integrating agent how *not* to misuse the tools is low-effort, high-fit.

### D2. Intake-automation hygiene.

`tools/auto-review.sh` (a submission-intake pipeline, honestly named — no AI judges content): `set -euo pipefail`, validate-then-skip bad input (`JSON.parse` guard + empty-file check), idempotent by GitHub issue state (closed issues never reprocess), graceful-skip when a dependency (dev server) is absent, **launchd over cron** so it catches up after the Mac sleeps, and documents the bare-`PATH` cron gotcha.

→ Small hardening patterns for our oMLX start/stop, memory hooks, and any cron. Minor but real.

### D3. Docs craft.

Audience-segmented files (README = user, README-MINT shipped *inside* the zip = minter, CONTRIBUTING = contributor, tools/README = maintainer, BUG-*.md = post-mortem); fully bilingual (EN + 繁中) as a first-class concern; per-subsystem visual explainers. CONTRIBUTING is honest about the closed source — enumerates exactly three real contribution paths and a "what we don't accept" list, not generic "contributions welcome."

---

## Part E — Strategy (weigh, don't adopt reflexively)

The **transitional dual license** as an IP play: keep the engine (the moat) closed *now*, maximally free the outputs (artworks: full copyright to creator, no royalty) to kill adoption friction and seed network effects, and a **dead-man's-switch clause** that auto-opens the source under an OSI license when the author stops maintaining (community-trust device: the code won't die with the maintainer). A real option to weigh for how Relay eventually licenses — set against the standing "frame Relay as delegation+memory infra" line (`feedback_relay_is_delegation_engine`).

---

## Where / how to apply — by project

- **Fleet dispatch** (`model-hardtest/FLEET-DOCTRINE.md`): A1 (emit-a-generator), A2 (symptom-annotated constraints), A3 (minimal-core + backfill + warning). **Untested — run one measured task each, then promote to doctrine.** A2 partly overlaps what we already do.
- **Relay** (backlog candidates, triggers below): D1 llms.txt; B1+B2 seed-chain + draw-count divergence for replay/verify; C1 packaging recipe for a distributable agent bundle. All external-repo → BACKLOG only.
- **DNA viewer** (`project_dna_viewer`): C2 split-cache PWA lesson — apply when writing its service worker (before, not after, the stale-content bug).
- **Berry / trace analysis**: A-bonus (trajectory carries signal) + B2 (draw-count divergence).
- **Ops**: D2 intake-automation hygiene for cron/launchd/hooks.

## Suggested triggers (per BACKLOG discipline — no trigger fired = no build)

- llms.txt: when Relay has a public docs surface or an agent onboards and mis-infers a tool.
- Seed-chain + draw-count check: next time we build deterministic replay or need reproducible fleet grading.
- Packaging recipe: first time we package a self-contained distributable Relay agent bundle.
- Fleet A1–A3: promote to FLEET-DOCTRINE only after one measured pass each (K>1 for a winner, per doctrine).

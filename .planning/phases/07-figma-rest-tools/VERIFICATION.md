# Phase 7 Plan Verification — Figma REST Tools

**Verdict:** PASSED with 2 warnings.
**Plans checked:** 1 (`07-01-PLAN.md`)
**Issues:** 0 blocker, 2 warning, 1 info.
**Date:** 2026-05-19

---

## Coverage Matrix (ROADMAP Success Criteria → Plan)

| SC# | Roadmap Criterion (abridged) | Plan Locus | Status |
|-----|------------------------------|------------|--------|
| SC1 | `figma_list_layers` invoked, `GET /v1/files/{key}/nodes` with `X-Figma-Token`, returns tree | Task 3 (handler+8 cases) + Task 7 step 6 | COVERED |
| SC2 | No PAT → tools NOT registered, no startup error | Task 5 case 1 + Task 7 step 8; `registerFigmaTools` returns `null` (line 290–292) | COVERED |
| SC3 | Non-Enterprise 403 → clear surfaced message; Enterprise → write succeeds | Task 2 case 5 (kind:PLAN_REQUIRED) + Task 4 case 6 (graceful return, not throw) + Task 7 step 7 | COVERED |
| SC4 | 429 → Retry-After backoff, single retry, hard-error after — no infinite loop, no PAT leak | Task 2 cases 3+4 + case 9 (scrub in error) | COVERED |
| SC5 | `figma_get_selection` + `figma_create_component` declaratively deferred via `--help`/`doctor` | Task 5 case 5 + Task 6 case 5 + Task 7 step 10; `DEFERRED_FIGMA_TOOLS` const (line 295–296) | COVERED |

All 5 ROADMAP success criteria mapped to executable tasks with assertion-grade verification.

---

## REQ-ID Coverage (REQUIREMENTS.md FIGMA-01..05)

| REQ | Description | Covered By | Status |
|-----|-------------|------------|--------|
| FIGMA-01 | `figma_list_layers` REST GET with `X-Figma-Token` | Task 3 (list-layers.ts) + frontmatter `requirements: [FIGMA-01..05]` | COVERED |
| FIGMA-02 | `figma_update_token` POST + graceful 403 | Task 4 (update-token.ts, case 6) | COVERED |
| FIGMA-03 | Env-gated registration, no startup error when absent | Task 5 (registry case 1, returns null) | COVERED |
| FIGMA-04 | 429 Retry-After backoff, single retry | Task 2 cases 3+4 (fake timers) | COVERED |
| FIGMA-05 | Plugin-bridge tools declaratively deferred to v0.3 | Task 5 case 5 + Task 6 case 5 (`DEFERRED_FIGMA_TOOLS` const, no function exports) | COVERED |

5/5 REQ-IDs mapped. Frontmatter `requirements` field complete.

---

## Risk Register Coverage

| Risk | User-Listed | In Plan Register | Mitigation Anchor |
|------|-------------|------------------|-------------------|
| PAT leak (CATASTROPHIC) | yes | R-07-01 + T-07-01..03,10 | scrub.ts (T1) + rest-client error paths (T2 c9) + cmd-doctor (T6 c4) + grep gate (T7 step 9) |
| Phase 3 shape mismatch — fail loud, not silent reshape | yes | R-07-05 + Task 5 action (line 304, 314–318) | Explicit "DO NOT silently reshape Phase 3" + escalate to gap-closure plan |
| Rate-limit thrash | yes | R-07-02 + T-07-05 | Single retry (T2 c3+4); per-loop cap deferred to Phase 3 AGENTIC-02 hash-loop detector |
| Enterprise-only 403 misread | yes | R-07-03 + T-07-06 | Typed kinds (T2 c5+6); structured graceful return for PLAN_REQUIRED (T4 c6); doctor surfaces tier (T6 c2) |
| Deferred-tools accidentally enabled | yes | R-07-04 + verification gate #6 | `DEFERRED_FIGMA_TOOLS` is readonly list, NOT handlers; no function exports matching deferred names; phase-level grep gate at line 433 |

All 5 user-named risks present, with traceable mitigation citations.

---

## PAT-Leak Defense Check (Defense-in-Depth)

Goal-backward: a user grepping `~/.relay/debug/` finds zero raw PATs. Layers required:

| Layer | File | Mechanism | Test Anchor |
|-------|------|-----------|-------------|
| 1. At-rest | `pat-loader.ts` | Refuses chmod ≠ 600 read; stderr warn | T1 case 4 + T-07-03 |
| 2. Pure utility | `scrub.ts` | Regex `figd_[A-Za-z0-9_-]+` → `figd_***SCRUBBED***`; immutable (no input mutation per coding-style.md) | T1 scrub 6 cases |
| 3. Wire (egress) | `rest-client.ts` | Every error path routes through `scrubPat`; `scrubError` for stack | T2 case 9 + case 10 |
| 4. UI surface | `cmd-doctor.ts` | All output routed through `scrubPat` (belt + suspenders) | T6 case 4 |
| 5. Integration gate | Task 7 step 9 | `grep -rE "figd_[A-Za-z0-9_-]+" ~/.relay/debug/ \| grep -v SCRUBBED` → expect zero | Manual checkpoint |
| 6. Phase-level static gate | line 431 of PLAN | `grep` against production src excluding tests/SCRUBBED | Pre-merge verification |

5 layers + 1 static gate. PAT scrubbing is **layered**, not single-point. Immutable scrubbing per `scrubHeaders` returning a NEW object (line 162) is explicitly called out — good.

---

## Phase 3 Dependency Handling

`depends_on: ["03-agentic-lmstudio-runner"]` (line 6) — declared.

`<context>` block (line 119) imports `src/workers/lmstudio-agentic.ts` with comment **"Phase 3 output — BLOCKS this phase; do NOT start until Phase 3 ships"** — explicit blocker.

`<interfaces>` block (lines 123–144) pins the consumed contract verbatim:
- `ToolFunctionDef`, `ToolDef`, `ToolCall` from `src/workers/types.ts:7-30`
- Annotated **"Stable from Phase 3 (verified at src/workers/types.ts:7-30 during planning)"** — implies the planner did read Phase 3's exported types (which are part of v0.1 baseline per task).

Shape-mismatch handling in Task 5 action (lines 313–318):
- Path (a): mutable/extensible `tools[]` → conditional push
- Path (b): injected toolset via factory → expose `registerFigmaTools` result at call site
- Neither → **"fail loud + escalate to gap-closure plan, NEVER silently reshape Phase 3"** (R-07-05)

Verdict: **STRONG**. The plan is fail-loud on contract divergence with two pre-decided integration paths, not assumptive.

---

## Deferred-Tools Declarative-Deferral Check (FIGMA-05)

Goal-backward: a designer-user runs `relay doctor --figma` and sees both deferred names with v0.3 context — never sees them as registered tools that 404 mid-task.

| Requirement | Plan Anchor | Status |
|-------------|-------------|--------|
| Const-driven (single source of truth) | `DEFERRED_FIGMA_TOOLS: readonly ["figma_get_selection", "figma_create_component"]` (line 295) | OK |
| No function exports matching deferred names | "index.ts has NO export matching the deferred names" (line 297) + R-07-04 + verification gate #6 (line 433) | OK |
| Surfaced in doctor | Task 6 step 4: "ALWAYS render: 'Deferred to v0.3 (require Figma Plugin API bridge): <DEFERRED_FIGMA_TOOLS joined>'" + "read from const, do NOT hardcode names" (line 339) | OK |
| Tested | T5 case 5 (exactly 2 v0.3 names) + T6 case 5 (read from const, not hardcoded) | OK |
| Integration gate | T7 step 10: `relay doctor --figma \| grep "figma_get_selection\|figma_create_component"` → expect both with deferred context | OK |

Verdict: **CORRECTLY DECLARATIVE**. No stubs, no "v1 minimal version" anti-pattern (the exact pattern Dimension 7b is designed to catch). Phase-scope discipline statement at line 480 is explicit: "DECLARATIVE DEFERRAL ... NOT code stubs, NOT 'v1 minimal version.'"

---

## Other Dimensions

- **Task completeness**: All 7 tasks have files + action + verify + done (or `<what-built>` + `<how-to-verify>` + `<resume-signal>` for the checkpoint). Task 7 correctly typed `checkpoint:human-verify`.
- **Dependency correctness**: Single-plan phase; depends on `03-agentic-lmstudio-runner`. No cycles. Wave 1 consistent (no intra-phase deps).
- **Key links**: 5 `key_links` (worker→registry, list-layers→figmaGet, update-token→figmaPost, rest-client→scrub, doctor→client+index). Every wiring path has a regex pattern for grep-able verification.
- **Scope sanity**: 7 tasks, 14 production files + 6 test files. **Above the 5-task warning threshold (Dim 5)** but justified: 4 of 7 are tight single-file feature tasks (T1-T4), T5 is wire-up, T6 is doctor delta, T7 is human checkpoint. Files-per-task is ~2 (low). Risk is acceptable but flagged.
- **Architectural tier compliance**: No `## Architectural Responsibility Map` in any RESEARCH.md → Dim 7c SKIPPED. Tier separation visually clean (tools/figma is its own module; worker integration is a DELTA-only insert).
- **Nyquist (Dim 8)**: No VALIDATION.md exists → Dim 8 SKIPPED per gate 8e. *(Pre-existing condition for this phase.)* Every implementation task has an `<automated>` vitest command in `<verify>`, satisfying the spirit of 8a even without the formal gate.
- **CLAUDE.md (Dim 10)**: No project root CLAUDE.md (only `.claude/CLAUDE.md` under ai-stack parent). Cross-checked anyway: immutability rule honored (line 162 `scrubHeaders` returns new object), TDD discipline honored (test commits before impl commits in every task), no new runtime deps (verification gate #5 line 432, criterion #8 line 453).
- **Research resolution (Dim 11)**: No RESEARCH.md for Phase 7 → SKIPPED.
- **Pattern compliance (Dim 12)**: No PATTERNS.md for Phase 7 → SKIPPED.

---

## Gaps

### Warnings (should fix, non-blocking)

**W1 — Task 6 doctor `/v1/me` plan-tier parse is under-specified.**
- Location: Task 6 step 2 (line 337).
- Issue: Figma's `GET /v1/me` response shape does NOT contain a top-level `plan` or `tier` field. Plan tier is typically inferred from team/org membership endpoints (`GET /v1/teams/{id}` returns `plan`), or by attempting a Variables write and reading the 403 kind. The plan says "if 200, parse plan tier" but does not specify the parse path.
- Risk: Task 6 case 2 ("Enterprise mock") may rely on a mocked field that real Figma doesn't return; integration test (T7 step 5) could surprise.
- Fix: Either (a) document the actual JSON path used (and confirm via FIGMA-API-TOOLS.md or a quick `gh search code` for `/v1/me` consumers), or (b) replace `/v1/me`-based tier check with a tier-probe: attempt a no-op variables read (e.g. `GET /v1/files/{stable_key}/variables/local`) and infer tier from 200 vs 403 kind=PLAN_REQUIRED. Option (b) is more honest and reuses the same kind-mapping the production handler uses.

**W2 — Task 6 "stable public file_key" for sample REST is a footgun.**
- Location: Task 6 step 3 (line 338).
- Issue: Plan says "hardcode a documented Figma demo file key (e.g., Figma UI3 Design System)" with fallback "if no good candidate, skip sample call." Public file keys rotate, and hitting an external party's file on every `doctor --figma` invocation creates a low-grade availability dependency and quota cost on an unrelated team's Figma org.
- Fix: Prefer the fallback (skip sample call; rely on `/v1/me` 200 alone) OR allow the user's `<workdir>/.relay/figma.json` file_key as the sample target when present. Removes the third-party dependency entirely.

### Info (suggestion)

**I1 — Scope at threshold.**
- 7 tasks exceeds the 5-task warning band, but 6/7 are tight (one-file features with TDD pairs) and the 7th is a human checkpoint with no implementation context cost. Estimated execution context: ~60–70%. Acceptable. If execution shows context pressure mid-phase, the natural split is: Plan 01 (T1–T4: PAT+scrub+client+two tools) and Plan 02 (T5+T6: registry wire-up + doctor + integration checkpoint).

---

**Recommendation:** Proceed to execution. Address W1 (doctor `/v1/me` parse path) before starting Task 6 — verify the real `/v1/me` response shape via `gh search code` or one-off curl during T6 RED phase. W2 can be addressed during T6 GREEN by choosing the workdir-file_key fallback. Neither blocks T1–T5.

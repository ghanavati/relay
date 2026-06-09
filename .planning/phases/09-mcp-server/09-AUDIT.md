# Enterprise Plan Audit Report — Phase 9 (Relay MCP Server)

**Plans:** `.planning/phases/09-mcp-server/09-01..06-PLAN.md`
**Audited:** 2026-06-09 (PAUL enterprise-audit rubric, run manually against GSD-format plans — PAUL's `.paul/` auto-flow does not apply to a `.planning/` project; the 6-section senior-principal/compliance review does)
**Verdict:** Conditionally acceptable → acceptable after the two applied upgrades.

## 1. Executive Verdict

Approve for execution. The plan is well-grounded: every load-bearing reuse claim was verified against the live codebase (`src/contracts/memory.ts` schema exports, `src/tools/mcp-result.ts`, control schemas confirmed module-private, `ControlProvider` confirmed a closed enum). It is genuinely a thin transport over Phase 8, not a rewrite. The one real weakness was over-reliance on a single manual gate to prove the protocol actually works — the exact failure mode that shipped a green-but-dead TUI this milestone. Fixed by adding an automated SDK-level integration test.

## 2. What Is Solid (do not change)

- **Supply-chain gate (09-01).** New SDK dep is a blocking-human checkpoint: `npm view` name/version/maintainer/repo before install, pinned exact version, `resolveMcpSdk()` verifies the import surface against the installed package rather than hardcoding from docs. Correct posture for a new third-party dep with full Relay privileges.
- **Single source of truth (09-02).** Exporting the existing control Zod schemas + a name→schema map, with a test that the JSON-Schema ToolDef and the Zod schema agree on accept/reject. Kills the drift MCP-05 warns about.
- **Broker parity proof (09-04).** The MCP caller is an llm-kind control session; the six tools REUSE `registerControlTools` (no reimplementation), and the canonical Phase 8 policy tests (default-deny, grant, self-send, loop) are re-run THROUGH the MCP wrapper. Caller id bound server-side, strict schema rejects a model-supplied source key. This is the structural guarantee against the headline threat (MCP client sending as if human). `grep -c sendMessage|requestGrant src/mcp/tools-control.ts == 0` as an acceptance check is exactly right.
- **Boundary discipline (09-02/03).** Redaction centralized in `result.ts`/`withMcpResult`; every wrapper routes through it. Workdir scoping inherited by calling through `MemoryStore` rather than around it.
- **Open decisions handled honestly.** O-01 (dispatch over MCP) deferred with an explicit no-dispatch-tool note; O-02 (session identity) is a blocking `checkpoint:decision` with three options and a recommendation, not a silent pick; O-03 (save consent) ships at CLI parity with a flagged follow-up.
- **stdout discipline (09-05).** Treats stray-stdout-corruption as the operational landmine it is; grep gate + a test that diagnostics land on stderr only.

## 3. Enterprise Gaps / Latent Risks

1. **(Addressed) No automated proof the protocol works end-to-end.** 09-06 had a live human round-trip but no CI-durable integration test. Unit tests inject fake transports/SDK — they prove wiring shape, not that the real SDK speaks. This is the TUI failure class (1804 green, dead live surface). → applied.
2. **(Addressed) SECURITY.md not updated.** A new external entry point was documented only in user-facing docs, not in the canonical threat model that Phase 8 populated. → applied.
3. **(Deferred) MCP-save memory attribution.** Saves tag `memory_source = 'worker-mcp'` rather than an MCP-specific source — minor audit-attribution blur, parallels the O-02 provider concern. Safe to defer.
4. **(Deferred) No `relay doctor` check for the MCP surface.** Operability nicety, not a correctness gap. Defer.
5. **(Clarify, non-blocking) stdio concurrency.** stdio MCP is one-client-per-process; the per-connection nonce in 09-04 is for reconnect identity, not concurrent clients. The applied SECURITY.md note states this; no plan change needed.

## 4. Upgrades Applied to Plan

### Strongly Recommended (applied)

| # | Finding | Plan Section Modified | Change Applied |
|---|---------|----------------------|----------------|
| 1 | No automated end-to-end MCP protocol test (TUI-class risk) | 09-06 | Added `Task 2` (auto, tdd): drive the REAL SDK client ↔ server over an in-memory linked transport (fallback: `relay mcp` subprocess speaking framed JSON-RPC) — tools/list returns 8 names, save→recall round-trips, ungranted send default-denied. Added `src/mcp/server.integration.test.ts` to files_modified. Human gate renumbered to Task 3. |
| 2 | MCP surface absent from canonical threat model | 09-06 | Task 1 now also updates `SECURITY.md` with an `MCP server (relay mcp)` subsection (caller-as-llm-session, default-deny, redaction, stdio OS-user trust boundary, workdir scoping, single-client residual). Added `SECURITY.md` to files_modified. |

### Deferred (not applied)

| # | Finding | Rationale |
|---|---------|-----------|
| 1 | MCP-specific `memory_source` value | Cosmetic audit attribution; `worker-mcp` is truthful enough for v1. |
| 2 | `relay doctor` MCP check | Operability nicety, no correctness impact. |
| 3 | Persistent MCP session identity (O-02 option 3) | Out of v1 scope per O-02 lean; revisit if long-lived MCP grants are needed. |

## 5. Audit & Compliance Readiness

- **Defensible evidence:** every cross-session action emits SQLite audit events (reused Phase 8 path); the new integration test + human gate produce shippable proof the protocol works. Good.
- **Silent-failure prevention:** `withMcpResult` maps unknown throws to an isError result — the server never crashes from a handler throw, and no raw stack crosses the boundary. Good.
- **Reconstruction:** session register/end + send/block events are attributable to a server-bound caller id. Good, modulo the deferred `worker-mcp` attribution nit.
- **Accountability:** SDK install is human-approved; the MCP-07 final gate is human-signed. Good.

## 6. Final Release Bar

Must be true before this phase ships:
- 09-01 SDK install approved by the maintainer and pinned; `resolveMcpSdk()` green against the installed package.
- 09-04 O-02 decision made by the maintainer (recommended: new `mcp` provider in the closed enum, an explicit tested schema change).
- The applied automated integration test (09-06 Task 2) passes against the real SDK.
- Full suite green; `src/cli.ts` additive-only; live human round-trip signed (09-06 Task 3).

Remaining risk if shipped as-is after the above: low. The deferred items are cosmetic/operability, not correctness or security.

---

**Summary:** 0 must-have (none release-blocking after grounding verified), 2 strongly-recommended applied, 3 deferred. Plan status: strengthened and ready for `/gsd-execute-phase 9` — Wave 1 opens with the SDK supply-chain checkpoint.

*Audit performed manually using the PAUL enterprise-audit rubric against GSD-format plans.*

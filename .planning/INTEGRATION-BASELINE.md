---
captured_at: 2026-05-20T19:30:00Z
relay_version: 0.1.2
current_branch: main
head_commit: 7c9d0d1
baseline_dir: /tmp/relay-baseline-1779305027/
purpose: Verify v0.1.2 E2E flows still work BEFORE Phases 3-7 (v0.2) begin
status: GREEN — 12/12 PASS (after expected workdir-allowlist + auto-extract-payload calibrations)
---

# Integration Baseline — Pre Phase 3-7

Captured against `main` @ `7c9d0d1` with isolated `HOME=/tmp/relay-baseline-1779305027/home`
to avoid polluting the user's real Relay store. All 12 flows from the audit spec exercised
on real LM Studio (`http://localhost:1234`, 8 models loaded).

## Summary Table

| # | Flow | Verdict | Notes |
|---|------|---------|-------|
| 1 | `relay setup --everything --yes` | PASS | 4 sub-steps: init + global SessionStart + global SessionEnd + auto-extract consent. Exit 0. |
| 2 | `relay verify --json` | PASS | 5/5 checks: remember, recall, context-emit, hook, db-roundtrip. `ok: true`. |
| 3 | `relay doctor --json` | PASS | 10 OK / 4 missing / 0 failed. `schema_version` check reports `applied=2 matches expected=2`. |
| 4 | `memory remember` → `memory recall` | PASS | After allowlist set. Returns memory_id + token_count; recall returns scored entry. |
| 5 | Workdir scope under `RELAY_MEMORY_ALLOWED_WORKDIRS` | PASS | Allowed workdir succeeds; non-allowlisted workdir returns `Workdir not in RELAY_MEMORY_ALLOWED_WORKDIRS`. Leak prevention working. |
| 6 | `context emit --target cc` | PASS | Output shape: `{hookSpecificOutput:{hookEventName:"SessionStart", additionalContext:"..."}}`. Spec-compliant. |
| 7 | `relay run --provider lmstudio --task "..."` | PASS | run_id+output+duration_ms+exit_code returned; `status:success`. Latency ~4.4s. |
| 8 | `relay parallel <spec>` | PASS | 2/2 success, concurrent execution (~1.8s each). |
| 9 | SessionStart hook → context emit | PASS | Installed hook script executes correctly; emits expected hookSpecificOutput JSON. |
| 10 | SessionEnd hook → auto-extract (consent-gated) | PASS | After `RELAY_AUTO_EXTRACT_MODEL` set; `status:ok, lessons_written:1`. |
| 11 | `relay budget show --json` (post 8e5c08e) | PASS | Envelope contains `schema_version:1`. Confirmed: `{schema_version:1,total_usd:0,event_count:0,scope_filters:{provider:null,workdir:null,period:null}}`. |
| 12 | `relay export --workdir <path>` allowlist | PASS | Allowed workdir exports memories JSON; non-allowlisted returns `MEMORY_WORKDIR_FORBIDDEN`. |

## DB Baseline (Post-Setup)

```
schema_version table:
  1 | <ts> | baseline v0.1.x schema
  2 | <ts> | drop 11 orphan tables per SCHEMA-02

Memories: 4 rows (1 manual + 1 auto-extracted + 2 verify-cycle)

Tables present (post-migration): auth_sessions, auth_users, budget_alerts,
budget_limits, capability_evidence, command_events, corpora, corpora_fts*,
cost_events, idempotency_keys, memories, memories_fts*, memory_reads,
relay_sessions, run_diffs, run_events, runs, schema_version, worker_profiles

Confirmed dropped (zero presence): continuity_objects, recipes, sign_offs,
sign_off_amendments, operator_annotations, proxy_requests, jobs, tasks,
task_deps, job_events, verifications
```

Phase 1 migration is fully wired into `getDb` and applied on first launch.

## Calibrations Required (Not Failures)

These prompted error-loud messages until adjusted — expected privacy gates,
not regressions.

1. **`RELAY_MEMORY_ALLOWED_WORKDIRS` env required.** All memory ops (remember,
   recall, export) fail-loud with `FATAL: Workdir not in RELAY_MEMORY_ALLOWED_WORKDIRS`
   when the workdir is outside the allowlist. This IS the workdir-leak gate
   working as designed (see PROJECT.md privacy gates).

2. **Auto-extract stdin payload requires CC SessionEnd shape.** Initial test
   with `{transcript: "..."}` failed with `bad-payload`. Schema requires
   `{session_id, transcript_path (file), cwd, hook_event_name?}` — exactly
   what CC SessionEnd hook emits. Confirmed via `HookPayloadSchema` in
   `src/cli/cmd-memory-auto-extract.ts:66`.

3. **Auto-extract needs `RELAY_AUTO_EXTRACT_MODEL` or model field in
   `.relay/auto-extract.json` consent file or first IDLE model via `lms ps`.**
   With no model: `status:error:no-model` with the full resolution-order
   explanation in the error message. Fail-loud working correctly.

## Phase 3-7 Pre-Existing Foundations (Partial Work, Confirmed)

The following v0.2 partials are committed but NOT yet user-facing — Phase 3-7
plans must close the integration gap:

| Foundation | State | Gap to Phase 3-7 |
|------------|-------|------------------|
| `src/workers/lmstudio-agentic.ts` (20.6K, T1-T8 tests passing) | Skeleton + sandbox + LFM2 nudge + loop detector + dispatch wiring | `relay run --provider lmstudio-agentic` rejected by `cmd-run.ts` validator → must be registered in supported providers list (Phase 3) |
| `ExecutionModel` union has `"tool_loop"` | Wired in `src/workers/runner.ts:6` | Not yet emitted by any runner — Phase 3 closes |
| `src/memory/embedding-client.ts` (8.3K, 18 tests) | Wraps LM Studio `/v1/embeddings` | Not called by `cmd-memory-recall.ts` — Phase 4 closes |
| `embedding_blob BLOB` column on `memories` | Present, populated NULL | Phase 4 wires sync INSERT + lazy UPDATE |
| `cmd-budget` v0.2 (4d21e99) | All flags accepted, `schema_version:1` in envelope | PASSING — Phase 2 already verified |

## Phase 3-7 Risk Bar

- **Phase 1 (DONE)**: Schema migration verified intact. No regression.
- **Phase 2 (DONE)**: Budget envelope shape verified. No regression.
- **Phase 3**: Must add `lmstudio-agentic` to provider validator + wire `tool_loop`
  execution path. Skeleton tests pass; integration not yet user-facing.
- **Phase 4**: Must call `embedMemory()` from recall path without breaking sync
  semantics (lazy UPDATE pattern). Watch for HTTP-failure stderr-loud fallback.
- **Phase 5-7**: Depend on Phase 4 cosine values. Phase 7 requires Phase 3.

## Reproducibility

```bash
# Recreate baseline run
export HOME=/tmp/relay-baseline-$(date +%s)/home
mkdir -p $HOME
export RELAY_MEMORY_ALLOWED_WORKDIRS=$(dirname $HOME)
export RELAY_AUTO_EXTRACT_MODEL=qwen/qwen3-coder-next
# Then run flows 1-12 exactly as specified in audit prompt.
```

## Verdict

**GREEN — Phase 3-7 work may proceed.** All v0.1.2 critical paths
(setup, verify, doctor, memory roundtrip, workdir scope, context emit, run,
parallel, hooks, auto-extract, budget envelope, export) are operational on
current main. No regressions detected. Phase 3-7 changes will be measured
against this baseline.


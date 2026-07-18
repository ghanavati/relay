# oMLX Agentic Fleet Harness Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let Relay dispatch oMLX-served local models through a configurable OpenAI-compatible tool loop, then evaluate the whole fleet with short agentic worktree fixtures.

**Architecture:** Keep the existing LM Studio worker intact and add an oMLX-specific provider that reuses the safe in-process tool loop but does not depend on LM Studio capability metadata. A validated user profile file supplies per-model request parameters, including optional chat-template keyword arguments. The external `model-hardtest` project invokes Relay's CLI against compact fixtures, so measured behavior is the real deployment path.

**Tech Stack:** TypeScript, Node `node:test`, Zod, OpenAI-compatible HTTP, oMLX, Relay CLI, shell tool loop.

---

### Task 0: Reconcile Claude's dispatch baseline and repair harness prerequisites

**Files:**
- Reuse: `4dbd476` `src/control/control-e2e.test.ts`
- Reconcile: `2f5d326`, `5e6a7d2`, `ff2b91f`, `5600c6e`, `3b90ff0`
- Modify: `src/cli/cmd-parallel.ts`
- Modify: `src/cli/runner-factory.ts` (when introduced by the reconciled baseline)
- Modify: `src/cli/cmd-parallel.test.ts`
- Modify: `src/workers/lmstudio-agentic.test.ts`

**Step 1: Inventory the non-current Claude commits**

Confirm the current worktree does not already contain Claude's live-grant test
repair or Phase 9 provider-registry refactor. Do not reimplement either
change: transplant/reconcile the existing commits in dependency order, while
leaving unrelated Phase 9 MCP work out of the oMLX branch.

**Step 2: Restore a green baseline**

Use the live-clock grant test repair from `4dbd476`, then run:

```bash
npm ci
npm run typecheck
RELAY_ALLOWED_ROOTS= npm test
```

Expected: typecheck and all tests pass; the control E2E cases no longer create
already-expired grants from a fixed historical timestamp.

**Step 3: Make parallel agentic parity explicit**

Write failing tests proving every parallel agentic run gets the same Relay
control-session registration, default `shell_exec`, control-tool definitions,
extra handlers, cleanup, and sandbox marker as `relay run`. Reject a parallel
spec where two agentic tasks target the same workdir unless it explicitly opts
into that unsafe arrangement; the compact fleet fixtures always use isolated
workdirs.

**Step 4: Implement only the missing parity/isolation layer**

Build on Claude's provider registry and runner factory rather than restoring
the old hard-coded provider switch. Add the missing control wiring at the
shared factory/dispatch boundary, preserve every existing provider contract,
and validate workdir isolation before dispatching subprocess tools.

**Step 5: Verify and commit**

```bash
npm run build && RELAY_ALLOWED_ROOTS= npm test
git add src/control/control-e2e.test.ts src/cli/cmd-parallel.ts src/cli/runner-factory.ts src/cli/cmd-parallel.test.ts src/workers/lmstudio-agentic.test.ts
git commit -m "fix(parallel): align agentic dispatch and isolate workdirs"
```

Expected: full suite green. This is the gate before any oMLX fleet trial.

---

### Task 1: Define validated user inference profiles

**Files:**
- Create: `src/config/model-profiles.ts`
- Create: `src/config/model-profiles.test.ts`
- Modify: `docs/configuration.md`

**Step 1: Write failing tests**

Cover an absent profile file (returns empty), a valid exact-model profile, invalid JSON, an unknown profile field, invalid limits, and arbitrary JSON-safe `chat_template_kwargs`. Use a temporary file and a passed environment; never load user config at module import time.

**Step 2: Run failing tests**

Run: `npm run build && node --test dist/config/model-profiles.test.js`

Expected: module-not-found failure.

**Step 3: Implement the minimal resolver**

Export a Zod-validated `resolveModelInferenceProfile(model, env)` with this user-file contract:

```json
{
  "models": {
    "gemma-4-31b-it-UD-MLX-4bit": {
      "temperature": 0.2,
      "max_tokens": 4096,
      "max_iterations": 8,
      "chat_template_kwargs": { "enable_thinking": false }
    }
  }
}
```

Read `RELAY_INFERENCE_PROFILES_PATH` asynchronously. Exact model IDs only; no fallback model name and no source-level model table. Reject malformed config with a contextual `RelayError`; omit absent optional fields from the request.

**Step 4: Run tests and typecheck**

Run: `npm run build && node --test dist/config/model-profiles.test.js && npm run typecheck`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/config/model-profiles.ts src/config/model-profiles.test.ts docs/configuration.md
git commit -m "feat(config): add model inference profiles"
```

### Task 2: Make the agentic loop endpoint-configurable

**Files:**
- Create: `src/workers/openai-agentic.ts`
- Create: `src/workers/openai-agentic.test.ts`
- Modify: `src/workers/lmstudio-agentic.ts`
- Modify: `src/workers/lmstudio-agentic.test.ts`

**Step 1: Write failing tests**

Test a configurable endpoint/API key, request merge of profile sampling and `chat_template_kwargs`, default safe limits, a server response with a valid tool call followed by a final answer, and profile-specific iteration cap. Test that a generic endpoint never calls `/api/v0/models` and does not reject a `/v1/models` entry which lacks vendor capability metadata.

**Step 2: Run failing tests**

Run: `npm run build && node --test dist/workers/openai-agentic.test.js`

Expected: module-not-found failure.

**Step 3: Extract the shared safe tool loop**

Move the request/response loop, tool execution, loop detector, timeout, and response parsing into `OpenAiAgenticRunner`. Its constructor receives endpoint, auth-header resolver, optional model-availability probe, and inference-profile resolver. Preserve all existing shell sandbox and control-tool behavior. Keep `LmStudioAgenticRunner` as a thin compatibility wrapper with its current vendor capability probe, so existing users do not regress.

**Step 4: Verify regression and new tests**

Run: `npm run build && node --test dist/workers/lmstudio-agentic.test.js dist/workers/openai-agentic.test.js && npm run typecheck`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/workers/openai-agentic.ts src/workers/openai-agentic.test.ts src/workers/lmstudio-agentic.ts src/workers/lmstudio-agentic.test.ts
git commit -m "refactor(workers): share configurable agentic tool loop"
```

### Task 3: Add the oMLX agentic Relay provider

**Files:**
- Create: `src/workers/omlx-agentic.ts`
- Create: `src/workers/omlx-agentic.test.ts`
- Modify: `src/cli/cmd-run.ts`
- Modify: `src/cli/cmd-parallel.ts`
- Modify: `src/cli.ts`
- Modify: `src/config/providers.ts`
- Modify: `docs/providers.md`
- Modify: `docs/commands.md`

**Step 1: Write failing CLI/provider tests**

Assert that `relay run --provider omlx-agentic --model <id>` validates a model, creates a Relay control session, injects the same default/control tools as the existing agentic route, and selects `OmlxAgenticRunner`. Assert `relay parallel` accepts the provider and retains the agentic sandbox marker. Assert `OMLX_ENDPOINT` and `OMLX_API_KEY` are used and no LM Studio capability endpoint is requested.

**Step 2: Run the focused tests**

Run: `npm run build && node --test dist/workers/omlx-agentic.test.js dist/cli/cmd-run.test.js`

Expected: failures showing that `omlx-agentic` is unsupported.

**Step 3: Implement provider wiring**

Add `omlx-agentic` as an explicit provider. Require `OMLX_ENDPOINT` rather than guessing an endpoint; use `OMLX_API_KEY` only when supplied. Probe `/v1/models` solely for presence of the selected model, then dispatch through `OpenAiAgenticRunner` with the resolved profile. Reuse the same Relay-owned session registration and `shell_exec` / control tools. Keep provider names model-agnostic and do not alter the existing `lmstudio` routes.

**Step 4: Run all affected tests**

Run: `npm run build && node --test dist/workers/omlx-agentic.test.js dist/workers/openai-agentic.test.js dist/workers/lmstudio-agentic.test.js dist/cli/cmd-run.test.js dist/cli/cmd-parallel.test.js && npm run typecheck`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/workers/omlx-agentic.ts src/workers/omlx-agentic.test.ts src/cli/cmd-run.ts src/cli/cmd-parallel.ts src/cli.ts src/config/providers.ts docs/providers.md docs/commands.md
git commit -m "feat(omlx): add configurable agentic provider"
```

### Task 4: Create short Relay-driven agentic fleet fixtures

**Files:**
- Create: `/Users/ghanavati/ai-stack/Projects/model-hardtest/agentic-fixtures/`
- Create: `/Users/ghanavati/ai-stack/Projects/model-hardtest/harness/omlx-agentic-fleet.py`
- Create: `/Users/ghanavati/ai-stack/Projects/model-hardtest/harness/omlx-profiles.json`
- Create: `/Users/ghanavati/ai-stack/Projects/model-hardtest/AGENTIC-FLEET-README.md`

**Step 1: Create three isolated fixtures**

Each fixture contains a tiny source file, a `node:test` grader, and an expected scoped edit:

1. a mechanical validation/regex fix;
2. a small branching/parsing bug;
3. a failing-test diagnose/edit/retest task.

Each fixture must be independent, compile in under 10 seconds, reject unrelated file changes, and have a 90-second Relay timeout.

**Step 2: Create the runner**

Invoke `relay run --provider omlx-agentic --json` for each `(model, fixture)` pair in a temporary copy/worktree. Capture Relay JSON, diff scope, test status, duration, iterations, tool calls, and token fields. Do not call oMLX directly. Write a machine-readable result plus a concise table.

**Step 3: Add a profile inventory**

Start every served model with an explicit baseline profile. Do not turn thinking on by assumption. Add thinking experiments only after each model has passed all three baseline fixtures and its local chat template/API has been independently proven to accept that model's parameter.

**Step 4: Smoke test**

Run one fixture against a known oMLX model with `OMLX_ENDPOINT=http://127.0.0.1:8000` and a 90-second cap.

Expected: Relay reports a successful tool-loop run and the fixture grader is green.

**Step 5: Commit Relay-owned fixture documentation only**

If `model-hardtest` is a separate repository, commit its fixture work there with its own conventional commit. Do not accidentally stage it from the Relay worktree.

### Task 5: Fleet admission, thinking, and parallel trials

**Files:**
- Create: `/Users/ghanavati/ai-stack/Projects/model-hardtest/results/omlx-agentic-<date>.json`
- Create: `/Users/ghanavati/ai-stack/Projects/model-hardtest/results/omlx-agentic-<date>.md`

**Step 1: Baseline all served models**

Run the three 90-second fixtures sequentially for every oMLX-served model. A pass requires valid tool calls, a scoped diff, and green task test. Do not promote based on free-form output alone.

**Step 2: Thinking ablation for admitted candidates**

For models that pass the baseline, run one deliberately small reasoning fixture with their model-specific thinking setting explicitly off and on. Record improvement/failure and added latency; retain thinking only when it improves the gate.

**Step 3: Parallel suitability**

For admitted models, dispatch two independent fixtures via `relay parallel` and compare both completion rate and tail latency with the single-lane baseline. Increase concurrency only after the previous level stays green.

**Step 4: Publish routing decisions**

Classify every served model as: primary local agentic worker, specialist/deep worker, parallel worker, assist-only, or reject. Document hand-off use: Codex/Claude retains architectural/frontier work and delegates bounded implementation/test tasks to admitted Relay/oMLX workers.

# oMLX Fleet Operations Manual

Last reconciled: 2026-07-18. This is the handoff for Codex, Claude Code, and
any lead model that dispatches the local fleet through Relay. It records
measured evidence, not model-marketing claims.

## Operating rule

Use local models as bounded workers under a frontier lead. The lead owns task
decomposition, integration, review, and the final project test. A local worker
receives one explicit slice of work and must prove it with tools and tests.

Before dispatch, confirm the exact model ID from oMLX `/v1/models`; do not
substitute a similarly named model or an older quant.

## Evidence standard

The compact suite is maintained externally at `Projects/model-hardtest` and
uses the real `relay run --provider omlx-agentic` tool loop. A fixture is an
**admission pass** only when all three hold:

1. Relay ends with `status: success`.
2. Every required source file changed.
3. The untouched fixture test passes.

A source/test pass accompanied by a Relay error, timeout, malformed response,
or iteration cap is useful diagnostic evidence, not a reliable completion.
The July 18 generic baseline and later strict profile-aware suite are separate
campaigns; use strict results for routing.

## Current ledger

| Served model | Strict result | Current role |
|---|---:|---|
| `gemma-4-26b-a4b-it-UD-MLX-4bit` | 4/5 | Updated default bounded repair/implementation worker; one clean two-worktree parallel completion |
| `Qwen3.6-35B-A3B-MLX-6bit` | 4/5 | Deliberate serial implementation and vision experiments; not parallel-default yet |
| `gemma-4-31b-it-UD-MLX-4bit` | 3/5 | Hold only for a difficult-thinking comparison; no demonstrated advantage over updated 26B |
| `GLM-4.7-Flash-MLX-8bit` | 3/5 | Mechanical/schema/test work after iteration calibration |
| `Qwen3-Coder-Next-MLX-6bit` | 2/5 | Fast coding candidate; several edits passed tests but Relay hit the 8-iteration cap, so recalibrate before promotion |
| `Qwen3.5-122B-A10B-4bit` | 2/3 generic | Architecture/review audition only; not a coding worker yet |
| `gemma-4-31b-it-MLX-8bit` | 2/3 generic | Delete candidate; no demonstrated advantage |
| old `gemma-4-26B-A4B-it-QAT-MLX-4bit` | superseded | Delete candidate; older lmstudio-community quant, not comparable with updated 26B |
| `LFM2-24B-A2B-MLX-8bit` | not coding target | Routing, classification, compact summaries only |
| `Qwen3-0.6B-4bit` | not coding target | Canary/protocol experiments only |

`nomic` is an embedding model, not a generation worker.

## Per-model controls

Relay's exact-model profile schema supports `temperature`, `top_p`, `top_k`,
`min_p`, `presence_penalty`, `max_tokens`, `max_iterations`, and
`chat_template_kwargs`. The active user-owned profiles are in
`Projects/model-hardtest/harness/omlx-profiles.json`; Relay source must never
hardcode a fleet model.

| Family | Policy |
|---|---|
| Qwen3-Coder-Next | Non-thinking coding model. Use contract-style prompts and direct tool instructions; no generic thinking toggle. |
| Qwen3.6 | Reserve for ambiguity where deliberation pays off. Never globally truncate reasoning; a prior 24K-character watchdog cut off legitimate reasoning. |
| Gemma 4 | Use short explicit tool tasks. Thinking is template-controlled; do not assume a Qwen flag works for Gemma. Keep normal-tool and deliberate-thinking profiles separate. |
| GLM 4.7 Flash | Use explicit acceptance criteria and bounded mechanical work. Preserved thinking is escalation-only. |

Do not cure verbose thinking with one global output cap. Use the model's
template mode, a per-model output budget, the repeated-tool-call detector, and
a per-model iteration ceiling.

## Lead-model task contract

Every local task must state:

1. The one responsibility, allowed files, and forbidden files.
2. Observable acceptance behaviour, names, examples, and exact test command.
3. Tool order: inspect, test, smallest source-only change, retest, short final result.
4. Stop after one failed recovery attempt and return the exact test output.
5. No prose planning before tools.

For constrained work, state forbidden approaches, prescribe the known pattern,
and anchor the expected change. This reduces drift and unnecessary reasoning.

```text
Work only in src/parse.ts. Do not modify tests or configuration.
Required: parseRange(' 2 .. 5 ') returns {start: 2, end: 5};
parseRange('5..2') throws RangeError. Run: node --test test.mjs.
Use tools now: inspect, run the test, make the smallest source-only fix, rerun.
If it still fails after one correction, return the test output and stop.
```

## Parallelism

Using different models in parallel for different strengths is correct. Do not
give multiple models the same vague task or the same checkout.

- Every agentic task needs a different worktree/workdir; Relay rejects shared ones.
- Parallelise independent roles: implementation, separate test/schema work, and frontier-lead review/integration.
- Do not parallelise overlapping edits, shared lockfiles, migrations, or work that depends on an unmerged sibling task.
- Start at two local lanes. Promote a model only after repeated clean parallel completions with the same profile and task class.
- The lead alone merges and runs project-level verification.

Updated Gemma 26B has one clean two-worktree completion. Qwen3.6 hit its
iteration ceiling in that experiment; use it serially pending requalification.
Qwen3-Coder-Next and GLM need iteration-profile calibration before parallel
promotion.

## Commands

```bash
export OMLX_ENDPOINT=http://127.0.0.1:8000
export OMLX_API_KEY=omlx
export RELAY_INFERENCE_PROFILES_PATH=/absolute/path/to/omlx-profiles.json

relay run "<contract task>" \
  --provider omlx-agentic \
  --model "<exact served model id>" \
  --workdir "<isolated workdir>" \
  --timeout-ms 120000 \
  --json

relay parallel <spec.json> --max-concurrency 2 --json
```

Treat a non-success Relay status as failure even if a worker left code passing.
`relay parallel --json` includes the worker error message; preserve it in the
receipt instead of guessing at the cause.

## No-repeat protocol

Do not rerun a full suite simply because a new session starts. Re-run only when
the weights/revision/quant/served ID, profile/template mode, server/parser,
fixture contract, intended role, or parallelism tier changes. Record model ID,
profile revision, fixture, Relay status, test/source checks, time, token usage,
iterations, tool calls, and the raw JSON receipt.

Next qualifications: calibrate Coder-Next and GLM iteration ceilings; perform
one-fixture thinking/template A/Bs for Gemma and Qwen3.6; then requalify
Qwen3.6 in two worktrees. Only run a difficult Gemma 31B comparison if deciding
whether it earns its disk/RAM cost over Gemma 26B.

# oMLX Agentic Fleet Harness Design

## Decision

Relay will support oMLX as a generic OpenAI-compatible agentic endpoint, rather
than routing it through the LM Studio-specific capability probe. The same Relay
tool loop will run local models independently or alongside Codex, Claude Code,
and other providers.

## Goals

- Let any oMLX-served model use Relay's inspect, edit, test, and retry loop.
- Keep model inference settings outside Relay source and model IDs out of code.
- Measure agentic task completion rather than whole-file text regeneration.
- Provide a compact, repeatable fleet admission test with bounded runtime.

## Architecture

Add an OpenAI-compatible agentic provider that uses a configurable endpoint and
API key. Unlike `lmstudio-agentic`, it checks model availability but does not
require vendor-specific `tool_use` metadata. It retains the existing tool-loop
safety controls: workdir clamp, secret sanitisation, tool-output cap, repeated
turn detection, iteration cap, and request timeout.

Profiles are user configuration. A profile matches a model ID and provides
sampling, output, loop, and optional chat-template keyword settings. The worker
merges a validated profile into every request. A profile can request
`chat_template_kwargs.enable_thinking`, but no universal thinking flag is
assumed: each model earns that setting through its own template probe.

## Evaluation Contract

The fleet test uses Relay's real agentic dispatch against oMLX. Each model must
complete three isolated micro-fixtures: a scoped mechanical edit, a small
logic fix, and an inspect-edit-test-repair task. Every fixture is small, has a
test command, permits at most one corrective turn, and has a 90-second wall
limit. Recorded metrics are tool-call validity, green tests, scoped diff,
iterations, first tool-call latency, completion tokens, and total wall time.

The initial fleet pass uses the verified baseline profile for each model. Only
models that pass this agentic admission gate receive an optional thinking
ablation: a single reasoning-heavy fixture with the model-specific setting
explicitly disabled and enabled. Thinking is retained only when it improves the
quality gate enough to justify its latency.

## Non-goals

- Do not make local models one-shot promotion candidates.
- Do not encode model IDs, templates, or inference settings in Relay source.
- Do not use the former six-task, three-rung full-file-output ladder as the
  primary admission test.
- Do not claim parallel suitability from a single-lane result; concurrency is
  measured separately after a model passes the agentic gate.

## Rollout

1. Add the generic agentic adapter and profile schema with unit tests.
2. Add compact fixtures and a runner that calls Relay, not a direct completion
   script.
3. Baseline all oMLX-served models single-lane.
4. Classify admitted models, then run thinking and concurrency trials only for
   credible candidates.
5. Document routing: local workers can execute bounded implementation tasks
   alone or be delegated focused subtasks by frontier agents.

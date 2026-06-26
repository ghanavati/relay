# SPEC — Provider-agnostic auto-extract backend (any registry provider)

## Context
Relay v0.2.0, branch `phase-9-v04`. The memory auto-extractor (`src/cli/cmd-memory-auto-extract.ts`
→ `src/memory/auto-extract-runner.ts`) is **hardcoded to LM Studio** (probes `localhost:1234`).
Relay already has agnostic provider dispatch — `src/workers/provider-registry.ts` (builtins +
`RELAY_PROVIDER_<NAME>_*` env discovery) and the `relay run` path (`cmd-run.ts` →
`runnerFromProviderConfig` / builtin runners → `runner.run()`). The extractor must ride THAT,
so it is interchangeable with ANY provider. Do NOT introduce a closed `codex|claude|lmstudio`
enum — that contradicts the v0.4 "closed unions deleted" decision.

## Goal
The auto-extract backend = an **open provider NAME** resolved by `resolveProvider(name)`:
- builtins: `codex` (subprocess CLI, no key — DEFAULT), `anthropic` (API), `lmstudio`,
  `lmstudio-agentic`, `openrouter`
- any `RELAY_PROVIDER_<NAME>_*` (openai|anthropic wire) the user declares
- (NEW) `claude` — a subprocess builtin wrapping the local `claude -p` CLI, keyless like codex

Resolution precedence: `RELAY_AUTO_EXTRACT_BACKEND` env → `.relay/auto-extract.json` `extractor`
field → default `codex`. Unknown name → `resolveProvider` throws → extraction returns a clean
error (logged); the SessionEnd hook legs are `|| true`, so it NEVER breaks session end.

## Files
1. MODIFY `src/workers/provider-registry.ts` — add a `claude` **subprocess** builtin mirroring the
   `codex` builtin (invokes `claude -p`, non-interactive, no API key). Keep `subprocess` builtin-only.
2. MODIFY `src/memory/auto-extract-consent.ts` — `extractor: z.string().min(1).default('codex')`
   (a provider NAME, validated at dispatch by `resolveProvider`, NOT a Zod enum).
3. CREATE `src/memory/extract-dispatch.ts` (thin) — `dispatchExtraction(providerName, prompt, {timeoutMs})`:
   `resolveProvider(name)` → build the runner the same way `cmd-run.ts` does (env →
   `runnerFromProviderConfig`; builtins → their runner) → `runner.run({prompt})` → return raw text.
   Factor the runner-construction out of `cmd-run.ts` so both call one helper (no duplication).
4. MODIFY `src/cli/cmd-memory-auto-extract.ts` — resolve backend (precedence above); call
   `dispatchExtraction`; for non-`lmstudio` providers read the FULL transcript (up to a logged cap,
   default 600_000 chars) instead of the 32 KB window. Keep `buildPrompt`, `stripJsonFences`,
   the Zod schema (`auto-extract-schema.ts`), `redactSecretsAndPII`, consent gate, `relay pause`
   gate, and Berry scoring UNCHANGED.
5. MODIFY enable path: `relay memory auto-extract --enable [--extractor <provider-name>]` persists the field.
6. TESTS: `extract-dispatch.test.ts` (resolves codex/anthropic/lmstudio/a fake `RELAY_PROVIDER_*`/claude;
   precedence env>file>default; unknown name → clean error, no throw past the gate); consent test for the
   new field; e2e: codex default extracts with no `ANTHROPIC_API_KEY`; cap-logging on a >32 KB transcript.

## Constraints
- Agnostic: the set of valid extractors = whatever `resolveProvider` knows (builtins + env). No enum.
- Keyless CLIs: `codex` (existing) and the new `claude` builtin run as subprocesses using local auth —
  no API key. API/HTTP providers (`anthropic`, `openrouter`, custom `RELAY_PROVIDER_*`) use their key as today.
- Reuse `buildPrompt` + `stripJsonFences` + `auto-extract-schema` — the ADDS/CONTRADICTS/REFINES JSON
  contract is byte-identical across providers.
- `redactSecretsAndPII` runs on the transcript BEFORE any provider/subprocess sees it.
- Timeout default 120s; failure/timeout → error result (hook stays `|| true`).
- Repo style: immutability, Zod validation, no `console.log` (use relay log).

## Acceptance criteria (testable)
1. `relay memory auto-extract --enable --extractor codex` writes `"extractor":"codex"`; `--extractor anthropic`
   or any `RELAY_PROVIDER_*` name is accepted; an unknown name fails fast at resolve with a clear error.
2. backend=codex extracts via `codex exec` with NO `ANTHROPIC_API_KEY` and NO LM Studio.
3. backend=claude extracts via `claude -p` with NO key (new subprocess builtin).
4. backend=lmstudio still uses the existing runner; backend=a declared `RELAY_PROVIDER_FOO` dispatches to that endpoint.
5. `RELAY_AUTO_EXTRACT_BACKEND` overrides the consent file overrides default codex.
6. >32 KB transcript read whole (up to cap) for non-lmstudio; capping logged; never silent.
7. All existing auto-extract tests pass; new tests pass; `npm run build` clean.

## Reference code to match
- `src/workers/provider-registry.ts` — the `codex` subprocess builtin (model for the `claude` builtin) + `resolveProvider`.
- `src/cli/cmd-run.ts` (~lines 80–190) — the runner-construction/dispatch pattern to factor into `extract-dispatch.ts`.
- `src/memory/auto-extract-runner.ts` — `buildPrompt`, `stripJsonFences`, `ExtractionResult` shape.
- `src/cli/cmd-memory-auto-extract.ts` — the `--from-stdin` pipeline, consent + pause gates.

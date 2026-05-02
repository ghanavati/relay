# Relay Solo-CLI Extract — Codex Validation
**Reviewer:** Codex gpt-5.3-codex (xhigh)
**Date:** 2026-05-02
**Verdict:** STOP AND REWORK

## Compilation blockers (must fix before npx tsc)
- `npm run -s typecheck` currently fails immediately on config: `tsconfig.json` uses `"esModuleInterop": false` with `"ignoreDeprecations": "5.0"` (TS 5.9 rejects this combo).
- After bypassing that gate (`npx tsc --noEmit --ignoreDeprecations 6.0`), there are extensive missing-module errors. The extract contains **121 broken relative imports** whose targets were dropped from the Relay repo.

| File:Line | Broken import in Relay | Dropped path (exists in `relay-mcp`) |
|---|---|---|
| `src/cli/commands.ts:6` | `../contracts/get_project_briefing.js` | `src/contracts/get_project_briefing.ts` |
| `src/cli/commands.ts:12` | `../tools/get_project_briefing.js` | `src/tools/get_project_briefing.ts` |
| `src/cli/commands.ts:1241` | `../skills/store.js` | `src/skills/store.ts` |
| `src/cli/commands.ts:1275` | `../skills/signer.js` | `src/skills/signer.ts` |
| `src/cli/commands.ts:1284` | `../skills/signer.js` | `src/skills/signer.ts` |
| `src/cli/commands.ts:1479` | `../self-improve/loop.js` | `src/self-improve/loop.ts` |
| `src/cli/commands.ts:1523` | `./cmd-validate.js` | `src/cli/cmd-validate.ts` |
| `src/cli/commands.ts:1527` | `./cmd-sign-off.js` | `src/cli/cmd-sign-off.ts` |
| `src/cli/commands.ts:1539` | `./cmd-guardian.js` | `src/cli/cmd-guardian.ts` |
| `src/cli/commands.ts:1543` | `./cmd-drift.js` | `src/cli/cmd-drift.ts` |
| `src/cli/commands.ts:1547` | `./cmd-exceptions.js` | `src/cli/cmd-exceptions.ts` |
| `src/cli/commands.ts:1567` | `./cmd-team.js` | `src/cli/cmd-team.ts` |
| `src/cli/commands.ts:1637` | `../config/hosted-config.js` | `src/config/hosted-config.ts` |
| `src/cli/commands.ts:1642` | `../hosted/cli-commands.js` | `src/hosted/cli-commands.ts` |
| `src/cli/commands.ts:1848` | `./report-dora-vendor.js` | `src/cli/report-dora-vendor.ts` |
| `src/cli/commands.ts:1854` | `./report-finanstilsynet.js` | `src/cli/report-finanstilsynet.ts` |
| `src/cli/commands.ts:1860` | `./report-rts6.js` | `src/cli/report-rts6.ts` |
| `src/cli/commands.ts:1866` | `./report-eiopa.js` | `src/cli/report-eiopa.ts` |
| `src/cli/commands.ts:1872` | `./report-eba.js` | `src/cli/report-eba.ts` |
| `src/cli/commands.ts:1878` | `./report-iec62304.js` | `src/cli/report-iec62304.ts` |
| `src/cli/commands.ts:1884` | `./report-dcb0129.js` | `src/cli/report-dcb0129.ts` |
| `src/cli/commands.ts:1890` | `./report-vendor-security.js` | `src/cli/report-vendor-security.ts` |
| `src/cli/commands.ts:1896` | `./report-annual-self-assessment.js` | `src/cli/report-annual-self-assessment.ts` |
| `src/cli/commands.ts:1902` | `./report-iso42001.js` | `src/cli/report-iso42001.ts` |
| `src/cli/commands.ts:1908` | `./report-pccp.js` | `src/cli/report-pccp.ts` |
| `src/cli/commands.ts:1914` | `./report-annex-iv.js` | `src/cli/report-annex-iv.ts` |
| `src/cli/commands.ts:1920` | `./report-aggregate.js` | `src/cli/report-aggregate.ts` |
| `src/cli/commands.ts:1926` | `./report-board-pack.js` | `src/cli/report-board-pack.ts` |
| `src/cli/commands.ts:1937` | `./report-degradation.js` | `src/cli/report-degradation.ts` |
| `src/cli/commands.ts:1942` | `./report.js` | `src/cli/report.ts` |
| `src/cli/commands.ts:1975` | `./backtest.js` | `src/cli/backtest.ts` |
| `src/cli/config.ts:7` | `../skills/store.js` | `src/skills/store.ts` |
| `src/cli/config.ts:8` | `../skills/importer.js` | `src/skills/importer.ts` |
| `src/cli/config.ts:9` | `../profiles/store.js` | `src/profiles/store.ts` |
| `src/cli/config.ts:10` | `../command-packs/store.js` | `src/command-packs/store.ts` |
| `src/cli/config.ts:338` | `./report-dora-vendor.js` | `src/cli/report-dora-vendor.ts` |
| `src/cli/config.ts:347` | `./report-eba.js` | `src/cli/report-eba.ts` |
| `src/cli/config.ts:356` | `./report-vendor-security.js` | `src/cli/report-vendor-security.ts` |
| `src/cli/config.ts:365` | `./report-iso42001.js` | `src/cli/report-iso42001.ts` |
| `src/cli/formatters.ts:2` | `../contracts/get_project_briefing.js` | `src/contracts/get_project_briefing.ts` |
| `src/cli/formatters.ts:6` | `../skills/store.js` | `src/skills/store.ts` |
| `src/cli/formatters.ts:7` | `../skills/importer.js` | `src/skills/importer.ts` |
| `src/cli/formatters.ts:8` | `../profiles/store.js` | `src/profiles/store.ts` |
| `src/cli/formatters.ts:9` | `../command-packs/store.js` | `src/command-packs/store.ts` |
| `src/cli/session.ts:6` | `../git/worktree.js` | `src/git/worktree.ts` |
| `src/context/layers.ts:6` | `../command-packs/store.js` | `src/command-packs/store.ts` |
| `src/context/layers.ts:7` | `../skills/store.js` | `src/skills/store.ts` |
| `src/context/layers.ts:8` | `../plugins/store.js` | `src/plugins/store.ts` |
| `src/runtime/context-resolver.ts:9` | `../profiles/store.js` | `src/profiles/store.ts` |
| `src/runtime/context-resolver.ts:10` | `../command-packs/store.js` | `src/command-packs/store.ts` |
| `src/runtime/run-recorder.ts:17` | `./guardian/qualify.js` | `src/runtime/guardian/qualify.ts` |
| `src/runtime/run-recorder.ts:386` | `../tools/run-retention.js` | `src/tools/run-retention.ts` |
| `src/runtime/runner-dispatcher.ts:5` | `./drift/drift-store.js` | `src/runtime/drift/drift-store.ts` |
| `src/runtime/runner-dispatcher.ts:6` | `./drift/trajectory-classifier.js` | `src/runtime/drift/trajectory-classifier.ts` |
| `src/runtime/runner-dispatcher.ts:12` | `../git/snapshot.js` | `src/git/snapshot.ts` |
| `src/runtime/runner-dispatcher.ts:14` | `../git/diff.js` | `src/git/diff.ts` |
| `src/runtime/shadow-audit/shadow-audit.ts:20` | `../guardian/recorder.js` | `src/runtime/guardian/recorder.ts` |
| `src/runtime/store/db.ts:8` | `../guardian/db-migrations.js` | `src/runtime/guardian/db-migrations.ts` |
| `src/runtime/store/db.ts:9` | `../../self-improve/db-migrations.js` | `src/self-improve/db-migrations.ts` |
| `src/runtime/store/db.ts:11` | `../validations/db-migrations.js` | `src/runtime/validations/db-migrations.ts` |
| `src/runtime/store/db.ts:12` | `../drift/db-migrations.js` | `src/runtime/drift/db-migrations.ts` |
| `src/runtime/store/db.ts:13` | `../oversight/db-migrations.js` | `src/runtime/oversight/db-migrations.ts` |
| `src/runtime/store/db.ts:14` | `../exceptions/db-migrations.js` | `src/runtime/exceptions/db-migrations.ts` |
| `src/runtime/store/db.ts:16` | `../retention/db-migrations.js` | `src/runtime/retention/db-migrations.ts` |
| `src/runtime/store/db.ts:17` | `../intoto/db-migrations.js` | `src/runtime/intoto/db-migrations.ts` |
| `src/server.ts:15` | `./runtime/guardian/guardian-store.js` | `src/runtime/guardian/guardian-store.ts` |
| `src/server.ts:17` | `./config/hosted-config.js` | `src/config/hosted-config.ts` |
| `src/server.ts:18` | `./hosted/store/pg-db.js` | `src/hosted/store/pg-db.ts` |
| `src/server.ts:19` | `./hosted/auth/middleware.js` | `src/hosted/auth/middleware.ts` |
| `src/server.ts:20` | `./hosted/billing/billing.js` | `src/hosted/billing/billing.ts` |
| `src/server.ts:21` | `./hosted/router.js` | `src/hosted/router.ts` |
| `src/server.ts:22` | `./hosted/local-router.js` | `src/hosted/local-router.ts` |
| `src/server.ts:23` | `./hosted/auth/handler.js` | `src/hosted/auth/handler.ts` |
| `src/server.ts:24` | `./hosted/proxy-handler.js` | `src/hosted/proxy-handler.ts` |
| `src/server.ts:26` | `./runtime/guardian/guardian-handler.js` | `src/runtime/guardian/guardian-handler.ts` |
| `src/server.ts:27` | `./runtime/drift/drift-handler.js` | `src/runtime/drift/drift-handler.ts` |
| `src/server.ts:29` | `./runtime/intoto/attestation-handler.js` | `src/runtime/intoto/attestation-handler.ts` |
| `src/server.ts:32` | `./self-improve/skill-distill.js` | `src/self-improve/skill-distill.ts` |
| `src/tools/delegate_parallel.ts:11` | `../git/worktree.js` | `src/git/worktree.ts` |
| `src/tools/delegate_parallel.ts:12` | `../git/worktree.js` | `src/git/worktree.ts` |
| `src/tools/delegate-validation.ts:4` | `../contracts/validate.js` | `src/contracts/validate.ts` |
| `src/tools/delegate-validation.ts:16` | `../command-packs/store.js` | `src/command-packs/store.ts` |
| `src/tools/delegate-validation.ts:17` | `../skills/store.js` | `src/skills/store.ts` |
| `src/tools/delegate-validation.ts:18` | `../profiles/store.js` | `src/profiles/store.ts` |
| `src/tools/delegate.ts:16` | `../runtime/leases/idempotency.js` | `src/runtime/leases/idempotency.ts` |
| `src/tools/get_run.ts:8` | `../runtime/store/sign-store.js` | `src/runtime/store/sign-store.ts` |
| `src/tools/guardian-policies.ts:1` | `../runtime/guardian/guardian-store.js` | `src/runtime/guardian/guardian-store.ts` |
| `src/tools/guardian-policies.ts:2` | `../contracts/guardian.js` | `src/contracts/guardian.ts` |
| `src/tools/model-declaration-loader.ts:5` | `../contracts/export_aibom.js` | `src/contracts/export_aibom.ts` |
| `src/tools/register-all.ts:6` | `../contracts/sign_off.js` | `src/contracts/sign_off.ts` |
| `src/tools/register-all.ts:7` | `../contracts/validate.js` | `src/contracts/validate.ts` |
| `src/tools/register-all.ts:10` | `./amend_sign_off.js` | `src/tools/amend_sign_off.ts` |
| `src/tools/register-all.ts:11` | `./sign_off.js` | `src/tools/sign_off.ts` |
| `src/tools/register-all.ts:12` | `./validate.js` | `src/tools/validate.ts` |
| `src/tools/register-all.ts:17` | `../contracts/get_project_briefing.js` | `src/contracts/get_project_briefing.ts` |
| `src/tools/register-all.ts:18` | `./get_project_briefing.js` | `src/tools/get_project_briefing.ts` |
| `src/tools/register-all.ts:20` | `../contracts/export_aibom.js` | `src/contracts/export_aibom.ts` |
| `src/tools/register-all.ts:23` | `./export_aibom.js` | `src/tools/export_aibom.ts` |
| `src/tools/register-all.ts:24` | `../contracts/guardian.js` | `src/contracts/guardian.ts` |
| `src/tools/register-all.ts:27` | `./register-model.js` | `src/tools/register-model.ts` |
| `src/tools/register-all.ts:28` | `./get-model.js` | `src/tools/get-model.ts` |
| `src/tools/register-all.ts:29` | `./list-models.js` | `src/tools/list-models.ts` |
| `src/tools/register-all.ts:30` | `./update-model-status.js` | `src/tools/update-model-status.ts` |
| `src/tools/register-all.ts:32` | `./create-validation-plan.js` | `src/tools/create-validation-plan.ts` |
| `src/tools/register-all.ts:33` | `./list-validation-findings.js` | `src/tools/list-validation-findings.ts` |
| `src/tools/register-all.ts:34` | `./create-validation-finding.js` | `src/tools/create-validation-finding.ts` |
| `src/tools/register-all.ts:35` | `../contracts/operator-annotation.js` | `src/contracts/operator-annotation.ts` |
| `src/tools/register-all.ts:36` | `./create-operator-annotation.js` | `src/tools/create-operator-annotation.ts` |
| `src/tools/register-all.ts:37` | `../contracts/oversight.js` | `src/contracts/oversight.ts` |
| `src/tools/register-all.ts:38` | `./create-oversight-assignment.js` | `src/tools/create-oversight-assignment.ts` |
| `src/tools/register-all.ts:39` | `./log-override.js` | `src/tools/log-override.ts` |
| `src/tools/register-all.ts:40` | `./list-overrides.js` | `src/tools/list-overrides.ts` |
| `src/tools/register-all.ts:41` | `../contracts/exceptions.js` | `src/contracts/exceptions.ts` |
| `src/tools/register-all.ts:42` | `./log-exception.js` | `src/tools/log-exception.ts` |
| `src/tools/register-all.ts:43` | `./list-exceptions.js` | `src/tools/list-exceptions.ts` |
| `src/tools/register-all.ts:44` | `./resolve-exception.js` | `src/tools/resolve-exception.ts` |
| `src/tools/register-all.ts:49` | `../contracts/retention.js` | `src/contracts/retention.ts` |
| `src/tools/register-all.ts:50` | `./run-retention.js` | `src/tools/run-retention.ts` |
| `src/tools/register-all.ts:51` | `./list-retention-events.js` | `src/tools/list-retention-events.ts` |
| `src/tools/register-all.ts:52` | `../skills/store.js` | `src/skills/store.ts` |
| `src/tools/register-all.ts:84` | `../runtime/oversight/oversight-store.js` | `src/runtime/oversight/oversight-store.ts` |

## Files in src/ that should not be (rsync filter leaks)
- `src/server.ts` — still wires hosted/auth/billing/proxy/guardian/drift/attestation paths that were explicitly dropped.
- `src/tools/register-all.ts` — still registers sign-off, validate, guardian, oversight, exceptions, retention, and model-governance tools.
- `src/cli/commands.ts` — still exposes compliance/report/guardian/drift/exceptions/team/backtest command surface and imports dropped handlers.
- `src/cli/config.ts` — `init` still includes compliance pack options (`dora`, `eba`, `vendor-security`, `iso42001`).
- `src/cli/formatters.ts` — help text still documents compliance commands and legacy `relay-mcp` branding.
- `src/tools/guardian-policies.ts` — pure guardian/compliance helper with dropped dependencies.
- `src/tools/delegate-validation.ts` — depends on dropped validation + skills/profiles/command-pack modules.
- `src/runtime/change-control.ts` — explicit MiFID II RTS 6 change-control formatter (regulatory scope).
- `src/runtime/rts6-formatter.ts` — regulatory reporting formatter (RTS6 scope).
- `src/runtime/retention-policy.ts` — policy-biased retention helper (min 180 days) tied to dropped retention tooling.
- `src/contracts/amend_sign_off.ts` — sign-off workflow contract persisted after sign-off toolchain was removed.
- `src/runtime/shadow-audit/shadow-audit.ts` and `src/runtime/shadow-audit/shadow-audit-handler.ts` — still coupled to dropped guardian subsystem.

## Files that should be in src/ but were dropped (false negatives)
These are referenced by retained solo-CLI code and exist in `relay-mcp/src`, but are missing in Relay:
- `src/command-packs/store.ts` — used by `cli/config.ts`, `context/layers.ts`, `tools/delegate-validation.ts`.
- `src/profiles/store.ts` — used by `cli/config.ts`, `runtime/context-resolver.ts`, `tools/delegate-validation.ts`.
- `src/plugins/store.ts` — used by `context/layers.ts`.
- `src/git/worktree.ts` — used by `cli/session.ts` and `tools/delegate_parallel.ts`.
- `src/git/snapshot.ts` and `src/git/diff.ts` — used by `runtime/runner-dispatcher.ts`.
- `src/runtime/leases/idempotency.ts` — used by `tools/delegate.ts` (core delegation path).
- `src/contracts/get_project_briefing.ts` and `src/tools/get_project_briefing.ts` — used by console/briefing paths.
- `src/skills/store.ts`, `src/skills/importer.ts`, `src/skills/signer.ts` — required if retained `skills` CLI actions remain.

## package.json / tsconfig.json issues
- `tsconfig.json` blocks typecheck on TS 5.9 due deprecated `esModuleInterop=false` + `ignoreDeprecations: "5.0"`.
- `tsconfig.json` includes only `src/**/*.ts`, but retained code imports TSX UI (`src/cli/ui/browse-interactive.tsx`) and no JSX compiler option is set.
- `package.json` currently declares only `better-sqlite3` and `zod`, but retained source imports additional undeclared runtime deps:
  - `@modelcontextprotocol/sdk`
  - `async-mutex`
  - `ioredis`
  - `ipaddr.js`
  - `pg`
  - `rate-limiter-flexible`
  - `react`
  - `ink`
- `relay init` still scaffolds legacy targets:
  - local mode points to `dist/index.js` (not `dist/cli.js`)
  - published mode points to `@sghanavati/relay-mcp` (old package name)
- Branding is still old in multiple places (`relay-mcp` appears in help text and fatal logs).

## Strategic notes for solo-CLI use
- Day-1 target (`npm install -g github:user/relay`, `relay init`, memory + delegation + audit trail) is **not** satisfied in current state because compile fails and command surface is internally inconsistent.
- The extraction mixed two incompatible states:
  - compliance/hosted code removed from filesystem,
  - but many references to that code kept in core entrypoints.
- There are two viable directions; current middle state is the worst one:
  - **Slim mode:** prune command surface/tool registry/server hooks to true solo-only behavior.
  - **Compat mode:** restore missing modules and dependencies to keep legacy surface intact.
- For solo day-1 UX, slim mode is the better fit: keep `init`, `run/delegate`, `memory`, `browse/get-run/compare`, `export/import`, and remove compliance/hosted/report/team/sign-off/guardian/drift/exceptions flows.

## Concrete next-step list (ordered)
1. Pick extraction strategy explicitly: `Slim mode` (recommended) vs `Compat mode`.
2. If slim mode: delete/disable compliance + hosted + regulatory command paths in `src/server.ts`, `src/tools/register-all.ts`, and `src/cli/commands.ts` first, then re-run import scan.
3. If compat mode: restore all 121 missing import targets from `relay-mcp/src` before further refactors.
4. Fix `relay init` targets (`dist/cli.js` and package name `relay`) and replace remaining `relay-mcp` strings.
5. Align `package.json` dependencies with actually imported modules (or remove corresponding code paths).
6. Update `tsconfig.json` for current TypeScript and source set, then run `npm install` and `npx tsc --noEmit` as the extraction gate.

The patch introduces privacy controls and setup/diagnostic commands whose core enforcement paths are missing or inconsistent. Several documented flows can leak or recall memory despite opt-out settings, and common allowlist configurations cause false failures or bypasses.

Full review comments:

- [P1] Gate installed hooks on the pause sentinel — /Users/ghanavati/ai-stack/Projects/Relay/src/cli/cmd-memory-ops.ts:161-161
  When a user runs `relay pause` (global or workdir), this installed SessionStart command still calls `relay context emit` directly; no `relay pause --check --workdir "${CLAUDE_PROJECT_DIR:-$PWD}"` guard is included. In a paused session, memories will still be recalled and injected, and the SessionEnd hook below has the same issue for auto-extraction, so the advertised privacy off-switch does not work.

- [P1] Honor project opt-out before extraction — /Users/ghanavati/ai-stack/Projects/Relay/src/cli/cmd-memory-auto-extract.ts:293-295
  When a project contains `.relayignore` from `relay project disable` or rules to suppress transcript paths, the pipeline loads the transcript window and proceeds to redaction/extraction without reading that file. In an opted-out project with consent still present, tool output that should be disabled or redacted can still reach the extraction model and be written as memory.

- [P1] Enforce the workdir allowlist in export — /Users/ghanavati/ai-stack/Projects/Relay/src/cli/cmd-export.ts:64-67
  When `RELAY_MEMORY_ALLOWED_WORKDIRS` is set, other memory paths call `assertWorkdirAllowed`, but export selects rows directly and accepts any `--workdir`/cwd. Running `relay export --workdir /outside/allowlist` can export memories for a forbidden project instead of raising `MEMORY_WORKDIR_FORBIDDEN`, bypassing the documented privacy boundary.

- [P2] Keep trust_level in sync before filtering — /Users/ghanavati/ai-stack/Projects/Relay/src/memory/memory-store.ts:663-665
  The new `--min-trust`/context emit filter uses the persisted `trust_level` column, but `markRecallSuccess()` and `upsert()` do not update that column. Memories that are actually provisional/trusted after successful recalls or pinned upserts remain filtered out by `--min-trust=provisional|trusted`, so context emission can miss the memories the trust ladder promoted.

- [P2] Detect the new context-emit hook in doctor — /Users/ghanavati/ai-stack/Projects/Relay/src/cli/cmd-doctor.ts:13-13
  After `relay memory hook --install --global`, the installed command is now `relay context emit --target cc`, so this fragment never matches and `relay doctor` reports `cc-global-hook` missing. Users with the new hook installed get false diagnostics; the roundtrip check below also still shells through the old recall+jq pipeline instead of the current hook.

- [P2] Pass workdir through verify smoke writes — /Users/ghanavati/ai-stack/Projects/Relay/src/cli/cmd-verify.ts:57-62
  `relay verify` runs these smoke writes without a workdir, so in the documented configuration where `RELAY_MEMORY_ALLOWED_WORKDIRS` is set, `MemoryStore.remember()` rejects them as cross-workdir access. A healthy install in an allowed cwd will report critical `remember`/`db-roundtrip` failures unless the verify checks pass `io.cwd` through.

- [P2] Make hook uninstall a missing-file no-op — /Users/ghanavati/ai-stack/Projects/Relay/src/cli/cmd-memory-ops.ts:301-301
  In uninstall mode with no existing settings file, `raw` stays undefined and the code reaches this `writeFile` without creating the `.claude` directory. On a fresh project or fresh `$HOME`, `relay setup --clean`/`relay memory hook --uninstall` throws ENOENT instead of being the advertised idempotent no-op.

- [P2] Split allowed workdirs on colons — /Users/ghanavati/ai-stack/Projects/Relay/src/cli/cmd-doctor.ts:332-332
  `RELAY_MEMORY_ALLOWED_WORKDIRS` is documented and enforced elsewhere as colon-separated, but this doctor check splits on commas. With the normal value `/proj/a:/proj/b`, doctor checks a single nonexistent `/proj/a:/proj/b/.relay/auto-extract.json` path and reports consent missing even when both projects have consent files.

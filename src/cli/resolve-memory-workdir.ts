/**
 * T50: Resolve the effective `--workdir` for `relay memory recall` and
 * `relay memory show-context`.
 *
 * Rules:
 *   - If the user passes `--workdir <path>` (non-empty), that always wins.
 *   - If `--workdir` is omitted (or passed as an empty string) AND
 *     `RELAY_MEMORY_ALLOWED_WORKDIRS` is set in the environment, default to
 *     `cwd` so the recall lands in the active project rather than failing the
 *     allow-list guard with a generic global lookup.
 *   - Otherwise return `undefined` so the call falls through to global memories.
 *
 * Lives in its own module so tests can import it without triggering the
 * top-level `main()` execution side-effect of `src/cli.ts`.
 */
export function resolveMemoryWorkdir(
  workdirFlag: string | undefined,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  // Treat empty-string --workdir the same as "not provided" so a stray
  // `--workdir ''` does not bypass the env-driven default.
  const provided = workdirFlag && workdirFlag.length > 0 ? workdirFlag : undefined;
  if (provided !== undefined) return provided;
  const allowList = env['RELAY_MEMORY_ALLOWED_WORKDIRS'];
  if (allowList && allowList.length > 0) return cwd;
  return undefined;
}

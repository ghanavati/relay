/** Default Codex delegation timeout: 10 minutes */
export const DEFAULT_TIMEOUT_MS = 600_000;

/** Token count at which a warning is added to meta.warnings */
export const TOKEN_WARN_THRESHOLD = 10_000;

/** Hard cap: output truncated at this token count */
export const TOKEN_HARD_CAP = 25_000;

/** Minimum supported Codex CLI version */
export const MIN_CODEX_VERSION: readonly [number, number, number] = [0, 39, 0];

/** Env var: path to a JSON file mapping model names to per-1k-token prices */
export const COST_TABLE_PATH_ENV = 'RELAY_COST_TABLE_PATH';

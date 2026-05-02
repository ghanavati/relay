import type { WriteStream } from "node:fs";
import type { RelayError } from "../errors.js";
import type { ResolvedMcpAttachment } from "../contracts/mcp.js";

export type WorkerStatus = "success" | "error" | "timeout";

export interface WorkerTask {
  task: string;
  contextPrefix?: string; // Stable context layers for Anthropic prompt caching (bare task must be used when set)
  workdir: string;
  timeout_ms: number;
  model?: string;
  reasoning_effort?: string;
  codex_approval_policy?: string;
  mcps?: ResolvedMcpAttachment[];
  images?: string[];  // Optional image URLs for multimodal requests (OpenRouter/LM Studio only)
  logStream?: WriteStream;
  onStderr?: (text: string) => void;
  run_id: string;
  provider: string;
}

export interface WorkerResult {
  status: WorkerStatus;
  output: string;
  duration_ms: number;
  exit_code: number | null;
  error?: RelayError;
  token_usage?: number | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  cost_usd?: number | null;
  thinking_blocks?: number;
  tool_use_blocks?: number;
  file_reads_before_first_write?: number;
  tool_retry_count?: number;
}

export interface DelegateMeta {
  duration_ms: number;
  truncated: boolean;
  warnings: string[];
  model: string | null;
  token_estimate: number;
  exit_code: number | null;
  log_file: string;
  run_id: string;
  provider: string;
  spawn_time_ms: number | null;
  token_usage: number | null;
  context_injected: boolean;
  active_context_layers: string[];
  active_skills: string[];
  active_design_profile: string | null;
  active_command_pack: string | null;
  circuit_breaker_triggered?: boolean;
  original_model?: string;
}

export interface DelegateResponse {
  status: WorkerStatus;
  output: string;
  files_changed: string[];
  meta: DelegateMeta;
  error?: RelayError;
}

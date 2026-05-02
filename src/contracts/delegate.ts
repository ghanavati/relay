import { isAbsolute } from "node:path";
import { z } from "zod";
import { DEFAULT_PROVIDER } from "../config/providers.js";
import { mcpsSchema } from "./mcp.js";

export const baseTaskSchemaShape = {
  task: z.string().min(1).describe("The coding task to delegate to the worker"),
  workdir: z
    .string()
    .refine((p) => isAbsolute(p), {
      message: "workdir must be an absolute path",
    })
    .describe("Absolute path to the working directory"),
  provider: z
    .string()
    .optional()
    .default(DEFAULT_PROVIDER)
    .describe(
        "Worker provider. 'codex', 'openrouter', 'lmstudio', and 'anthropic' all run through relay's " +
        "agentic execution layer. Dynamic: set RELAY_PROVIDER_<NAME>_URL plus optional " +
        "RELAY_PROVIDER_<NAME>_TYPE to add local or hosted providers in supported protocol " +
        "families (today: openai chat-completions, openai responses, and anthropic)."
    ),
  model: z
    .string()
    .optional()
    .describe(
      "Model override. Optional for 'codex' (known models: gpt-5.4, gpt-5.3-codex, gpt-5.2-codex, gpt-5.1-codex-max, gpt-5.1-codex, gpt-5-codex). Required for all non-codex providers (pass an explicit provider model ID)."
    ),
  reasoning_effort: z
    .enum(["xhigh", "high", "medium"])
    .optional()
    .describe(
      "Reasoning effort for the model. Applies to Codex via -c model_reasoning_effort=<value>. Ignored for other providers. Defaults to provider config if omitted."
    ),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Wall-clock timeout in milliseconds (default: 600000)"),
  mcps: mcpsSchema.describe(
    "Optional MCP attachments. Legacy string entries remain supported for plain URLs. Structured entries can include url, label, inline headers, and headers_env for protected MCP endpoints. Codex forwards plain URLs natively via --mcp-server; relay-bridged providers can use authenticated attachments."
  ),
  skills: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Optional installed skill pack IDs to activate for this run. Packs load file-based guidance layers from .relay/skill-packs and can require tool namespaces such as figma or pencil."
    ),
  design_profile: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional installed design profile ID. Profiles can target tool namespaces such as figma, pencil, or paper and activate their own layers plus referenced skill packs."
    ),
  command_pack: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional installed command-pack ID. Command packs load shared orchestration layers from .relay/command-packs so CLI/manual and MCP-driven clients can activate the same Relay-native command contract."
    ),
  codex_approval_policy: z
    .string()
    .optional()
    .describe("Optional Codex approval policy override (forwarded to the installed Codex CLI approval flag)"),
  images: z
    .array(z.string().url("images entries must be valid URLs"))
    .optional()
    .describe(
      "Optional image URLs included in the multimodal request. OpenRouter/LM Studio and " +
        "OpenAI-family dynamic providers may support them, Anthropic-family providers return UNSUPPORTED, and Codex ignores them with a warning."
    ),
  idempotency_key: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional caller-provided key. If provided and previously seen, returns the original run_id instead of creating a new run. Use to safely retry delegate calls without duplicating work."
    ),
  capabilities: z
    .array(z.enum(['file_write', 'commit', 'grounding_required']))
    .optional()
    .describe(
      "Task capability requirements. 'file_write' = worker will modify files. " +
      "'commit' = worker will create git commits. 'grounding_required' = worker must not hallucinate."
    ),
  risk: z
    .enum(['low', 'standard', 'critical'])
    .optional()
    .describe(
      "Caller-supplied risk floor. Relay infers risk from capabilities — this can only raise it, never lower it."
    ),
  allow_fallback: z
    .boolean()
    .optional()
    .describe(
      "For standard-risk tasks: allow dispatch to workers with no evidence yet. " +
      "Has no effect on critical-risk tasks."
    ),
  async: z
    .boolean()
    .optional()
    .describe(
      "If true, dispatch runs in the background. Returns { job_id, task_id, status: 'queued' } immediately " +
      "instead of waiting for completion. Poll job status with `relay-mcp get-run <job_id> --json`. MRM-07 / R-05."
    ),
  model_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional model registry ID. When provided, relay checks if the model is overdue for revalidation " +
      "and includes an overdue_model_warning in the response. MRM-06 / R-06."
    ),
  // R-22 — Hybrid Model Adapters: inline command for process provider
  command: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Shell command to run when provider is 'process'. The command is split on spaces into executable + args " +
      "(e.g. 'Rscript model.R inputs.csv'). Stdout is captured as the run output. Required when provider='process'."
    ),
  // SHIP-38 — W3C-style causal trace ID for audit chain queries
  trace_id: z
    .string()
    .uuid()
    .optional()
    .describe(
      "Optional W3C-style trace context ID (UUID v4). All run_events for this run share this trace_id, enabling " +
      "causal chain queries across related delegate calls. Auto-generated if not supplied."
    ),
  // SHIP-40 — content-addressable idempotent skip
  idempotent: z
    .boolean()
    .optional()
    .describe(
      "If true, compute a semantic hash of (task + workdir + provider + model). If a successful run with the same " +
      "hash exists within the last 24 hours, return it immediately without dispatching. Safe for read-only or " +
      "deterministic tasks. Not suitable for tasks that modify state on every run."
    ),
  // SHIP-104 — seed-based determinism caching
  seed: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional seed string for reproducible caching. Same task + same seed returns cached output if a successful run with that seed exists (no time window — persists across sessions). Useful for eval frameworks that need deterministic worker outputs."
    ),
  // SHIP-71 — per-call context injection mode
  context_mode: z
    .enum(['full', 'minimal'])
    .optional()
    .describe(
      "Context injection mode. 'full' (default): inject AGENTS.md, recalled lessons, run history, " +
      "design profile, command pack, skill packs, plugin layers, caller context. Best for orchestrated " +
      "workers that need full project context. 'minimal': inject only worker_constraints — best for " +
      "surgical one-file edits on smaller local models (drops ~10K tokens per dispatch, unblocks " +
      "concurrent LM Studio lanes)."
    ),
  // SHIP-98 — circuit breaker: auto-route to fallback on step_change trajectory
  fallback_model: z
    .string()
    .optional()
    .describe(
      "If the requested model's drift trajectory is step_change with high confidence, relay will route to this model instead and set circuit_breaker_triggered:true in the response."
    ),
  quality_gate: z
    .enum(['strict', 'standard', 'none'])
    .optional()
    .describe(
      "Quality gate mode. 'strict': trigger on step_change with medium or high confidence. 'standard' (default): trigger on step_change with high confidence only. 'none': disable circuit breaker."
    ),
  // Oneshot template interpolation — {{ key }} substitution in task strings
  template_args: z
    .record(z.string())
    .optional()
    .describe(
      "Optional key-value map for {{ key }} placeholder substitution in the task string. " +
      "Placeholders use double-brace syntax: '{{ key }}'. Missing keys throw INVALID_ARGS before dispatch. " +
      "Useful for reusable task templates where caller supplies variable parts."
    ),
  // SHIP-22 — confidential/restricted mode
  sensitivity_class: z
    .enum(['standard', 'restricted'])
    .optional()
    .describe(
      "Sensitivity class for this task. 'restricted': enforces local-only execution — blocks all remote providers " +
      "(codex, openrouter, anthropic) and non-localhost MCP attachments, and strips run_history + recalled_lessons " +
      "context layers from the dispatch. Defaults to RELAY_DEFAULT_SENSITIVITY_CLASS env var, or 'standard' if unset."
    ),
} as const;

const delegateSchemaShape = {
  task: baseTaskSchemaShape.task,
  workdir: baseTaskSchemaShape.workdir,
  provider: baseTaskSchemaShape.provider,
  context: z
    .string()
    .optional()
    .describe("Additional context prepended to the task before delegation"),
  timeout_ms: baseTaskSchemaShape.timeout_ms,
  model: baseTaskSchemaShape.model,
  reasoning_effort: baseTaskSchemaShape.reasoning_effort,
  mcps: baseTaskSchemaShape.mcps,
  skills: baseTaskSchemaShape.skills,
  design_profile: baseTaskSchemaShape.design_profile,
  command_pack: baseTaskSchemaShape.command_pack,
  codex_approval_policy: baseTaskSchemaShape.codex_approval_policy,
  images: baseTaskSchemaShape.images,
  idempotency_key: baseTaskSchemaShape.idempotency_key,
  capabilities: baseTaskSchemaShape.capabilities,
  risk: baseTaskSchemaShape.risk,
  allow_fallback: baseTaskSchemaShape.allow_fallback,
  async: baseTaskSchemaShape.async,
  model_id: baseTaskSchemaShape.model_id,
  command: baseTaskSchemaShape.command,
  trace_id: baseTaskSchemaShape.trace_id,
  idempotent: baseTaskSchemaShape.idempotent,
  seed: baseTaskSchemaShape.seed,
  context_mode: baseTaskSchemaShape.context_mode,
  fallback_model: baseTaskSchemaShape.fallback_model,
  quality_gate: baseTaskSchemaShape.quality_gate,
  template_args: baseTaskSchemaShape.template_args,
  sensitivity_class: baseTaskSchemaShape.sensitivity_class,
} as const;

const delegateArgsSchema = z.object(delegateSchemaShape);

export const delegateSchema = delegateArgsSchema.shape;

/**
 * DelegateArgs — parsed delegate tool arguments.
 * The `_run_id_override` field is internal (not in Zod schema) and lets the
 * async dispatch path pre-allocate a run_id for task result correlation.
 */
export type DelegateArgs = z.infer<typeof delegateArgsSchema> & {
  _run_id_override?: string;
};

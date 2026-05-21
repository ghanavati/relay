import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
// Solo Relay v0.1.0 — command-packs, skill-packs, plugin-layers, graph-context
// providers are not part of the solo distro. Stub minimal types so the module
// compiles. The relay-mcp parent project keeps the rich versions.
class CommandPackError extends Error {}
class SkillPackError extends Error {}
async function loadActivatedCommandPack(
  _args: { workdir: string; commandPack?: string }
): Promise<{ layers: ContextLayer[] } | null> {
  return null;
}
async function loadActivatedSkillLayers(_args: {
  workdir: string;
  skills?: string[];
  availableNamespaces: string[];
}): Promise<{ packs: never[]; layers: ContextLayer[] }> {
  return { packs: [], layers: [] };
}
async function loadPluginLayers(_args: unknown): Promise<ContextLayer[]> {
  return [];
}
function createGraphContextLayerProvider(): ContextLayerProvider {
  return {
    id: 'graph_context',
    async load(): Promise<ContextLayer | null> {
      return null;
    },
  };
}
import { createBriefLayerProvider } from "./brief-layer.js";
import { createRunHistoryLayerProvider } from "./run-history-layer.js";
import { createSessionScopeLayerProvider } from './session-scope-layer.js';
import { createCorpusLayerProvider } from './corpus-layer.js';
import { isTruthy } from "./utils.js";
import { filterLayersByRelevance } from './relevance-filter.js';
import { classifyTaskComplexity, getAllowedLayersForTier } from './complexity-classifier.js';

export const LAYER_NAMES = [
  "eval_criteria",
  "recalled_lessons",
  "worker_constraints",
  "agents",
  "project_knowledge",
  "graph_context",
  "run_history",
  "session_scope",
  "corpus_rag",
] as const;
const execFileAsync = promisify(execFile);
export const CONTEXT_LAYER_CONFIG_PATH = ".relay/context-layers.json";

export interface ContextLayer {
  id: string;
  content: string;
}

export interface ContextLayerProvider {
  id: string;
  load(args: { workdir: string; context?: string }): Promise<ContextLayer | null>;
}

interface ContextLayerFileConfig {
  id: string;
  filename: string;
}

export class ContextLayerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextLayerConfigError";
  }
}

export class DelegatedTaskConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DelegatedTaskConfigError";
  }
}

async function findTraversalCap(workdir: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd: workdir,
      encoding: "utf8",
    });
    return stdout.trim();
  } catch {
    return resolve(workdir);
  }
}

async function readNearestFile(filename: string, workdir: string): Promise<string | null> {
  const traversalCap = await findTraversalCap(workdir);
  let current = resolve(workdir);

  while (true) {
    try {
      const content = (await fs.readFile(join(current, filename), "utf8")).trim();
      if (content.length > 0) return content;
    } catch {
      // Continue traversing to parent.
    }

    if (current === traversalCap) return null;
    const parent = dirname(current);
    if (parent === current) return null;
    if (parent !== traversalCap && !parent.startsWith(traversalCap + sep)) return null;
    current = parent;
  }
}

function createNearestFileContextLayerProvider(
  id: string,
  filename: string
): ContextLayerProvider {
  return {
    id,
    async load(args: { workdir: string }): Promise<ContextLayer | null> {
      const content = await readNearestFile(filename, args.workdir);
      return content ? { id, content } : null;
    },
  };
}

function createWorkerConstraintsLayerProvider(): ContextLayerProvider {
  return {
    id: 'worker_constraints',
    async load(): Promise<ContextLayer | null> {
      return {
        id: 'worker_constraints',
        content: `## Relay Worker Constraints (enforced by orchestrator — non-negotiable)

You are a bounded relay worker. Your orchestrator has already provided all context you need.

DO NOT:
- Load \`using-superpowers\`, \`tdd-guide\`, or any other skill — your orchestrator controls skills
- Run \`npm run build\`, \`npm test\`, or any test suite unless the task explicitly requires it
- Call \`relay remember\`, \`relay recall\`, or any memory tools
- Read files outside of what the task specifies
- Follow TDD, security review, or any autonomous workflow not given in this task

DO:
- Execute exactly what the task says — no more, no less
- Write exactly the files the task specifies
- Commit with the exact message given (if a commit is required)
- Stop when the task is complete`,
      };
    },
  };
}

function createEvalCriteriaLayerProvider(): ContextLayerProvider {
  return {
    id: 'eval_criteria',
    async load(): Promise<ContextLayer | null> {
      if (!isTruthy(process.env['RELAY_EVAL_CRITERIA'])) return null;
      return {
        id: 'eval_criteria',
        content: '## Evaluation Criteria (reviewer will reject if any fail)\n\n- **Correctness**: output does exactly what the task asked — no more, no less\n- **Completeness**: all requirements addressed, nothing missing\n- **No regressions**: existing tests pass, existing behavior preserved',
      };
    },
  };
}

function createCallerContextLayerProvider(): ContextLayerProvider {
  return {
    id: "caller_context",
    async load(args: { context?: string }): Promise<ContextLayer | null> {
      const content = args.context?.trim();
      return content ? { id: "caller_context", content } : null;
    },
  };
}

/**
 * Guard memory content before injecting into worker prompts.
 *
 * Removes markdown headers that could hijack the injected section structure,
 * strips HTML tags, and neutralises common prompt-injection phrases. This is a
 * defence-in-depth measure — sanitizeContent() in MemoryStore already caps
 * length and strips <private> blocks at write time. This guard runs at read time
 * so content written before that protection was added is also covered.
 */
const INJECTION_PHRASES = /\b(ignore|disregard)\s+(all\s+)?(previous|above|prior)\s+(instructions?|text|context|prompt)\b/gi;

function guardMemoryContent(raw: string): string {
  return raw
    .replace(/^#{1,6}\s+/gm, '')          // strip markdown headers
    .replace(/<[^>]{0,200}>/g, '')         // strip HTML-like tags (bounded length)
    .replace(INJECTION_PHRASES, '[redacted]')
    .trim();
}

export async function loadRecalledLessonsContent(
  workdir: string,
  task?: string,
  run_id?: string,
  opts?: {
    types?: readonly ("lesson" | "decision" | "fact" | "context" | "state" | "handoff" | "session")[];
    tokenBudget?: number;
    /**
     * T1 — minimum trust tier filter. When set, MemoryStore.getCandidates
     * applies the same SQL guard used by `relay memory recall --min-trust=…`:
     *   - 'trusted'     → only trusted entries
     *   - 'provisional' → provisional + trusted (excludes unverified)
     *   - 'unverified'  → no filter (all tiers)
     * Undefined preserves prior behaviour (no filter).
     */
    minTrust?: 'unverified' | 'provisional' | 'trusted';
  }
): Promise<string | null> {
  const { MemoryStore } = await import("../memory/memory-store.js");
  const { budgetedRecall } = await import("../memory/memory-engine.js");
  const { computeSemanticSimilarities } = await import("../memory/semantic-similarities.js");
  const store = new MemoryStore();
  const query = {
    types: opts?.types ?? (["lesson", "decision"] as const),
    workdir,
    token_budget: opts?.tokenBudget ?? 800,
    // Pass task text so FTS5 returns task-relevant memories, not just most-recent
    ...(task?.trim() ? { query: task.trim() } : {}),
    // T1 — pass-through to MemoryStore.getCandidates() trust-tier filter.
    ...(opts?.minTrust !== undefined ? { min_trust: opts.minTrust } : {}),
  };
  const candidates = store.getCandidates(query);
  if (candidates.length === 0) return null;
  // PLAN-4 T6 — Compute semantic similarities at impure boundary BEFORE scoring.
  // Empty Map (returned when RELAY_EMBEDDING_MODEL is unset or LM Studio unreachable)
  // makes the engine fall through to word-overlap. Never throws.
  const similarities = await computeSemanticSimilarities(store, query, candidates);
  const result = budgetedRecall(candidates, query, Date.now(), similarities);
  if (result.memories.length === 0) return null;

  const accessedIds = result.memories.map(m => m.memory_id);
  if (run_id) {
    const { RunStore } = await import('../runtime/store/run-store.js');
    new RunStore().setRecalledMemories(run_id, accessedIds);
  }
  store.logReads(accessedIds, { run_id, source: 'context-layer', workdir });

  // Failure-first: surface failure lessons before success/skill lessons so workers
  // see "this approach failed" before "this approach worked" — prevents repeating
  // failed patterns (AutoHypothesis: don't repeat without new justification).
  const sorted = [...result.memories].sort((a, b) => {
    const aFailed = a.tags.includes('failure');
    const bFailed = b.tags.includes('failure');
    if (aFailed && !bFailed) return -1;
    if (!aFailed && bFailed) return 1;
    return 0;
  });

  // PLAN-5 T6 — Build id → 1-based index map ONCE over the rendered list, so
  // each row's annotations (carrying raw memory_id UUIDs from the engine
  // layer) can be translated to `#N` references. Lookup uses the FINAL render
  // order (post failure-first sort), not the engine's score order.
  const idToIndex = new Map<string, number>();
  for (let i = 0; i < sorted.length; i++) {
    idToIndex.set(sorted[i]!.memory_id, i + 1);
  }

  const lines = sorted.map((memory, index) => {
    // SHIP-67 — unverified memories get a visible warning prefix so the worker can
    // weight them appropriately. Failure lessons still surface with their own marker.
    const unverifiedMarker = memory.trust_level === 'unverified' ? '[UNVERIFIED]' : '';
    const failureMarker = memory.tags.includes('failure') ? '⚠ FAILED:' : '';

    // PLAN-5 T6 — translate engine-layer annotations (raw UUIDs) to `#N`
    // 1-based indices into the rendered list. Drop annotations whose peer is
    // not in the rendered list (dangling reference, e.g. peer filtered by
    // MIN_RELEVANCE_SCORE). Strict regex anchored to known prefixes prevents
    // false rewrites of unrelated `⚠` markers.
    const conflictMarkers: string[] = [];
    for (const ann of memory.annotations ?? []) {
      const m = ann.match(/^(⚠ (?:CONFLICTS WITH|CONTRADICTED BY)) ([0-9a-fA-F-]{36})$/);
      if (!m) continue;
      const peerIdx = idToIndex.get(m[2]!);
      if (peerIdx === undefined) continue; // dangling — skip gracefully
      conflictMarkers.push(`${m[1]} #${peerIdx}`);
    }
    const conflictMarker = conflictMarkers.join(' ');

    const prefix = [unverifiedMarker, failureMarker, conflictMarker]
      .filter(Boolean)
      .join(' ');
    const separator = prefix.length > 0 ? ' ' : '';
    return `${index + 1}. ${prefix}${separator}${guardMemoryContent(memory.content)}`;
  });
  return `## Recalled Lessons (read before starting — learned from past failures)\n\n${lines.join("\n")}`;
}

function createRecalledLessonsLayerProvider(): ContextLayerProvider {
  return {
    id: "recalled_lessons",
    async load(args: { workdir: string; task?: string; run_id?: string }): Promise<ContextLayer | null> {
      if (!isTruthy(process.env["RELAY_RECALLED_LESSONS"])) return null;
      try {
        const content = await loadRecalledLessonsContent(args.workdir, args.task, args.run_id);
        return content ? { id: "recalled_lessons", content } : null;
      } catch {
        return null;
      }
    },
  };
}

async function loadAdditionalContextLayerConfigs(workdir: string): Promise<ContextLayerFileConfig[]> {
  const raw = await readNearestFile(CONTEXT_LAYER_CONFIG_PATH, workdir);
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new ContextLayerConfigError(
      `${CONTEXT_LAYER_CONFIG_PATH} contains invalid JSON: ${String(error)}`
    );
  }

  if (!Array.isArray(parsed)) {
    throw new ContextLayerConfigError(`${CONTEXT_LAYER_CONFIG_PATH} must be a JSON array`);
  }

  return parsed.flatMap((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new ContextLayerConfigError(`${CONTEXT_LAYER_CONFIG_PATH}[${index}] must be an object`);
    }
    const id = typeof (entry as { id?: unknown }).id === "string" ? (entry as { id: string }).id.trim() : "";
    const filename =
      typeof (entry as { filename?: unknown }).filename === "string"
        ? (entry as { filename: string }).filename.trim()
        : "";

    if (!id || !filename) {
      throw new ContextLayerConfigError(
        `${CONTEXT_LAYER_CONFIG_PATH}[${index}] must include non-empty id and filename`
      );
    }

    return [{ id, filename }];
  });
}

function dedupeProviders(providers: ContextLayerProvider[]): ContextLayerProvider[] {
  const seen = new Set<string>();
  const deduped: ContextLayerProvider[] = [];
  for (const provider of providers) {
    if (seen.has(provider.id)) continue;
    seen.add(provider.id);
    deduped.push(provider);
  }
  return deduped;
}

function createAgentsLayerProvider(): ContextLayerProvider {
  return {
    id: "agents",
    async load(args: { workdir: string }): Promise<ContextLayer | null> {
      // SHIP-51 — Three-tier fallback ordered by token-cost ascending:
      //   1. WORKERS.md (~6k) — purpose-built for workers, only code rules + API patterns.
      //      Repos that have one opt in to the reduced-context path.
      //   2. AGENTS-COMPACT.md (~29k) — caveman-compressed full context (~46% smaller than AGENTS.md).
      //   3. AGENTS.md (~48k) — full human-readable source.
      // CC still reads AGENTS.md / CLAUDE.md for orchestration; this injection is for dispatched workers.
      const workers = await readNearestFile("WORKERS.md", args.workdir);
      if (workers) return { id: "agents", content: workers };
      const compact = await readNearestFile("AGENTS-COMPACT.md", args.workdir);
      if (compact) return { id: "agents", content: compact };
      const full = await readNearestFile("AGENTS.md", args.workdir);
      return full ? { id: "agents", content: full } : null;
    },
  };
}

export async function listContextLayerProviders(workdir: string): Promise<ContextLayerProvider[]> {
  const additionalConfigs = await loadAdditionalContextLayerConfigs(workdir);
  const corpusName = process.env['RELAY_CORPUS_LAYER'];
  return dedupeProviders([
    createEvalCriteriaLayerProvider(),
    createRecalledLessonsLayerProvider(),
    createWorkerConstraintsLayerProvider(),
    createAgentsLayerProvider(),
    createBriefLayerProvider(),
    createGraphContextLayerProvider(),
    createRunHistoryLayerProvider(),
    createSessionScopeLayerProvider(),
    ...(corpusName ? [createCorpusLayerProvider(corpusName)] : []),
    ...additionalConfigs.map((entry) => createNearestFileContextLayerProvider(entry.id, entry.filename)),
  ]);
}

const RESTRICTED_BLOCKED_LAYER_IDS = new Set(['run_history', 'recalled_lessons']);

export async function loadContextLayers(args: {
  workdir: string;
  task?: string;
  context?: string;
  skills?: string[];
  availableNamespaces?: string[];
  extraLayers?: ContextLayer[];
  commandPack?: string;
  run_id?: string;
  context_mode?: 'full' | 'minimal';
  sensitivity_class?: 'standard' | 'restricted';
}): Promise<ContextLayer[]> {
  const isMinimal = args.context_mode === 'minimal';
  const providers = await listContextLayerProviders(args.workdir);

  let effectiveProviders;
  if (isMinimal) {
    // SHIP-71 — minimal mode: inject only worker_constraints. Drops ~10K tokens per
    // dispatch vs full mode. Intended for surgical edits on small local models
    // (LM Studio GLM/qwen3) where full AGENTS.md context overwhelms the model.
    effectiveProviders = providers.filter(p => p.id === 'worker_constraints');
  } else {
    // SHIP-25: Skip bulk layers for simple tasks (gated by RELAY_COMPLEXITY_TIERS=1)
    const tier = process.env['RELAY_COMPLEXITY_TIERS'] === '1'
      ? classifyTaskComplexity(args.task ?? '')
      : 'moderate';
    const allowedIds = getAllowedLayersForTier(tier);
    effectiveProviders = allowedIds ? providers.filter(p => allowedIds.has(p.id)) : providers;
  }

  // SHIP-22 — restricted mode: strip run_history + recalled_lessons to prevent task content exfil
  if (args.sensitivity_class === 'restricted') {
    effectiveProviders = effectiveProviders.filter(p => !RESTRICTED_BLOCKED_LAYER_IDS.has(p.id));
  }

  let layers: ContextLayer[] = [];
  for (const provider of effectiveProviders) {
    const layer = await provider.load(args);
    if (layer) layers.push(layer);
  }

  // design_profile layers (passed via args.extraLayers) are always honored even in minimal mode —
  // they encode explicit caller intent (figma/pencil/paper namespaces) and are small. Skipping
  // them would silently produce wrong output for callers using both design_profile + minimal.
  if (args.extraLayers?.length) {
    layers.push(...args.extraLayers);
  }

  // Full-mode augmentations: relevance filter + command_pack + skills + plugins + caller.
  // Minimal mode skips these to keep injected context <1K tokens.
  if (isMinimal) return layers;

  // SHIP-21: Drop off-topic optional layers (gated by RELAY_CONTEXT_MIN_RELEVANCE)
  const minRelevance = parseFloat(process.env['RELAY_CONTEXT_MIN_RELEVANCE'] ?? '0');
  if (minRelevance > 0 && args.task) {
    layers = filterLayersByRelevance(layers, args.task, minRelevance);
  }
  try {
    const commandPack = await loadActivatedCommandPack({
      workdir: args.workdir,
      commandPack: args.commandPack,
    });
    if (commandPack) {
      layers.push(...commandPack.layers);
    }
  } catch (error) {
    if (error instanceof CommandPackError) {
      throw new DelegatedTaskConfigError(error.message);
    }
    throw error;
  }
  try {
    const skillLayers = await loadActivatedSkillLayers({
      workdir: args.workdir,
      skills: args.skills,
      availableNamespaces: args.availableNamespaces ?? [],
    });
    layers.push(...skillLayers.layers);
  } catch (error) {
    if (error instanceof SkillPackError) {
      throw new DelegatedTaskConfigError(error.message);
    }
    throw error;
  }
  const pluginLayers = await loadPluginLayers(args.workdir);
  layers.push(...pluginLayers);
  const callerLayer = await createCallerContextLayerProvider().load(args);
  if (callerLayer) layers.push(callerLayer);
  return layers;
}

function getContextLayerMaxChars(): number {
  const raw = process.env["RELAY_CONTEXT_LAYER_MAX_CHARS"];
  if (!raw) return 100_000;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed <= 0) return 100_000;
  return parsed;
}

function layerProvenance(layer: ContextLayer): string {
  const hash = createHash("sha256").update(layer.content).digest("hex").slice(0, 8);
  return `<!-- layer:${layer.id} hash:${hash} chars:${layer.content.length} -->`;
}

function capLayerContent(layer: ContextLayer, maxChars: number): ContextLayer {
  if (layer.content.length <= maxChars) return layer;
  const truncated = layer.content.slice(0, maxChars);
  const warning = `\n\n<!-- TRUNCATED: layer "${layer.id}" exceeded ${maxChars} char limit (was ${layer.content.length} chars) -->`;
  return { ...layer, content: truncated + warning };
}

export const LESSON_PROMPT_SUFFIX = `## After completing your task

Before committing your final changes, call \`relay remember\` with:
1. What the task was (1 sentence)
2. Whether it succeeded, timed out, or partially completed
3. The single most useful thing you learned about this codebase or about working with relay
4. If you timed out: what you DID complete vs what remains

Use memory_type "lesson". Include a tag with key prefix "orch:" for relay/coordination lessons, "code:" for codebase facts.
Example: memory_type="lesson", tags=["code:better-sqlite3"], content="better-sqlite3 is SYNCHRONOUS — never use async/await on DB calls"`;

export async function buildDelegatedTask(args: {
  workdir: string;
  context?: string;
  task: string;
  skills?: string[];
  availableNamespaces?: string[];
  extraLayers?: ContextLayer[];
  commandPack?: string;
  run_id?: string;
  context_mode?: 'full' | 'minimal';
  sensitivity_class?: 'standard' | 'restricted';
}): Promise<{
  finalTask: string;
  bareTask: string;
  contextPrefix: string;
  activeContextLayers: string[];
  contextInjected: boolean;
  activeSkills: string[];
  activeCommandPack: string | null;
}> {
  const layers = await loadContextLayers({
    workdir: args.workdir,
    task: args.task,
    context: args.context,
    skills: args.skills,
    availableNamespaces: args.availableNamespaces,
    extraLayers: args.extraLayers,
    commandPack: args.commandPack,
    run_id: args.run_id,
    context_mode: args.context_mode,
    sensitivity_class: args.sensitivity_class,
  });
  const maxChars = getContextLayerMaxChars();
  const processedLayers = layers.map((layer) => {
    const capped = capLayerContent(layer, maxChars);
    return `${layerProvenance(capped)}\n${capped.content}`;
  });
  const activeSkills = layers
    .filter((layer) => layer.id.startsWith("skill:"))
    .map((layer) => layer.id.split(":")[1] ?? "")
    .filter((value, index, all) => value.length > 0 && all.indexOf(value) === index);
  const activeCommandPack =
    layers
      .find((layer) => layer.id.startsWith("command_pack:"))
      ?.id.split(":")[1] ?? null;
  const contextPrefix = processedLayers.join("\n\n");
  return {
    finalTask: contextPrefix ? `${contextPrefix}\n\n${args.task}` : args.task,
    bareTask: args.task,
    contextPrefix,
    activeContextLayers: layers.map((layer) => layer.id),
    contextInjected: layers.some((layer) => layer.id === "agents"),
    activeSkills,
    activeCommandPack,
  };
}

export async function readNearestAgentsMd(workdir: string): Promise<string | null> {
  return readNearestFile("AGENTS.md", workdir);
}

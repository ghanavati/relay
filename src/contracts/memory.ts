import { z } from 'zod';

// ── remember ───────────────────────────────────────────────────────────────

export const rememberSchema = {
  content: z.string().min(1).max(50_000).describe('The memory content to store'),
  memory_type: z
    .enum(['fact', 'decision', 'lesson', 'context', 'state', 'handoff'])
    .describe('Memory type — controls decay rate and retrieval priority. fact: durable preferences/identity. decision: what was decided and why. lesson: mistakes and corrections. context: working state. state: volatile current task. handoff: session continuity snapshot.'),
  tags: z
    .array(z.string().max(100))
    .max(20)
    .optional()
    .default([])
    .describe('Tags for retrieval filtering (e.g. ["auth", "phase-16"])'),
  pinned: z
    .boolean()
    .optional()
    .default(false)
    .describe('Pinned memories never decay in relevance'),
  source_run_id: z.string().optional().describe('Relay run that produced this memory'),
  workdir: z.string().optional().describe('Project scope. Defaults to relay workdir. Null = global.'),
  expires_in_hours: z
    .number()
    .int()
    .min(1)
    .max(8760)
    .optional()
    .describe('Auto-expire after N hours. Null = never expires.'),
};

export const RememberArgsSchema = z.object(rememberSchema);
export type RememberArgs = z.infer<typeof RememberArgsSchema>;

// ── recall ─────────────────────────────────────────────────────────────────

export const recallSchema = {
  query: z.string().max(1000).optional().describe('Keyword search against memory content'),
  tags: z
    .array(z.string().max(100))
    .max(20)
    .optional()
    .default([])
    .describe('Filter by tags — memories with overlapping tags score higher'),
  types: z
    .array(z.enum(['fact', 'decision', 'lesson', 'context', 'state', 'handoff']))
    .optional()
    .describe('Filter by memory type(s)'),
  token_budget: z
    .number()
    .int()
    .min(100)
    .max(50_000)
    .describe('Hard cap on total tokens returned. Forces callers to think about context cost.'),
  workdir: z.string().optional().describe('Project scope. Defaults to relay workdir. Pass "*" for all projects.'),
  include_expired: z.boolean().optional().default(false).describe('Include expired memories'),
  created_after: z.number().int().optional().describe('Lower bound on created_at (epoch ms)'),
  created_before: z.number().int().optional().describe('Upper bound on created_at (epoch ms)'),
  file: z.string().optional().describe('SHIP-52: restrict to memories associated with this file path (auto-written by run-recorder)'),
  min_trust: z
    .enum(['unverified', 'provisional', 'trusted'])
    .optional()
    .describe('T2: minimum trust tier — provisional excludes raw auto-extracted entries, trusted only returns human-pinned/proven entries'),
};

export const RecallArgsSchema = z.object(recallSchema);
export type RecallArgs = z.infer<typeof RecallArgsSchema>;

// ── get_session_context ────────────────────────────────────────────────────

export const getSessionContextSchema = {
  token_budget: z
    .number()
    .int()
    .min(500)
    .max(50_000)
    .optional()
    .default(4000)
    .describe('Max tokens for the entire session context payload (default 4000)'),
  workdir: z.string().optional().describe('Project scope. Defaults to relay workdir.'),
  include_briefing: z
    .boolean()
    .optional()
    .default(true)
    .describe('Include relay run/verification/worker briefing data'),
};

export const GetSessionContextArgsSchema = z.object(getSessionContextSchema);
export type GetSessionContextArgs = z.infer<typeof GetSessionContextArgsSchema>;

// ── get_memory ─────────────────────────────────────────────────────────────

export const GetMemoryArgsSchema = z.object({ memory_id: z.string().uuid() });
export type GetMemoryArgs = z.infer<typeof GetMemoryArgsSchema>;

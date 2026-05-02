import { z } from 'zod';

// ── Enums ─────────────────────────────────────────────────────────────────────

export const ExceptionSeveritySchema = z.enum(['critical', 'high', 'medium', 'low'])
  .describe('Risk level of the out-of-boundary use');
export type ExceptionSeverity = z.infer<typeof ExceptionSeveritySchema>;

// ── Tool input schemas ────────────────────────────────────────────────────────

export const logExceptionSchema = z.object({
  model_id:             z.string().min(1).describe('Model used outside its approved boundaries'),
  description:          z.string().min(1).describe('What was done and why it is out of boundary'),
  approver_id:          z.string().min(1).describe('Person/role who approved the exception'),
  compensating_control: z.string().min(1).describe('Control in place while operating out of boundary'),
  severity:             ExceptionSeveritySchema,
  resolution_deadline:  z.number().int().positive().optional()
    .describe('Epoch ms by which the exception must be resolved'),
});
export type LogExceptionArgs = z.infer<typeof logExceptionSchema>;

export const listExceptionsSchema = z.object({
  model_id:         z.string().optional().describe('Filter to a specific model'),
  include_resolved: z.boolean().optional().default(false).describe('Include resolved exceptions (default false)'),
  limit:            z.number().int().min(1).max(500).optional().default(100),
});
export type ListExceptionsArgs = z.infer<typeof listExceptionsSchema>;

export const resolveExceptionSchema = z.object({
  exception_id:     z.string().min(1),
  resolved_by:      z.string().min(1).describe('Person/role completing the resolution'),
  resolution_notes: z.string().min(1).describe('How the exception was remediated'),
});
export type ResolveExceptionArgs = z.infer<typeof resolveExceptionSchema>;

// ── Row type (returned by list) ───────────────────────────────────────────────

export interface ExceptionRow {
  readonly exception_id:        string;
  readonly model_id:            string;
  readonly description:         string;
  readonly approver_id:         string;
  readonly compensating_control: string;
  readonly severity:            ExceptionSeverity;
  readonly resolution_deadline: number | null;
  readonly resolved_at:         number | null;
  readonly resolved_by:         string | null;
  readonly resolution_notes:    string | null;
  readonly created_at:          number;
}

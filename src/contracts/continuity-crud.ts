import { z } from 'zod';

export const createContinuityObjectSchema = {
  kind: z.enum(['HandoffPacket', 'DecisionRecord', 'PromotionRecord', 'Recipe']).describe('Object kind'),
  status: z.string().describe('Initial status (e.g. draft, proposed, pending)'),
  parent_ref: z.string().describe('Required parent reference — run_id or another object_id'),
  payload: z.record(z.unknown()).describe('Full object payload as JSON'),
  source_run_ids: z.array(z.string()).optional().describe('Run IDs that contributed to this object'),
  artifact_refs: z.array(z.string()).optional().describe('Referenced artifact paths'),
  supersedes_ref: z.string().optional().describe('Object ID this supersedes'),
  retention_class: z.enum(['standard', 'extended', 'permanent']).optional().default('standard'),
};

export const CreateContinuityObjectArgsSchema = z.object(createContinuityObjectSchema);
export type CreateContinuityObjectArgs = z.infer<typeof CreateContinuityObjectArgsSchema>;

export const getContinuityObjectSchema = {
  object_id: z.string().uuid('object_id must be a valid UUID'),
};

export const GetContinuityObjectArgsSchema = z.object(getContinuityObjectSchema);
export type GetContinuityObjectArgs = z.infer<typeof GetContinuityObjectArgsSchema>;

export const listContinuityObjectsSchema = {
  kind: z.enum(['HandoffPacket', 'DecisionRecord', 'PromotionRecord', 'Recipe']).describe('Object kind to list'),
  status: z.string().optional().describe('Filter by status'),
  limit: z.number().int().min(1).max(200).optional().default(50),
};

export const ListContinuityObjectsArgsSchema = z.object(listContinuityObjectsSchema);
export type ListContinuityObjectsArgs = z.infer<typeof ListContinuityObjectsArgsSchema>;

export const updateContinuityStatusSchema = {
  object_id: z.string().uuid('object_id must be a valid UUID'),
  new_status: z.string().describe('Target status'),
  updated_payload: z.record(z.unknown()).optional().describe('Optional updated payload'),
};

export const UpdateContinuityStatusArgsSchema = z.object(updateContinuityStatusSchema);
export type UpdateContinuityStatusArgs = z.infer<typeof UpdateContinuityStatusArgsSchema>;

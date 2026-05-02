import { z } from 'zod';

export const amendSignOffSchema = z.object({
  run_id: z.string().min(1),
  new_notes: z.string().min(1),
  amended_by: z.string().min(1),
});

export type AmendSignOffArgs = z.infer<typeof amendSignOffSchema>;

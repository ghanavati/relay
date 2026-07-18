import { readFile } from 'node:fs/promises';
import { z } from 'zod';

import { RelayError } from '../errors.js';

const JsonValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.string(), z.number().finite(), z.boolean(), z.null(),
  z.array(JsonValueSchema), z.record(JsonValueSchema),
]));

const ModelProfileSchema = z.object({
  temperature: z.number().finite().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().max(131_072).optional(),
  max_iterations: z.number().int().positive().max(100).optional(),
  chat_template_kwargs: z.record(JsonValueSchema).optional(),
}).strict();

const ProfileFileSchema = z.object({ models: z.record(ModelProfileSchema) }).strict();

export type ModelInferenceProfile = Readonly<z.infer<typeof ModelProfileSchema>>;

function profilePath(env: NodeJS.ProcessEnv): string | null {
  return env['RELAY_INFERENCE_PROFILES_PATH']?.trim() || null;
}

function parseProfileFile(raw: string, path: string): z.infer<typeof ProfileFileSchema> {
  try {
    return ProfileFileSchema.parse(JSON.parse(raw));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new RelayError('CONFIG_ERROR', `invalid inference profile file ${path}: ${detail}`, false);
  }
}

export async function resolveModelInferenceProfile(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ModelInferenceProfile> {
  const path = profilePath(env);
  if (!path) return {};
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    const detail = error instanceof Error ? error.message : String(error);
    throw new RelayError('CONFIG_ERROR', `could not read inference profile file ${path}: ${detail}`, false);
  }
  return parseProfileFile(raw, path).models[model] ?? {};
}

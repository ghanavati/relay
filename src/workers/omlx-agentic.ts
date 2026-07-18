import { getOmlxApiKey, getOmlxEndpoint } from '../config/providers.js';
import { resolveModelInferenceProfile } from '../config/model-profiles.js';
import {
  LmStudioAgenticRunner,
  type LmStudioAgenticRunnerOpts,
} from './lmstudio-agentic.js';

/** oMLX uses the OpenAI chat-completions wire format but does not expose LM Studio capability metadata. */
export class OmlxAgenticRunner extends LmStudioAgenticRunner {
  constructor(opts: Omit<LmStudioAgenticRunnerOpts, 'endpoint' | 'apiKey' | 'requireToolUseCapability' | 'profileForModel' | 'providerLabel'> = {}) {
    super({
      ...opts,
      endpoint: getOmlxEndpoint,
      apiKey: getOmlxApiKey,
      requireToolUseCapability: false,
      profileForModel: resolveModelInferenceProfile,
      providerLabel: 'oMLX',
    });
  }
}

import { FUNAI_MODEL_PREFIX } from './funAi.js';
import { zhiyingVideoDisplayName } from './zhiyingVideo.js';

/** Public API name; routing, pricing and existing records use their stored IDs. */
export function publicApiModelId(modelId: string): string {
  return zhiyingVideoDisplayName(modelId)
    ?? (modelId.startsWith(FUNAI_MODEL_PREFIX) ? modelId.slice(FUNAI_MODEL_PREFIX.length) : modelId);
}

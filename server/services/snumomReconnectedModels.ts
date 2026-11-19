import type Database from 'better-sqlite3';
import type { ModelSpecification } from '../../shared/modelRouting.js';
import { isReconnectedSnumomRoute, isRetiredVideoModel, isSnumomReconnectChannel,
  SNUMOM_RECONNECT_CHANNEL_ID } from '../../shared/retiredVideoModels.js';

/** Require a saved specification and the exact original binding, never a wildcard or alias. */
export function reconnectedSnumomModels(sqlite: Database.Database): Set<string> {
  const result = new Set<string>();
  try {
    const channel = sqlite.prepare('SELECT id,type,supported_models,model_mapping FROM channels WHERE id=?').get(SNUMOM_RECONNECT_CHANNEL_ID) as
      { id: number; type: string; supported_models: string; model_mapping: string } | undefined;
    if (!channel || !isSnumomReconnectChannel(channel)) return result;
    const row = sqlite.prepare("SELECT value FROM settings WHERE key='model_specification_routes_v1'").get() as { value: string } | undefined;
    const supported = JSON.parse(channel.supported_models || '[]') as string[];
    const mapping = JSON.parse(channel.model_mapping || '{}') as Record<string, string>;
    const specifications = JSON.parse(row?.value || '[]') as ModelSpecification[];
    for (const spec of specifications) {
      if (spec.kind === 'video' && !spec.aliases.length && spec.routes.length === 1
        && isReconnectedSnumomRoute(spec.modelId, spec.routes[0])
        && supported.includes(spec.modelId) && mapping[spec.modelId] === spec.modelId) result.add(spec.modelId);
    }
  } catch {
    // Fail closed if configuration cannot be decoded.
    return new Set();
  }
  return result;
}

export function isBlockedRetiredVideoModel(sqlite: Database.Database, model: unknown): boolean {
  return isRetiredVideoModel(model) && !reconnectedSnumomModels(sqlite).has(model as string);
}

import { sqlite } from '../db/index.js';

/** Only an explicit mapping or a saved route approves a configured model for sync. */
export function configuredSyncBindings(channel: { id: number; supportedModels?: string; modelMapping?: string | null }) {
  const supported = JSON.parse(channel.supportedModels || '[]');
  const mapping = JSON.parse(channel.modelMapping || '{}');
  if (!Array.isArray(supported) || supported.some(id => typeof id !== 'string')
    || !mapping || typeof mapping !== 'object' || Array.isArray(mapping)
    || Object.values(mapping).some(id => typeof id !== 'string')) {
    throw { status: 409, message: '渠道模型关联格式无效，原配置未修改' };
  }
  const bindings = new Map<string, string>();
  for (const [id, upstream] of Object.entries(mapping)) {
    if (typeof upstream === 'string' && id.trim() && upstream.trim() && id.trim() !== '*' && upstream.trim() !== '*') {
      bindings.set(id, upstream);
    }
  }
  const row = sqlite.prepare('SELECT value FROM settings WHERE key=?').get('model_specification_routes_v1') as { value: string } | undefined;
  const specs = JSON.parse(row?.value || '[]');
  for (const spec of specs) for (const route of spec.routes || []) {
    if (route.channelId === channel.id && typeof route.executionModel === 'string' && route.executionModel
      && route.executionModel !== '*' && typeof route.upstreamModel === 'string' && route.upstreamModel && route.upstreamModel !== '*') {
      // Disabled models/routes remain approved; sync must not change their switches.
      if (!bindings.has(route.executionModel)) bindings.set(route.executionModel, route.upstreamModel);
    }
  }
  return bindings;
}

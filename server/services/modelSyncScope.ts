import { sqlite } from '../db/index.js';

/** Explicit channel bindings are approval; an upstream catalog or '*' is not. */
export function configuredSyncBindings(channel: { id: number; supportedModels?: string; modelMapping?: string | null }) {
  const supported = JSON.parse(channel.supportedModels || '[]');
  const mapping = JSON.parse(channel.modelMapping || '{}');
  if (!Array.isArray(supported) || supported.some(id => typeof id !== 'string')
    || !mapping || typeof mapping !== 'object' || Array.isArray(mapping)
    || Object.values(mapping).some(id => typeof id !== 'string')) {
    throw { status: 409, message: '渠道模型关联格式无效，原配置未修改' };
  }
  const bindings = new Map<string, string>();
  for (const id of new Set<string>([...supported, ...Object.keys(mapping)])) {
    if (id && id !== '*' && mapping[id] !== '*') bindings.set(id, mapping[id] || id);
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

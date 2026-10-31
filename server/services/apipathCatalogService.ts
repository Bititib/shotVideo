import { eq } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { channels, models } from '../db/schema.js';
import { APIPATH_MODELS } from '../../shared/apipathModels.js';
import { apipathRequest, type ApipathChannel } from './apipathAdapter.js';
import { getModelSpecification, saveModelSpecification } from './modelRoutingService.js';

export async function syncApipathModels(channel: ApipathChannel & { id: number; priority: number }) {
  const raw = await apipathRequest(channel, '/v1/models');
  if (!Array.isArray(raw?.data) || raw.data.some((x: any) => typeof x?.id !== 'string')) throw new Error('通联模型目录 data/id 格式无效');
  const names = new Set(raw.data.map((x: any) => x.id));
  const entries = APIPATH_MODELS.filter(x => names.has(x.upstreamModel || x.id));
  const warnings: string[] = [];
  const unknown = [...names].filter(id => !APIPATH_MODELS.some(x => x.id === id));
  if (unknown.length) warnings.push('未导入规格尚未核实或非图片/视频模型：' + unknown.join('、'));
  return sqlite.transaction(() => {
    let added = 0;
    const imported: string[] = [];
    const upstreamMapping: Record<string, string> = {};
    for (const entry of entries) {
      const occupied = db.select().from(models).where(eq(models.modelId, entry.id)).get();
      if (occupied && occupied.provider !== 'apipath') {
        warnings.push('公开 ID 已被其他产品使用，未合并或改名：' + entry.id); continue;
      }
      if (!occupied) {
        db.insert(models).values({ provider: 'apipath', modelId: entry.id, displayName: entry.name,
          description: entry.imageFamily ? `通联 Sunburst 图片 ${entry.limits.resolutions[0]}；最多 4 张参考图；尺寸按上游档位映射。配置售价后启用。` : entry.kind === 'image' ? '通联图片；默认输出规格；本站暂限 1 张参考图。配置售价后启用。' : '通联视频；规格按独立模型配置。配置售价后启用。',
          capabilities: JSON.stringify([entry.kind]), isActive: 0 }).run(); added++;
      }
      imported.push(entry.id);
      upstreamMapping[entry.id] = entry.upstreamModel || entry.id;
      const existing = getModelSpecification(entry.id);
      if (existing?.routes.some(r => r.channelId === channel.id)) continue;
      const route = { id: 'apipath-' + channel.id + '-' + entry.id, channelId: channel.id, executionModel: entry.id,
        upstreamModel: entry.upstreamModel || entry.id, enabled: true, limits: structuredClone(entry.limits), cost: null,
        costUnit: 'unknown' as const, resolutionCosts: {}, priority: channel.priority };
      saveModelSpecification(existing ? { ...existing, routes: [...existing.routes, route] }
        : { modelId: entry.id, kind: entry.kind, ...(entry.imageFamily ? { imageFamily: entry.imageFamily } : {}), enabled: true, aliases: [], limits: entry.limits, routes: [route] });
    }
    const saved = db.select().from(channels).where(eq(channels.id, channel.id)).get();
    const mapping = JSON.parse(saved?.modelMapping || '{}');
    db.update(channels).set({ supportedModels: JSON.stringify(imported),
      modelMapping: JSON.stringify(Object.fromEntries(imported.map(id => [id, mapping[id] || upstreamMapping[id]]))),
      maxRetries: 0, updatedAt: new Date().toISOString() }).where(eq(channels.id, channel.id)).run();
    return { count: imported.length, added, models: imported, warnings };
  })();
}

import { eq } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { channels, models } from '../db/schema.js';
import { MEGABY_CHANNEL_TYPE, MEGABY_VIDEO_MODELS, megabyPublicModelId, megabyVideoLimits } from '../../shared/megabyVideo.js';
import { fetchMegabyVideoModels, type MegabyChannel } from './megabyVideoAdapter.js';
import { getModelSpecification, saveModelSpecification } from './modelRoutingService.js';

type CatalogChannel = MegabyChannel & { id: number; name: string; priority: number };
export const ensureMegabyModels = (channel: CatalogChannel) => registerMegabyModels(channel, [...MEGABY_VIDEO_MODELS]);
export async function syncMegabyModels(channel: CatalogChannel) {
  return registerMegabyModels(channel, await fetchMegabyVideoModels(channel));
}
function registerMegabyModels(channel: CatalogChannel, upstreamModels: string[]) {
  const entries = upstreamModels.map(name => ({ name, modelId: megabyPublicModelId(name) }));
  return sqlite.transaction(() => {
    let added = 0;
    for (const entry of entries) {
      const occupied = db.select().from(models).where(eq(models.modelId, entry.modelId)).get();
      if (occupied && occupied.provider !== MEGABY_CHANNEL_TYPE) throw new Error('公开模型 ID 已被其他产品占用：' + entry.modelId + '，请明确模型身份后接入');
      if (!occupied) {
        db.insert(models).values({ provider: MEGABY_CHANNEL_TYPE, modelId: entry.modelId, displayName: entry.name,
          description: '4–15 秒，720p/480p，最多 9 图/3 视频/3 音频参考；视频和音频各最多 15 秒；不支持独立首尾帧。配置售价后启用。',
          capabilities: '["video"]', isActive: 0 }).run();
        added++;
      }
      const existing = getModelSpecification(entry.modelId);
      if (existing?.routes.some(route => route.channelId === channel.id)) continue;
      const limits = megabyVideoLimits();
      const route = { id: 'megaby-' + channel.id + '-' + entry.name, channelId: channel.id,
        executionModel: entry.modelId, upstreamModel: entry.name, enabled: true, limits: structuredClone(limits),
        cost: null, costUnit: 'unknown' as const, resolutionCosts: {}, priority: channel.priority };
      saveModelSpecification(existing ? { ...existing, routes: [...existing.routes, route] }
        : { modelId: entry.modelId, kind: 'video', enabled: true, aliases: [], limits, routes: [route] });
    }
    db.update(channels).set({ type: MEGABY_CHANNEL_TYPE, supportedModels: JSON.stringify(entries.map(e => e.modelId)),
      modelMapping: JSON.stringify(Object.fromEntries(entries.map(e => [e.modelId, e.name]))), updatedAt: new Date().toISOString(),
    }).where(eq(channels.id, channel.id)).run();
    return { count: entries.length, added, models: entries.map(e => e.modelId) };
  })();
}

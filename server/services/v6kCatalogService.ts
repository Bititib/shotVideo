import { eq } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { channels, models } from '../db/schema.js';
import { getZonghengVideoSpec, zonghengPublicModelId, V6K_TTT_720_MODEL, V6K_TTT_720_DESCRIPTION } from '../../shared/zonghengVideo.js';
import { zonghengBaseUrl } from './zonghengAdapter.js';
import { V6K_CHANNEL_TYPE } from './zonghengProtocol.js';
import { v6kSeedance20Product } from '../../shared/v6kSeedance2.js';
import { ensureV6kSeedance20Models, bindV6kSeedance20Routes } from './v6kSeedance2Catalog.js';
import { v6kTt25Product, v6kTt25Description } from '../../shared/v6kTt25.js';
import { ensureV6kTt25Models, bindV6kTt25Routes, v6kTt25SaleId } from './v6kTt25Catalog.js';
import { isV6kSyncModel } from '../../shared/v6kSyncModels.js';

export async function syncV6kVideoModels(channel: { id: number; baseUrl: string; apiKey: string; timeout?: number; type?: string }) {
  const base = zonghengBaseUrl(channel.baseUrl);
  const response = await fetch(base + '/v1/models', { headers: { Authorization: 'Bearer ' + channel.apiKey },
    signal: AbortSignal.timeout(channel.timeout || 30_000), redirect: 'error' });
  if (!response.ok) throw { status: response.status, message: '同步新站模型失败：HTTP ' + response.status };
  const payload = await response.json() as any;
  const entries = Array.isArray(payload) ? payload : payload?.data ?? payload?.models;
  if (!Array.isArray(entries)) throw { status: 502, message: '新站未返回有效模型列表，已保留原配置' };

  // Permission comes from this Key's response, and scope comes from the explicit allowlist.
  // Public-square metadata and a broad video endpoint can never expand this list.
  const imported = new Map<string, { id: string; upstream: string; description: string }>();
  const authorizedIds: string[] = [];
  const ignored = new Set<string>();
  for (const entry of entries) {
    const id = String(typeof entry === 'string' ? entry : entry?.id || entry?.model || entry?.model_id || '').trim();
    if (!id) continue;
    if (!isV6kSyncModel(id)) { ignored.add(id); continue; }
    if (!authorizedIds.includes(id)) authorizedIds.push(id);
    const spec = getZonghengVideoSpec(id);
    const publicId = zonghengPublicModelId(id);
    const product = v6kSeedance20Product(id);
    const description = product?.description || v6kTt25Description(id) || (id === V6K_TTT_720_MODEL ? V6K_TTT_720_DESCRIPTION : spec ? `${spec.resolution}；${spec.seconds.join('、')}秒；最多${spec.references.images}图、${spec.references.videos}视频、${spec.references.audios}音频`
      : '已接入视频模型');
    // Both A variants share one execution ID; the specification stores each actual upstream ID.
    if (imported.has(publicId) && id !== product?.upstreamModels[0].id) continue;
    imported.set(publicId, { id: publicId, upstream: id, description });
  }
  const warnings = ['仅同步已指定接入的白名单型号；忽略其他型号 ' + ignored.size + ' 个，保留现有配置。'];
  if (!imported.size) return { count: 0, added: 0, models: [] as string[], warnings: [...warnings, '当前 Key 未返回白名单型号，本次未修改配置。'] };
  return db.transaction(tx => {
    const current = tx.select().from(channels).where(eq(channels.id, channel.id)).get();
    if (!current || current.apiKey !== channel.apiKey || current.baseUrl !== channel.baseUrl || channel.type && current.type !== channel.type)
      throw { status: 409, message: '查询期间渠道配置已变化，已保留原配置，请重新同步' };
    const supported = JSON.parse(current.supportedModels || '[]'), mapping = JSON.parse(current.modelMapping || '{}');
    if (!Array.isArray(supported) || !mapping || typeof mapping !== 'object' || Array.isArray(mapping))
      throw { status: 409, message: '渠道原模型关联格式无效，已保留原配置' };
    const previouslyPresent = new Set(tx.select({ id: models.modelId }).from(models).all().map(row => row.id));
    ensureV6kSeedance20Models(sqlite);
    ensureV6kTt25Models(sqlite);
    // Resolve existing TT product identities while holding the configuration transaction.
    const items = [...imported.values()].map(item => {
      const tt25 = v6kTt25Product(item.upstream);
      return tt25 ? { ...item, id: v6kTt25SaleId(sqlite, tt25.id) } : item;
    });
    for (const item of items) {
      const existing = tx.select().from(models).where(eq(models.modelId, item.id)).get();
      if (!existing) {
        tx.insert(models).values({ modelId: item.id, displayName: item.id, provider: V6K_CHANNEL_TYPE,
          description: item.description, capabilities: '["video"]', isActive: 0 }).run();
      } else if (existing.provider !== V6K_CHANNEL_TYPE || !JSON.parse(existing.capabilities || '[]').includes('video'))
        throw { status: 409, message: '模型 ID ' + item.id + ' 已被其他配置占用，已保留原配置' };
      if (!supported.includes(item.id)) supported.push(item.id);
      if (!Object.hasOwn(mapping, item.id)) mapping[item.id] = item.upstream;
    }
    const ids = items.map(item => item.id);
    tx.update(channels).set({ supportedModels: JSON.stringify(supported),
      modelMapping: JSON.stringify(mapping),
      updatedAt: new Date().toISOString() }).where(eq(channels.id, channel.id)).run();
    bindV6kSeedance20Routes(sqlite, channel.id, authorizedIds);
    bindV6kTt25Routes(sqlite, channel.id, authorizedIds);
    return { count: ids.length, added: ids.filter(id => !previouslyPresent.has(id)).length, models: ids, warnings };
  });
}

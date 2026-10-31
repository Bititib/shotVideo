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

export async function syncV6kVideoModels(channel: { id: number; baseUrl: string; apiKey: string; timeout?: number }) {
  const base = zonghengBaseUrl(channel.baseUrl);
  const response = await fetch(base + '/v1/models', { headers: { Authorization: 'Bearer ' + channel.apiKey },
    signal: AbortSignal.timeout(channel.timeout || 30_000), redirect: 'error' });
  if (!response.ok) throw { status: response.status, message: '同步新站模型失败：HTTP ' + response.status };
  const payload = await response.json() as any;
  const entries = Array.isArray(payload) ? payload : payload?.data ?? payload?.models;
  if (!Array.isArray(entries)) throw { status: 502, message: '新站未返回有效模型列表，已保留原配置' };

  // The public square identifies video endpoints even when /v1/models contains IDs only.
  // It does not grant permission: only IDs in the authenticated response can be imported.
  let square: any[] = [];
  try {
    const publicResponse = await fetch(base + '/api/pricing', { signal: AbortSignal.timeout(15_000), redirect: 'error' });
    if (publicResponse.ok) {
      const publicPayload = await publicResponse.json() as any;
      if (Array.isArray(publicPayload?.data)) square = publicPayload.data;
    }
  } catch { /* Explicit video metadata and verified specifications still work without the square. */ }
  const imported = new Map<string, { id: string; upstream: string; description: string }>();
  const authorizedIds: string[] = [];
  for (const entry of entries) {
    const id = String(typeof entry === 'string' ? entry : entry?.id || entry?.model || entry?.model_id || '').trim();
    if (!id) continue;
    authorizedIds.push(id);
    const detail = square.find(item => item.model_name === id);
    const spec = getZonghengVideoSpec(id);
    const endpoints = [...(Array.isArray(entry?.supported_endpoint_types) ? entry.supported_endpoint_types : []),
      ...(Array.isArray(detail?.supported_endpoint_types) ? detail.supported_endpoint_types : [])];
    const kind = String(entry?.type || entry?.category || detail?.display_category || '').toLowerCase();
    if (!spec && !endpoints.includes('openai-video') && kind !== 'video') continue;
    const publicId = zonghengPublicModelId(id);
    const product = v6kSeedance20Product(id);
    const description = product?.description || v6kTt25Description(id) || (id === V6K_TTT_720_MODEL ? V6K_TTT_720_DESCRIPTION : spec ? `${spec.resolution}；${spec.seconds.join('、')}秒；最多${spec.references.images}图、${spec.references.videos}视频、${spec.references.audios}音频`
      : String(detail?.description || '新站视频模型；请先核对模型详情并配置规格与售价'));
    // Both A variants share one execution ID; the specification stores each actual upstream ID.
    if (imported.has(publicId) && id !== product?.upstreamModels[0].id) continue;
    imported.set(publicId, { id: publicId, upstream: id, description });
  }
  return db.transaction(tx => {
    ensureV6kSeedance20Models(sqlite);
    ensureV6kTt25Models(sqlite);
    // Resolve existing TT product identities while holding the configuration transaction.
    const items = [...imported.values()].map(item => {
      const tt25 = v6kTt25Product(item.upstream);
      return tt25 ? { ...item, id: v6kTt25SaleId(sqlite, tt25.id) } : item;
    });
    let added = 0;
    for (const item of items) {
      const existing = tx.select().from(models).where(eq(models.modelId, item.id)).get();
      if (!existing) {
        tx.insert(models).values({ modelId: item.id, displayName: item.id, provider: V6K_CHANNEL_TYPE,
          description: item.description, capabilities: '["video"]', isActive: 0 }).run();
        added++;
      } else {
        tx.update(models).set({ provider: V6K_CHANNEL_TYPE, description: item.description, capabilities: '["video"]' })
          .where(eq(models.id, existing.id)).run();
      }
    }
    const ids = items.map(item => item.id);
    tx.update(channels).set({ supportedModels: JSON.stringify(ids),
      modelMapping: JSON.stringify(Object.fromEntries(items.map(item => [item.id, item.upstream]))),
      updatedAt: new Date().toISOString() }).where(eq(channels.id, channel.id)).run();
    bindV6kSeedance20Routes(sqlite, channel.id, authorizedIds);
    bindV6kTt25Routes(sqlite, channel.id, authorizedIds);
    return { count: ids.length, added, models: ids };
  });
}

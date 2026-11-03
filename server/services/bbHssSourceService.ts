import { sqlite } from '../db/index.js';
import { isBbHssKkEntry } from '../../shared/bbHssKk.js';
import { BB_HSS_SOURCE_KEY, BB_HSS_SOURCES, type BbHssSource, type BbHssSourceSelection } from '../../shared/bbHssSources.js';
import type { ModelSpecification } from '../../shared/modelRouting.js';
import { sanitizedGenerationReason } from '../../shared/generationErrorPrivacy.js';
import { readBbHssSources } from './bbHssSourcePolicy.js';
import { bbHssKkManaged } from './bbHssKkMigration.js';
import { fetchHussModelIds } from './hussVideoAdapter.js';
import { zonghengBaseUrl } from './zonghengAdapter.js';
import { bbHssMoManaged, bbHssMoInitialRouteEnabled } from './bbHssMoMigration.js';
import { hayaApiBaseUrl } from './hayaVideoAdapter.js';

const CONFIG = 'model_specification_routes_v1';
const failure = (message: string, status = 400) => Object.assign(new Error(message), { status });
const config = () => (sqlite.prepare('SELECT value FROM settings WHERE key=?').get(CONFIG) as { value: string } | undefined)?.value;
const channelRows = () => sqlite.prepare('SELECT id,name,type,status,base_url,api_key,timeout,supported_models,model_mapping FROM channels').all() as any[];
const ready = (c: any) => c.status === 1 && Boolean(String(c.api_key || '').trim());
function checkEntry(id: string) { if (!isBbHssKkEntry(id)) throw failure('仅支持 BB、HSS 入口'); }

export function getBbHssVideoSources(id: string) {
  checkEntry(id);
  const spec = (JSON.parse(config() || '[]') as ModelSpecification[]).find(s => s.modelId === id);
  const channels = channelRows(), saved = readBbHssSources(sqlite)[id];
  const current = saved || (() => {
    const routes = spec?.routes || [];
    if (routes.length !== 1) return null;
    const source = (Object.keys(BB_HSS_SOURCES) as BbHssSource[]).find(key => {
      const value = BB_HSS_SOURCES[key];
      return routes[0].upstreamModel === value.upstreamModel && channels.find(c => c.id === routes[0].channelId)?.type === value.type;
    });
    return source ? { source, channelId: routes[0].channelId } : null;
  })();
  return { modelId: id, current, specEnabled: spec?.enabled ?? false,
    options: (Object.entries(BB_HSS_SOURCES) as [BbHssSource, typeof BB_HSS_SOURCES[BbHssSource]][]).filter(([source]) => !bbHssMoManaged(sqlite, id) || source === 'MO').flatMap(([source, value]) =>
      channels.filter(c => c.type === value.type).map(c => ({ source, label: value.label, channelId: c.id, channelName: c.name,
        ready: ready(c), upstreamModel: value.upstreamModel, limits: value.limits() }))),
  };
}

/** Read-only authorization query followed by an atomic configuration change; never submits or touches money/orders. */
export async function switchBbHssVideoSource(id: string, source: unknown, channelId: unknown) {
  checkEntry(id);
  if (typeof source !== 'string' || !Object.hasOwn(BB_HSS_SOURCES, source) || !Number.isInteger(channelId)) throw failure('请选择生成来源和渠道');
  if (bbHssMoManaged(sqlite, id) && source !== 'MO') throw failure('BB、HSS 已改为仅使用 Mo，请选择 Haya 渠道');
  if (!bbHssKkManaged(sqlite, id)) throw failure('入口尚未完成来源迁移，请先更新并初始化服务', 409);
  const target = BB_HSS_SOURCES[source as BbHssSource], before = config(), beforeSelections = JSON.stringify(readBbHssSources(sqlite));
  const spec = (JSON.parse(before || '[]') as ModelSpecification[]).find(s => s.modelId === id);
  if (!spec) throw failure('规格不存在，请先配置该入口', 409);
  const channel = channelRows().find(c => c.id === channelId);
  if (!channel || channel.type !== target.type || !ready(channel)) throw failure('所选渠道未启用、类型不符或未配置密钥');
  let ids: string[];
  try {
    if (target.type === 'huss') {
      ids = await fetchHussModelIds({ baseUrl: channel.base_url, apiKey: channel.api_key, timeout: 20_000 });
    } else {
      const label = target.type === 'haya' ? 'Haya' : 'V6K';
      const response = await fetch((target.type === 'haya' ? hayaApiBaseUrl(channel.base_url) : zonghengBaseUrl(channel.base_url)) + '/v1/models', {
        headers: { Authorization: 'Bearer ' + channel.api_key, 'Cache-Control': 'no-cache' },
        redirect: 'error', signal: AbortSignal.timeout(20_000),
      });
      const text = await response.text();
      let payload: any;
      try { payload = JSON.parse(text); } catch { throw failure(label + ' 模型权限查询返回非 JSON，HTTP ' + response.status, 502); }
      if (!response.ok) throw failure(label + ' 模型权限查询 HTTP ' + response.status + '：' + sanitizedGenerationReason(payload), 502);
      const items = Array.isArray(payload) ? payload : payload?.data ?? payload?.models;
      if (!Array.isArray(items)) throw failure(label + ' 模型权限查询未返回有效列表', 502);
      ids = items.map((item: any) => typeof item === 'string' ? item : item?.id || item?.model || item?.model_id);
    }
  } catch (e: any) {
    throw failure('未切换，原配置保留：' + sanitizedGenerationReason(String(e?.message || e).split(channel.api_key).join('[密钥已隐藏]')), 502);
  }
  if (!ids.includes(target.upstreamModel)) throw failure('当前 Key 未开放 ' + target.upstreamModel + '，未切换，原配置保留', 409);
  sqlite.transaction(() => {
    const live = channelRows().find(c => c.id === channelId);
    if (JSON.stringify(live) !== JSON.stringify(channel) || config() !== before || JSON.stringify(readBbHssSources(sqlite)) !== beforeSelections)
      throw failure('查询期间配置已变化，未覆盖新配置，请重新读取后切换', 409);
    const specs = JSON.parse(before!) as ModelSpecification[], current = specs.find(s => s.modelId === id)!;
    const oldRoute = current.routes.find(r => r.channelId === channelId && r.upstreamModel === target.upstreamModel && r.executionModel === id);
    const saved = readBbHssSources(sqlite)[id];
    if (saved?.source === source && saved.channelId === channelId && oldRoute && current.routes.length === 1) return;
    const limits = target.limits();
    const route = oldRoute || { id: 'source-' + source + '-' + channelId + '-' + id, channelId: channelId as number,
      executionModel: id, upstreamModel: target.upstreamModel,
      enabled: current.routes.length ? current.routes.some(r => r.enabled) : bbHssMoInitialRouteEnabled(sqlite, id), limits,
      cost: source === 'MO' ? 5 : source === 'KK' ? 5.5 : null, costUnit: ['KK','MO'].includes(source) ? 'per_call' as const : 'unknown' as const, resolutionCosts: {}, priority: 0 };
    current.limits = limits;
    current.routes = [{ ...route, limits }];
    // A public entry has exactly one selected source. Other products and old receipt credentials remain intact.
    for (const c of channelRows()) {
      if (!['huss', 'zongheng-v6k', 'haya'].includes(c.type)) continue;
      const supported: string[] = JSON.parse(c.supported_models || '[]'), mapping = JSON.parse(c.model_mapping || '{}');
      const kept = supported.filter(item => item !== id);
      delete mapping[id];
      if (c.id === channelId) { kept.push(id); mapping[id] = target.upstreamModel; }
      sqlite.prepare('UPDATE channels SET supported_models=?,model_mapping=? WHERE id=?').run(JSON.stringify(kept), JSON.stringify(mapping), c.id);
    }
    const selections = readBbHssSources(sqlite);
    selections[id] = { source, channelId } as BbHssSourceSelection;
    sqlite.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(BB_HSS_SOURCE_KEY, JSON.stringify(selections));
    sqlite.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(specs), CONFIG);
  }).immediate();
  return getBbHssVideoSources(id);
}

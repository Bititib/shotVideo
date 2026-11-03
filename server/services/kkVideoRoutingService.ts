import { sqlite } from '../db/index.js';
import { KK_VIDEO_MODEL, KK_VIDEO_SOURCES, isKkVideoSource, type KkVideoRouting } from '../../shared/kkVideoRouting.js';
import type { ModelSpecification } from '../../shared/modelRouting.js';
import { zonghengBaseUrl } from './zonghengAdapter.js';
import { sanitizedGenerationReason } from '../../shared/generationErrorPrivacy.js';

const KEY = 'model_specification_routes_v1';
const failure = (message: string, status = 400) => Object.assign(new Error(message), { status });
const config = () => (sqlite.prepare('SELECT value FROM settings WHERE key=?').get(KEY) as any)?.value || '[]';
const channels = () => sqlite.prepare("SELECT id,name,type,status,base_url,api_key,supported_models,model_mapping FROM channels WHERE type='zongheng-v6k'").all() as any[];
function check(id: string) { if (id !== KK_VIDEO_MODEL) throw failure('仅支持 KK 入口'); }
export function getKkVideoRouting(id: string) {
  check(id);
  const spec = (JSON.parse(config()) as ModelSpecification[]).find(s => s.modelId === id);
  return { current: spec?.kkRouting || null, version: JSON.stringify(spec), channels: channels().map(c => ({ id: c.id, name: c.name,
    ready: c.status === 1 && Boolean(String(c.api_key || '').trim()) })),
    sources: KK_VIDEO_SOURCES };
}
/** Only a model-permission GET precedes this atomic configuration write. Never touches orders or money. */
export async function saveKkVideoRouting(id: string, value: KkVideoRouting, expected: unknown) {
  check(id);
  if (!value || !isKkVideoSource(value.primary) || typeof value.fallback !== 'boolean' || !Number.isInteger(value.channelId)) throw failure('请选择首选线路、分流开关和渠道');
  const before = config(), specs = JSON.parse(before) as ModelSpecification[], spec = specs.find(s => s.modelId === id);
  if (!spec || spec.kind !== 'video') throw failure('KK 规格不存在', 409);
  if (JSON.stringify(spec) !== expected) throw failure('规格已变化，请刷新后重新设置', 409);
  const channel = channels().find(c => c.id === value.channelId);
  if (!channel || channel.status !== 1 || !String(channel.api_key || '').trim()) throw failure('所选 V6K 渠道未启用或缺少密钥');
  const required = value.fallback ? Object.values(KK_VIDEO_SOURCES) : [KK_VIDEO_SOURCES[value.primary]];
  try {
    const u = new URL(zonghengBaseUrl(channel.base_url));
    if (u.protocol !== 'https:' || !['www.v6k.top', 'v6k.top'].includes(u.hostname) || u.username || u.password || u.search || u.hash || !['', '/'].includes(u.pathname)) throw failure('V6K 地址无效，未发送密钥');
    const response = await fetch(u.origin + '/v1/models', { headers: { Authorization: 'Bearer ' + channel.api_key, 'Cache-Control': 'no-cache' }, redirect: 'error', signal: AbortSignal.timeout(20_000) });
    const text = await response.text();
    let payload: any; try { payload = JSON.parse(text); } catch { throw failure('V6K 模型权限查询返回非 JSON，HTTP ' + response.status); }
    if (!response.ok) throw failure('V6K 模型权限查询 HTTP ' + response.status + '：' + sanitizedGenerationReason(payload));
    const items = Array.isArray(payload) ? payload : payload?.data ?? payload?.models;
    if (!Array.isArray(items)) throw failure('V6K 未返回有效模型目录');
    const ids = items.map(x => typeof x === 'string' ? x : x?.id);
    const missing = required.filter(x => !ids.includes(x));
    if (missing.length) throw failure('当前 Key 未开放：' + missing.join('、'));
  } catch (error: any) {
    throw failure('未保存，原配置保留：' + sanitizedGenerationReason(String(error.message).split(channel.api_key).join('[密钥已隐藏]')), 502);
  }
  sqlite.transaction(() => {
    if (config() !== before || JSON.stringify(channels().find(c => c.id === channel.id)) !== JSON.stringify(channel)) throw failure('查询期间配置已变化，请刷新后重试', 409);
    const oldRoutes = spec.routes;
    spec.kkRouting = { primary: value.primary, fallback: value.fallback, channelId: value.channelId };
    // Preserve existing switches, limits and administrator costs. The public price is never written.
    spec.routes = Object.entries(KK_VIDEO_SOURCES).map(([source, upstreamModel]) => {
      const old = oldRoutes.find(r => r.channelId === channel.id && r.executionModel === id && r.upstreamModel === upstreamModel);
      return { ...(old || { id: 'kk-routing-' + source + '-' + channel.id, channelId: channel.id, executionModel: id,
        upstreamModel, enabled: true, limits: structuredClone(spec.limits), cost: null, costUnit: 'unknown' as const, resolutionCosts: {} }), priority: source === value.primary ? 0 : 1 };
    });
    const supported: string[] = JSON.parse(channel.supported_models || '[]'), mapping = JSON.parse(channel.model_mapping || '{}');
    if (!Array.isArray(supported) || !mapping || typeof mapping !== 'object' || Array.isArray(mapping)) throw failure('渠道关联格式无效');
    if (!supported.includes(id)) supported.push(id);
    mapping[id] = KK_VIDEO_SOURCES[value.primary];
    sqlite.prepare('UPDATE channels SET supported_models=?,model_mapping=? WHERE id=?').run(JSON.stringify(supported), JSON.stringify(mapping), channel.id);
    sqlite.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(specs), KEY);
  }).immediate();
  return getKkVideoRouting(id);
}

import type Database from 'better-sqlite3';
import type { ModelSpecification } from '../../shared/modelRouting.js';
import { V6K_FULL_720_MODEL as ID, V6K_FULL_720_UPSTREAM as UPSTREAM, V6K_FULL_720_LEGACY_UPSTREAM as LEGACY, V6K_FULL_720_DESCRIPTION, V6K_FULL_720_LEGACY_DESCRIPTION, v6kFull720Limits } from '../../shared/v6kFullReferenceVideo.js';
import { V6K_CHANNEL_TYPE } from './zonghengProtocol.js';
import { sanitizedGenerationReason } from '../../shared/generationErrorPrivacy.js';

const CONFIG = 'model_specification_routes_v1';
const config = (d: Database.Database) => (d.prepare('SELECT value FROM settings WHERE key=?').get(CONFIG) as any)?.value || '[]';
const failure = (message: string, status = 409) => Object.assign(new Error(message), { status });

/** Registration/sync preserve administrator switches and prices. Bind only after authenticated discovery. */
export function ensureV6kFull720Model(d: Database.Database, channelId?: number) {
  return d.transaction(() => {
    const existing = d.prepare('SELECT provider,capabilities,is_active,description FROM models WHERE model_id=?').get(ID) as any;
    if (existing && (existing.provider !== V6K_CHANNEL_TYPE || !JSON.parse(existing.capabilities || '[]').includes('video')))
      throw failure(ID + ' 已被其他产品占用，未覆盖原配置');
    d.prepare('INSERT OR IGNORE INTO models(provider,model_id,display_name,description,capabilities,is_active) VALUES(?,?,?,?,?,0)')
      .run(V6K_CHANNEL_TYPE, ID, ID, V6K_FULL_720_DESCRIPTION, '["video"]');
    d.prepare(`INSERT INTO model_pricing(model_pattern,billing_type,input_price,output_price,extra_params)
      SELECT ?,'per_call',5.8,0,'{}' WHERE NOT EXISTS(SELECT 1 FROM model_pricing WHERE model_pattern=?)`).run(ID, ID);
    const specs = JSON.parse(config(d)) as ModelSpecification[];
    if (!Array.isArray(specs)) throw failure('模型规格配置无效，未接入极速音视频参考型号');
    let spec = specs.find(s => s.modelId === ID), changed = false;
    if (spec && spec.kind !== 'video') throw failure(ID + ' 规格类型冲突，未覆盖原配置');
    if (!spec) {
      spec = { modelId: ID, kind: 'video', enabled: false, aliases: [], limits: v6kFull720Limits(), routes: [] };
      specs.push(spec); changed = true;
    }
    if (channelId !== undefined) {
      const channel = d.prepare('SELECT type,model_mapping FROM channels WHERE id=?').get(channelId) as any;
      if (channel?.type !== V6K_CHANNEL_TYPE) throw failure('必须使用 V6K 渠道');
      const mapping = JSON.parse(channel.model_mapping || '{}');
      if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) throw failure('渠道映射格式无效');
      if (mapping[ID] && ![UPSTREAM, LEGACY].includes(mapping[ID])) throw failure('入口已绑定其他上游，未覆盖原配置');
      const matches = (r: ModelSpecification['routes'][number], upstream: string) => r.channelId === channelId && r.executionModel === ID && r.upstreamModel === upstream;
      const hasNew = spec.routes.some(r => matches(r, UPSTREAM));
      const legacyRoutes = spec.routes.filter(r => matches(r, LEGACY));
      // Only upgrade the former generated capability on first authenticated binding.
      // A restart may already have archived the retired association; the saved spec remains.
      if ((!hasNew || legacyRoutes.length) && spec.limits.maxImages === 30 && spec.limits.maxVideos === 0 && spec.limits.maxAudios === 0) {
        spec.limits = { ...spec.limits, maxVideos: 10, maxAudios: 10 }; changed = true;
      }
      if (legacyRoutes.length) {
        spec.routes = spec.routes.flatMap(r => !matches(r, LEGACY) ? [r] : hasNew ? [] : [{ ...r, upstreamModel: UPSTREAM,
          limits: { ...r.limits, maxImages: 30, maxVideos: 10, maxAudios: 10 } }]);
        changed = true;
      } else if (!hasNew) {
        spec.routes.push({ id: 'v6k-full720-' + channelId, channelId, executionModel: ID, upstreamModel: UPSTREAM,
          enabled: true, limits: v6kFull720Limits(), cost: null, costUnit: 'unknown', resolutionCosts: {}, priority: 0 });
        changed = true;
      }
      if (mapping[ID] === LEGACY) {
        mapping[ID] = UPSTREAM;
        d.prepare('UPDATE channels SET model_mapping=? WHERE id=?').run(JSON.stringify(mapping), channelId);
      }
      if (existing?.description === V6K_FULL_720_LEGACY_DESCRIPTION)
        d.prepare('UPDATE models SET description=? WHERE model_id=?').run(V6K_FULL_720_DESCRIPTION, ID);
    }
    if (changed) d.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(CONFIG, JSON.stringify(specs));
  })();
}

/** Explicit activation for the requested front-end entry; only a GET is sent upstream. */
export async function enableV6kFull720Entry(d: Database.Database, channelId: number) {
  if (!Number.isSafeInteger(channelId) || channelId <= 0) throw failure('请选择有效渠道');
  const read = () => d.prepare('SELECT id,type,status,base_url,api_key,supported_models,model_mapping FROM channels WHERE id=?').get(channelId) as any;
  const channel = read(), before = config(d);
  const registryBefore = JSON.stringify(d.prepare('SELECT * FROM models WHERE model_id=?').get(ID));
  if (!channel || channel.type !== V6K_CHANNEL_TYPE || channel.status !== 1 || !String(channel.api_key || '').trim()) throw failure('V6K 渠道未启用或缺少密钥');
  try {
    const u = new URL(channel.base_url);
    if (u.protocol !== 'https:' || !['www.v6k.top', 'v6k.top'].includes(u.host) || u.username || u.password || u.search || u.hash || !['/', '/v1', '/v1/'].includes(u.pathname)) throw failure('V6K 地址不匹配，未发送密钥');
    const response = await fetch(u.origin + '/v1/models', { headers: { Authorization: 'Bearer ' + channel.api_key, 'Cache-Control': 'no-cache' }, redirect: 'error', signal: AbortSignal.timeout(20_000) });
    const text = await response.text(); let p: any;
    try { p = JSON.parse(text); } catch { throw failure('模型权限查询返回非 JSON，HTTP ' + response.status); }
    if (!response.ok) throw failure('模型权限查询 HTTP ' + response.status + '：' + sanitizedGenerationReason(p));
    const items = Array.isArray(p) ? p : p?.data ?? p?.models;
    if (!Array.isArray(items) || !items.some(x => (typeof x === 'string' ? x : x?.id) === UPSTREAM)) throw failure('当前 Key 未开放 ' + UPSTREAM);
  } catch (e: any) { throw failure('未启用，原配置保留：' + sanitizedGenerationReason(String(e.message).split(channel.api_key).join('[密钥已隐藏]')), 502); }
  return d.transaction(() => {
    if (JSON.stringify(read()) !== JSON.stringify(channel) || config(d) !== before || JSON.stringify(d.prepare('SELECT * FROM models WHERE model_id=?').get(ID)) !== registryBefore)
      throw failure('查询期间配置已变化，未覆盖新配置，请重试');
    ensureV6kFull720Model(d, channelId);
    const specs = JSON.parse(config(d)) as ModelSpecification[], spec = specs.find(s => s.modelId === ID)!;
    spec.enabled = true;
    spec.routes.find(r => r.channelId === channelId && r.executionModel === ID && r.upstreamModel === UPSTREAM)!.enabled = true;
    const supported: string[] = JSON.parse(channel.supported_models || '[]'), mapping = JSON.parse(channel.model_mapping || '{}');
    if (!Array.isArray(supported) || !mapping || typeof mapping !== 'object' || Array.isArray(mapping)) throw failure('渠道关联格式异常，未启用');
    if (mapping[ID] && ![UPSTREAM, LEGACY].includes(mapping[ID])) throw failure('入口已绑定其他上游，未覆盖原配置');
    if (!supported.includes(ID)) supported.push(ID);
    mapping[ID] = UPSTREAM;
    d.prepare('UPDATE channels SET supported_models=?,model_mapping=? WHERE id=?').run(JSON.stringify(supported), JSON.stringify(mapping), channelId);
    d.prepare('UPDATE models SET is_active=1 WHERE model_id=?').run(ID);
    d.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(specs), CONFIG);
    return { model: ID, upstreamModel: UPSTREAM, channelId, modelEnabled: true, specEnabled: true, routeEnabled: true,
      limits: spec.limits, description: (d.prepare('SELECT description FROM models WHERE model_id=?').get(ID) as any).description,
      pricing: d.prepare('SELECT billing_type,input_price,extra_params FROM model_pricing WHERE model_pattern=?').get(ID) };
  }).immediate();
}

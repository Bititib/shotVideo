import { createHash } from 'node:crypto';

export const reconstructionAnalysisSetting = 'internal_reconstruction_analysis_v1';
const parse = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function retiredAnalysisChannel(channel) {
  if (/aistudio\s*2\s*api/i.test(`${channel.name} ${channel.base_url}`)) return true;
  try { return new URL(channel.base_url).hostname === '172.245.16.80'; } catch { return true; }
}
const invalid = (message, status = 409) => Object.assign(new Error(message), { status });

// Actual website tables only. No seed catalog, env fallback, private channel copy, or startup side effects.
export function reconstructionAnalysisCatalog(db) {
  const models = db.prepare('SELECT model_id,display_name,capabilities FROM models WHERE is_active=1').all()
    .filter(model => { const caps = parse(model.capabilities, []); return Array.isArray(caps) && caps.includes('text'); });
  const channels = db.prepare('SELECT id,name,type,base_url,api_key,supported_models,model_mapping FROM channels WHERE status=1').all()
    .filter(channel => channel.api_key?.trim() && !retiredAnalysisChannel(channel));
  const routes = [];
  for (const model of models) for (const channel of channels) {
    const ids = parse(channel.supported_models, []);
    if (!Array.isArray(ids) || !(ids.includes(model.model_id) || ids.includes('*'))) continue;
    const mapping = parse(channel.model_mapping, {});
    const upstreamModel = mapping?.[model.model_id] || model.model_id;
    if (/aistudio\s*2\s*api/i.test(upstreamModel)) continue;
    let validUrl = false;
    try { const url = new URL(channel.base_url); validUrl = url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash; } catch {}
    const protocol = channel.type === 'gemini' && validUrl ? 'gemini-native' : 'unverified';
    routes.push({ channelId: channel.id, channelName: channel.name, channelType: channel.type, modelId: model.model_id,
      displayName: model.display_name, upstreamModel, protocol, selectable: protocol === 'gemini-native',
      reason: protocol === 'gemini-native' ? 'Gemini 原生视频输入候选，尚需短视频实测' : channel.type==='image2pro'
        ? '已接入对话/看图；上游文档尚未提供整段视频输入格式' : '已接入对话；此渠道的视频输入协议尚未核实',
      revision: digest(channel), baseUrl: channel.base_url.replace(/\/+$/, '').replace(/\/v1beta$/, ''), apiKey: channel.api_key });
  }
  const saved = parse(db.prepare('SELECT value FROM settings WHERE key=?').get(reconstructionAnalysisSetting)?.value, null);
  const selected = saved && routes.some(route => route.selectable && route.channelId === saved.channelId && route.modelId === saved.modelId)
    ? {channelId:saved.channelId,modelId:saved.modelId} : null;
  const version = digest({ routes: routes.map(({apiKey,...route}) => route), saved });
  return { routes, selected, saved, version };
}
export function publicAnalysisCatalog(db) {
  const {routes,selected,saved,version} = reconstructionAnalysisCatalog(db);
  return { items: routes.map(({apiKey,revision,baseUrl,...route}) => route), selected, version,
    selectionInvalid: Boolean(saved && !selected),
    note: '仅列启用、带密钥且已映射的第三方对话渠道；已排除失效 aistudio2api。候选不代表已通过视频实测。' };
}
export function saveAnalysisSelection(db, body) {
  return db.transaction(() => {
    const current = reconstructionAnalysisCatalog(db);
    if (body.version !== current.version) throw invalid('渠道或模型配置已变化，请重新读取后选择');
    let selected = null;
    if (body.channelId != null || body.modelId != null) {
      const found = current.routes.find(route => route.channelId === body.channelId && route.modelId === body.modelId);
      if (!found?.selectable) throw invalid('所选渠道未启用、已失效或视频输入协议尚未核实', 422);
      selected = { channelId: found.channelId, modelId: found.modelId };
    }
    db.prepare(`INSERT INTO settings(key,value,label,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
      .run(reconstructionAnalysisSetting, JSON.stringify(selected), '一键复刻拉片模型', new Date().toISOString());
    return publicAnalysisCatalog(db);
  }).immediate();
}

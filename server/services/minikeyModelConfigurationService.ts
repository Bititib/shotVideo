import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { channels, models, settings } from '../db/schema.js';
import type { MinikeyCatalogOption, MinikeyModelDraft, MinikeyModelConfiguration } from '../../shared/minikeyModelConfiguration.js';
import { minikeyImageSize } from '../../shared/minikeyModelConfiguration.js';
import { getModelSpecification, getModelSpecifications, saveModelSpecification, validateLimits } from './modelRoutingService.js';
import { validatePublicModelName } from './publicModelNameService.js';
import { minikeyBase } from './minikeyAdapter.js';

const fail = (message: string, status = 400) => Object.assign(new Error(message), { status });
const key = (id: number) => 'minikey_model_configurations_' + id;
function channel(id: number) {
  const row = db.select().from(channels).where(eq(channels.id,id)).get();
  if (!row || row.type !== 'minikey') throw fail('请选择 miniKey 渠道',404);
  return row;
}
function drafts(id: number): MinikeyModelDraft[] {
  return JSON.parse(db.select().from(settings).where(eq(settings.key,key(id))).get()?.value || '[]');
}
function current(id: number, modelId: string) {
  const c = channel(id), saved = drafts(id).find(d=>d.modelId===modelId);
  const model = db.select().from(models).where(eq(models.modelId,modelId)).get();
  const spec = getModelSpecification(modelId), route = spec?.routes.find(r=>r.channelId===id);
  const reason = model && (!saved || model.provider !== 'minikey' || (saved.kind==='music' ? Boolean(spec) : spec?.routes.length !== 1 || !route)) ? '模型已有其他关联，不能覆盖' : undefined;
  const version = createHash('sha256').update(JSON.stringify([c.updatedAt,c.baseUrl,c.apiKey,c.supportedModels,c.modelMapping,saved,model,spec])).digest('hex');
  return { c, saved, model, spec, route, reason, version };
}
export function listMinikeyModelConfigurations(id: number): MinikeyModelConfiguration[] {
  channel(id);
  return drafts(id).filter(d=>d.kind!=='music').map(d => { const c=current(id,d.modelId); return {...d,
    ...(c.spec && c.route ? {limits:c.spec.limits,enabled:c.spec.enabled,routeEnabled:c.route!.enabled,upstreamModel:c.route!.upstreamModel,
      upstreamChannel:c.route!.minikey?.upstreamChannel ?? null,imageProtocol:c.route!.minikey?.imageProtocol ?? d.imageProtocol} : {}),
    editable:!c.reason,reason:c.reason,version:c.version}; });
}
export async function listMinikeyCatalogOptions(id: number): Promise<MinikeyCatalogOption[]> {
  const c = channel(id);
  const response = await fetch(minikeyBase(c.baseUrl)+'/models',{redirect:'error',signal:AbortSignal.timeout(30000)});
  if (!response.ok) throw fail('miniKey 模型目录 HTTP '+response.status,502);
  const data = await response.json() as any;
  if (!Array.isArray(data.models)) throw fail('miniKey 模型目录格式无效',502);
  return data.models.filter((r:any)=>typeof r.model==='string' && !r.model.includes('@') && ['video','image'].includes(r.category)).map((r:any)=>({
    model:r.model,name:String(r.name || r.model),kind:r.category,maxImages:Number(r.maxImages)||0,
    durations:Array.isArray(r.durations)?r.durations.filter((n:any)=>Number.isInteger(n)&&n>0):[],
    resolutions:Object.keys(r.prices || {}).filter(s=>/^(?:0\.5|1|2|4)K$/i.test(s)),
    channels:(Array.isArray(r.channels)?r.channels:[]).filter((c:any)=>Number.isSafeInteger(c.id)&&c.id>0).map((c:any)=>({id:c.id,name:String(c.name || c.id),prices:c.prices || {}}))
  }));
}
async function checked(id: number, input: MinikeyModelDraft) {
  if(input?.kind==='music')throw fail('miniKey 音乐已关闭，请使用音乐渠道',409);
  if (!input || typeof input.modelId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(input.modelId)
    || /^minikey[-_:]/i.test(input.modelId) || typeof input.upstreamModel!=='string' || !input.upstreamModel.trim()
    || !['video','image'].includes(input.kind) || !['banana','size'].includes(input.imageProtocol)
    || typeof input.enabled!=='boolean' || typeof input.routeEnabled!=='boolean') throw fail('请填写有效本站模型 ID、上游型号与类型；本站 ID 无需渠道前缀');
  if (input.upstreamChannel!==null && (!Number.isSafeInteger(input.upstreamChannel)||input.upstreamChannel<=0)) throw fail('线路编号必须为正整数');
  validateLimits(input.limits);
  const {limits:l}=input;
  if (l.firstFrame || l.lastFrame || l.outputsPerTask!==undefined) throw fail('miniKey 不支持独立首尾帧或固定多结果配置');
  const options=await listMinikeyCatalogOptions(id), option=options.find(r=>r.model===input.upstreamModel && r.kind===input.kind);
  if (!option) throw fail('上游当前目录没有此类型的型号',409);
  if (l.maxImages>option.maxImages || l.maxVideos>10 || l.maxAudios>10) throw fail('素材数量超过 miniKey 文档上限');
  if (input.kind==='video') {
    const line=option.channels.find(c=>c.id===input.upstreamChannel);
    if (!line) throw fail('请选择上游当前可用的明确线路');
    const seconds=l.duration.mode==='options'?l.duration.values:l.duration.mode==='fixed'?[l.duration.min]:Array.from({length:Math.floor((l.duration.max-l.duration.min)/l.duration.step)+1},(_,n)=>l.duration.min+n*l.duration.step);
    if (l.maxOutputs!==1 || l.minImages<1 || l.qualities.length || !l.defaultSeconds || seconds.some(s=>!Number.isInteger(s)||!Object.hasOwn(line.prices,String(s)))
      || !l.ratios.every(r=>['1:1','3:4','4:3','9:16','16:9','21:9'].includes(r)) || l.resolutions.length!==1 || !['480p','720p','1080p','2160p'].includes(l.resolutions[0])) throw fail('视频需选择线路支持的秒数、默认时长、单一清晰度和比例，至少一张参考图');
  } else {
    if (input.upstreamChannel!==null) throw fail('图片接口尚未确认指定线路参数，请留空');
    if (l.maxVideos || l.maxAudios || l.minImages || l.maxOutputs>4 || l.resolutions.length!==1 || !option.resolutions.some(r=>r.toUpperCase()===l.resolutions[0].toUpperCase())) throw fail('图片需设置单一受支持清晰度、0–4 张输出及普通参考图');
    const ratios=input.imageProtocol==='banana'?['1:1','2:3','3:4','4:3','4:5','5:4','9:16','16:9','21:9','1:4','4:1','1:8','8:1']:['1:1','16:9','9:16','4:3','3:4','3:2','2:3'];
    if (!l.ratios.every(r=>ratios.includes(r)) || (input.imageProtocol==='banana' && l.qualities.length) || (input.imageProtocol==='size' && (!l.qualities.every(q=>['auto','high','medium','low'].includes(q)) || l.resolutions[0].toUpperCase()!=='1K'))) throw fail('图片参数超出所选参数格式支持范围');
  }
  return input;
}
export async function previewMinikeyModelRequest(id:number,draft:MinikeyModelDraft) {
  const d=await checked(id,structuredClone(draft));
  return {method:'POST',path:d.kind==='video'?'/openapi/v1/videos':'/openapi/v1/images',
    body:d.kind==='video'?{model:d.upstreamModel,channel:d.upstreamChannel,prompt:'示例提示词',duration:d.limits.defaultSeconds,ratio:d.limits.ratios[0],images:'["参考图地址"]',client_request_id:'<持久化请求编号>'}
      :{model:d.upstreamModel,prompt:'示例提示词',params:d.imageProtocol==='banana'?{aspectRatio:d.limits.ratios[0],imageSize:d.limits.resolutions[0].toUpperCase(),n:1}:{size:minikeyImageSize(d.limits.ratios[0]),quality:'auto',n:1}}};
}
export async function saveMinikeyModelConfiguration(id:number,value:MinikeyModelDraft,version:string|null) {
  const draft=structuredClone(value);
  if(draft?.kind==='music')throw fail('miniKey 音乐已关闭，请使用音乐渠道',409);
  if (!draft || typeof draft.modelId!=='string') throw fail('请填写模型配置');
  const original=current(id,draft.modelId);
  if (original.reason) throw fail(original.reason,409);
  if (original.saved ? version!==original.version : version!==null) throw fail('配置已变化，请重新打开',409);
  await checked(id,draft);
  return sqlite.transaction(()=>{
    const live=current(id,draft.modelId);
    if (live.version!==original.version || live.reason) throw fail('校验期间配置已变化，请重新打开',409);
    if (live.saved && live.saved.kind!==draft.kind) throw fail('已有模型不能更换生成类型');
    validatePublicModelName(draft.modelId,draft.modelId,live.model?.id);
    if (!live.saved && getModelSpecifications().some(s=>s.modelId===draft.modelId||s.aliases.includes(draft.modelId))) throw fail('模型 ID 已被其他规格占用',409);
    if (drafts(id).some(d=>d.modelId!==draft.modelId && d.kind===draft.kind && d.upstreamModel===draft.upstreamModel && d.upstreamChannel===draft.upstreamChannel && d.limits.resolutions[0]===draft.limits.resolutions[0])) throw fail('此型号、线路与清晰度已添加');
    if (!live.model) db.insert(models).values({modelId:draft.modelId,displayName:draft.modelId,provider:'minikey',capabilities:JSON.stringify([draft.kind]),isActive:0}).run();
    if (draft.kind!=='music') {
      const same=live.route?.upstreamModel===draft.upstreamModel && live.route?.minikey?.upstreamChannel===draft.upstreamChannel;
      saveModelSpecification({modelId:draft.modelId,kind:draft.kind,enabled:draft.enabled,aliases:live.spec?.aliases || [],limits:draft.limits,
        routes:[{id:live.route?.id || randomUUID(),channelId:id,executionModel:draft.modelId,upstreamModel:draft.upstreamModel,enabled:draft.routeEnabled,
          limits:draft.limits,minikey:{upstreamChannel:draft.upstreamChannel,imageProtocol:draft.imageProtocol},cost:same?live.route!.cost:null,costUnit:same?live.route!.costUnit:'unknown',resolutionCosts:same?live.route!.resolutionCosts:{},priority:live.route?.priority || 0}]});
    }
      db.update(channels).set({supportedModels:JSON.stringify([...new Set([...JSON.parse(live.c.supportedModels),draft.modelId])]),
        modelMapping:JSON.stringify({...JSON.parse(live.c.modelMapping),[draft.modelId]:draft.upstreamModel}),maxRetries:0,updatedAt:new Date().toISOString()}).where(eq(channels.id,id)).run();
    const rows=[...drafts(id).filter(d=>d.modelId!==draft.modelId),draft];
    db.insert(settings).values({key:key(id),value:JSON.stringify(rows),label:'miniKey 模型配置'}).onConflictDoUpdate({target:settings.key,set:{value:JSON.stringify(rows)}}).run();
    return listMinikeyModelConfigurations(id).find(d=>d.modelId===draft.modelId)!;
  }).immediate();
}

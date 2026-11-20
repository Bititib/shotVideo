import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { models, apipathChannelKeys } from '../db/schema.js';
import { defaultRoutingLimits, allowsDuration, routingMismatches, type ModelRoute, type ModelInputLimits } from '../../shared/modelRouting.js';
import type { V6kRequestSample } from '../../shared/v6kModelConfiguration.js';
import { isApipathSunburstSpec, apipathImageSize } from '../../shared/apipathImageSizes.js';
import type { ChannelModelCatalogEntry, ChannelModelDraft } from '../../shared/channelModelConfiguration.js';
import { APIPATH_MODELS } from '../../shared/apipathModels.js';
import { apipathBase, apipathRequest, buildApipathVideoPayload, APIPATH_VIDEO_FIELDS, APIPATH_VIDEO_MODES, type ApipathChannel } from './apipathAdapter.js';
import { apipathKeys } from './apipathKeyService.js';

const fail = (message: string) => Object.assign(new Error(message), { status: 409 });
export type ApipathCatalogEntry = { id: string; name: string; kind: 'image' | 'video'; limits: ModelInputLimits;
  description: string; keyIds: number[]; apipath?: NonNullable<ModelRoute['apipath']> };

type CatalogChannel = ApipathChannel & { id: number };
async function readAuthorizedIds(channel: CatalogChannel) {
  const keys = apipathKeys(channel.id).filter(k => k.status === 1);
  const sources = keys.length ? keys : apipathKeys(channel.id).length ? []
    : channel.apiKey ? [{ id: null, kind: 'legacy', apiKey: channel.apiKey }] : [];
  if (!sources.length) throw fail('请先保存图片或视频 API Key');
  return Promise.all(sources.map(async source => {
    const catalog = await apipathRequest({ ...channel, apiKey: source.apiKey }, '/v1/models');
    if (!Array.isArray(catalog?.data) || catalog.data.some((x: any) => typeof x?.id !== 'string')) throw fail('Vx-魅影授权目录格式无效');
    const authorized = new Set<string>(catalog.data.map((x: any) => x.id));
    return { id: source.id, kind: source.kind, authorized };
  }));
}

export async function listApipathCatalog(channel: CatalogChannel): Promise<ChannelModelCatalogEntry[]> {
  const sources = await readAuthorizedIds(channel);
  const listed = new Map<string, ChannelModelCatalogEntry>();
  for (const { kind, authorized } of sources) {
    for (const id of authorized) {
      const entry = listed.get(id) ?? { id, apipathKeyKinds: [] as string[] };
      entry.apipathKeyKinds!.push(kind);
      listed.set(id, entry);
    }
  }
  // Public specifications enrich the selector. Only the authenticated API determines membership.
  let profiles: ApipathCatalogEntry[];
  try { profiles = await documentedCatalog(channel, sources); }
  catch { profiles = []; }
  for (const { id, limits, kind } of profiles) Object.assign(listed.get(id)!, { limits, kind });
  return [...listed.values()].sort((a,b) => a.id.localeCompare(b.id));
}

/** Published docs plus complete official model configurations, intersected with the matching Key's authorization. */
export async function apipathAuthorizedCatalog(channel: ApipathChannel & { id: number }): Promise<ApipathCatalogEntry[]> {
  return documentedCatalog(channel, await readAuthorizedIds(channel));
}

async function documentedCatalog(channel: CatalogChannel, sources: Awaited<ReturnType<typeof readAuthorizedIds>>): Promise<ApipathCatalogEntry[]> {
  const response = await fetch(apipathBase(channel.baseUrl) + '/api/api-docs', { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw fail('Vx-魅影公开协议读取失败：HTTP ' + response.status);
  const raw = await response.json();
  if (raw?.code !== 0 || !Array.isArray(raw?.data?.items)) throw fail('Vx-魅影公开协议格式无效，未添加模型');

  const hasVideoContract = raw.data.items.some((doc:any)=>
    doc.category==='video' && doc.content?.calling_contract?.create_endpoints?.some((e:any)=>e.method==='POST'&&e.path==='/v1/video/generations')
    && doc.content?.calling_contract?.query_endpoints?.some((e:any)=>e.method==='GET'&&e.path==='/v1/video/generations/{task_no}'&&e.terminal_status?.success==='completed'));
  let runtimeModels:any[]=[];
  if (hasVideoContract && sources.some(source=>source.kind==='video'||source.kind==='legacy')) {
    const runtimeResponse=await fetch(apipathBase(channel.baseUrl)+'/api/models',{redirect:'error',signal:AbortSignal.timeout(30_000)});
    if(!runtimeResponse.ok)throw fail('Vx-魅影官方型号配置读取失败：HTTP '+runtimeResponse.status);
    const runtime=await runtimeResponse.json();
    if(runtime?.code!==0||!Array.isArray(runtime?.data))throw fail('Vx-魅影官方型号配置格式无效，未修改模型绑定');
    const documented=new Set(raw.data.items.map((doc:any)=>doc.model_code));
    runtimeModels=runtime.data.filter((model:any)=>!documented.has(model.code));
  }
  const entries = new Map<string, ApipathCatalogEntry>();
  for (const source of sources) {
    const authorized = source.authorized;
    for (const doc of raw.data.items) {
      if (!authorized.has(doc.model_code) || !doc.is_published || !['image','video'].includes(doc.category)
        || source.kind !== 'legacy' && source.kind !== doc.category) continue;
      const parsed = apipathDocumentedModel(doc);
      if (!parsed) continue;
      const entry = entries.get(parsed.id) || { ...parsed, keyIds: [] };
      if (source.id !== null) entry.keyIds.push(source.id);
      entries.set(entry.id, entry);
    }
    if(source.kind==='video'||source.kind==='legacy')for(const model of runtimeModels){
      if(!authorized.has(model.code))continue;
      const parsed=apipathRuntimeVideoModel(model);
      if(!parsed)continue;
      const entry=entries.get(parsed.id)||{...parsed,keyIds:[]};
      if(source.id!==null)entry.keyIds.push(source.id);
      entries.set(entry.id,entry);
    }
  }
  return [...entries.values()];
}

/** The same provider's standard video API contract, with this model's own official runtime limits.
 * Missing or conflicting specifications never inherit another model's capabilities. */
export function apipathRuntimeVideoModel(model:any):Omit<ApipathCatalogEntry,'keyIds'>|null {
  const v=model?.runtime_rule?.video, id=model?.code;
  if(model?.is_enabled!==true||model?.category!=='video'||typeof id!=='string'||!id.trim()||id!==id.trim()||id.length>160||/[\x00-\x1f\x7f]/.test(id)
    ||!v||v.upload_profile!=='custom_media'||v.mode_param!=='generation_mode'||v.prompt_required!==true
    ||!Array.isArray(v.count_options)||v.count_options.length!==1||v.count_options[0]!==1
    ||!v.frames||typeof v.frames!=='object'||Object.keys(v.frames).length) return null;
  const strings=(a:unknown):a is string[]=>Array.isArray(a)&&a.length>0&&a.length<=50&&a.every(x=>typeof x==='string'&&x.trim()===x&&x.length>0&&x.length<=80)&&new Set(a).size===a.length;
  const same=(a:string[],b:unknown)=>strings(b)&&a.length===b.length&&a.every(x=>b.includes(x));
  if(!strings(v.supported_resolutions)||!strings(v.supported_aspect_ratios)
    ||!same(v.supported_resolutions,model.input_schema?.properties?.resolution?.enum)
    ||!same(v.supported_aspect_ratios,model.input_schema?.properties?.ratio?.enum)
    ||!Array.isArray(v.supported_generation_modes)||v.supported_generation_modes.some((m:unknown)=>typeof m!=='string'||!APIPATH_VIDEO_MODES.includes(m)))return null;
  const max=(ref:any,field:string)=>ref?.key===field&&Number.isSafeInteger(ref.max)&&ref.max>=0&&ref.max<=100?ref.max:null;
  const images=max(v.reference_images,'reference_images'),videos=max(v.reference_videos,'reference_videos'),audios=max(v.reference_audios,'reference_audios');
  if(images===null||videos===null||audios===null||v.max_reference_images!==images
    ||![v.duration_min,v.duration_max,v.duration_step,v.min_reference_images,v.max_total_images].every(Number.isSafeInteger)
    ||v.duration_min<1||v.duration_max<v.duration_min||v.duration_max>3600||v.duration_step<1
    ||v.min_reference_images<0||v.min_reference_images>images||v.max_total_images<v.min_reference_images||v.max_total_images>100)return null;
  const limits:ModelInputLimits={...defaultRoutingLimits(),maxImages:Math.min(images,v.max_total_images),maxVideos:videos,maxAudios:audios,minImages:v.min_reference_images,
    resolutions:v.supported_resolutions,ratios:v.supported_aspect_ratios,
    duration:{mode:'range',min:v.duration_min,max:v.duration_max,step:v.duration_step,values:[]}};
  const defaultSeconds=model.default_params?.duration;
  if(!Number.isSafeInteger(defaultSeconds)||!allowsDuration(limits.duration,defaultSeconds))return null;
  limits.defaultSeconds=defaultSeconds;
  const modes:string[]=v.supported_generation_modes;
  const fields=['duration','ratio','resolution','count',...(images?['reference_images']:[]),...(videos?['reference_videos']:[]),...(audios?['reference_audios']:[]),...(modes.length?['generation_mode']:[])];
  // This exact model's public description states the prompt limit; do not assign it to other models.
  const maxPromptChars=id==='Seedance2.5-满参-变形金刚'?15000:undefined;
  const description=`${model.display_name||id}；分辨率：${limits.resolutions.join(' / ')}；时长 ${v.duration_min}–${v.duration_max} 秒（步长 ${v.duration_step} 秒）；`
    +`比例：${limits.ratios.join(' / ')}；最多 ${limits.maxImages} 张参考图、${videos} 条参考视频、${audios} 条参考音频；不支持独立首尾帧；每次 1 条。`
    +(maxPromptChars?'提示词最多 15000 字符；上游提示 1080p 和 4K 稳定性较低。':'');
  return {id,name:model.display_name||id,kind:'video',limits,description,
    apipath:{fields,modes,checkedAt:new Date().toISOString(),...(!modes.length?{modeOptional:true}:{}),...(maxPromptChars?{maxPromptChars}:{})}};
}

export function apipathDocumentedModel(doc: any): Omit<ApipathCatalogEntry, 'keyIds'> | null {
  const c = doc.content, id = doc.model_code;
  if (typeof id !== 'string' || !c || c.deprecated) return null;
  const known = APIPATH_MODELS.find(m => m.id === id && m.kind === doc.category);
  let limits: ModelInputLimits, apipath: ModelRoute['apipath'];
  if (doc.category === 'video') {
    const q = c.quick_reference, d = q?.duration;
    if (doc.endpoint !== '/v1/video/generations' || q?.model_code !== id || !d
      || !Array.isArray(q.include_fields) || !Array.isArray(q.generation_modes?.values) || !q.generation_modes.values.length
      || q.include_fields.some((v:unknown)=>typeof v!=='string'||!APIPATH_VIDEO_FIELDS.includes(v))
      || q.generation_modes.values.some((v:unknown)=>typeof v!=='string'||!APIPATH_VIDEO_MODES.includes(v)) || !q.count_options?.includes(1)
      || !Array.isArray(q.resolutions) || !q.resolutions.length || !Array.isArray(q.aspect_ratios) || !q.aspect_ratios.length
      || !q.endpoints?.query_sora?.includes('GET /v1/video/generations/{task_no}') || q.endpoints.query_sora_done !== 'completed') return null;
    const count = (r: any) => Number.isSafeInteger(r?.max) && r.max >= 0 && r.max <= 100 ? r.max : null;
    const image = count(q.reference_images), video = count(q.reference_videos), audio = count(q.reference_audios);
    if ([image,video,audio].some(v => v === null) || !['range','fixed','options'].includes(d.mode)
      || ![d.min,d.max,d.step].every(Number.isSafeInteger) || d.min < 1 || d.max > 3600 || d.max < d.min || d.step < 1
      || d.mode==='options'&&(!Array.isArray(d.options)||!d.options.length||!d.options.every((n:unknown)=>Number.isSafeInteger(n)&&Number(n)>=d.min&&Number(n)<=d.max))) return null;
    limits = { ...defaultRoutingLimits(), maxImages: Math.min(image!, Number.isInteger(q.max_total_images) ? q.max_total_images : image!), maxVideos: video!, maxAudios: audio!,
      firstFrame: q.frames?.first_frame_max === 1, lastFrame: q.frames?.last_frame_max === 1,
      ratios: q.aspect_ratios, resolutions: q.resolutions,
      duration: { mode: d.mode, min:d.min,max:d.max,step:d.step,values:d.mode==='options'?d.options:[] } };
    apipath = { fields: q.include_fields, modes: q.generation_modes.values, checkedAt: new Date().toISOString() };
  } else if (doc.category === 'image') {
    if (doc.endpoint !== '/v1/images/generations' || c.default_mode !== 'sync'
      || !Array.isArray(c.response_example?.data) || typeof c.response_example.data[0]?.url !== 'string') return null;
    const ratios = c.parameters?.find((p: any) => p.name === 'aspect_ratio')?.enum;
    if (!Array.isArray(ratios) || !ratios.length) return null;
    limits = known ? structuredClone(known.limits) : { ...defaultRoutingLimits(), maxImages: 1,
      resolutions: ['default'], ratios, qualities: c.parameters?.find((p: any) => p.name === 'quality')?.enum || [] };
  } else return null;
  const duration = limits.duration;
  const description = known?.description && doc.category==='image' ? known.description : `${doc.model_name || id}；分辨率：${limits.resolutions.map(r=>r==='default'?'上游默认':r).join(' / ')}；比例：${limits.ratios.join(' / ')}；`
    + (doc.category === 'video' ? `时长：${duration.mode === 'options' ? duration.values.join(' / ') : duration.min+'–'+duration.max} 秒${duration.mode==='range'?'（步长 '+duration.step+' 秒）':''}；` : '每次 1 张；')
    + `参考图最多 ${limits.maxImages} 张、参考视频 ${limits.maxVideos} 条、参考音频 ${limits.maxAudios} 条；`
    + `独立首帧${limits.firstFrame?'支持':'不支持'}、尾帧${limits.lastFrame?'支持':'不支持'}。`
    + (doc.category === 'image' && !known ? '参考图上限 1 张为本站限制；默认尺寸由上游决定。' : '');
  return { id, kind:doc.category, name:doc.model_name||id, limits, description, ...(apipath ? {apipath} : {}) };
}

export function manualApipathEntry(channelId: number, draft: ChannelModelDraft): ApipathCatalogEntry {
  const { kind, limits, upstreamModel: id } = draft;
  if (kind !== 'video' && kind !== 'image') throw fail('请选择图片或视频');
  const keys = apipathKeys(channelId).filter(key => key.status === 1 && key.kind === kind);
  if (!keys.length) throw fail('请先配置' + (kind === 'video' ? '视频' : '图片') + ' API Key');
  if (limits.qualities.length || (limits.outputsPerTask ?? 1) !== 1) throw fail('手动接入每次输出一份，使用默认质量');
  if (kind === 'video' && ![limits.duration.min, limits.duration.max, limits.duration.step, ...limits.duration.values].every(Number.isSafeInteger))
    throw fail('视频时长和步长请填写整数秒');
  if (kind === 'image' && (limits.maxVideos || limits.maxAudios || limits.firstFrame || limits.lastFrame
    || !isApipathSunburstSpec(id) && limits.resolutions.join() !== 'default'))
    throw fail('通联同步图片协议支持参考图，通用图片型号的分辨率由上游决定');
  const known = APIPATH_MODELS.find(model => model.id === id);
  const entry: ApipathCatalogEntry = { id, kind, limits, name: draft.displayName, keyIds: keys.map(key => key.id),
    description: known?.description ?? '',
    ...(kind === 'video' ? { apipath: { fields: APIPATH_VIDEO_FIELDS.filter(field => field !== 'generation_mode'),
      modes: [], modeOptional: true, checkedAt: new Date().toISOString() } } : {}) };
  if (known) validateApipathDraft(draft, { ...entry, kind: known.kind, limits: known.limits });
  return entry;
}

export function validateApipathDraft(draft: ChannelModelDraft, entry: ApipathCatalogEntry) {
  if (draft.kind !== entry.kind || draft.upstreamModel !== entry.id) throw fail('Vx-魅影的上游模型 ID 和生成类型必须与所选型号一致');
  const l = draft.limits, s = entry.limits, d = l.duration;
  const seconds = d.mode === 'options' ? d.values : d.mode === 'fixed' ? [d.min]
    : Array.from({length:Math.floor((d.max-d.min)/d.step)+1},(_,i)=>d.min+i*d.step);
  if (l.maxOutputs!==1 || l.outputsPerTask && l.outputsPerTask!==1 || l.maxImages>s.maxImages || l.maxVideos>s.maxVideos || l.maxAudios>s.maxAudios
    || l.firstFrame&&!s.firstFrame || l.lastFrame&&!s.lastFrame || l.ratios.some(v=>!s.ratios.includes(v)) || l.resolutions.some(v=>!s.resolutions.includes(v))
    || l.qualities.some(v=>!s.qualities.includes(v)) || draft.kind==='video' && seconds.some(v=>!allowsDuration(s.duration,v)))
    throw fail('Vx-魅影配置超出该型号文档公布的分辨率、时长、比例或素材限制');
}

export function bindApipathCatalogEntry(channelId: number, modelId: string, entry: ApipathCatalogEntry) {
  const active = apipathKeys(channelId).filter(k=>k.status===1 && k.kind===entry.kind);
  if (entry.keyIds.length && !entry.keyIds.some(id=>active.some(k=>k.id===id))) throw fail('核对期间对应类型的 Key 已变化，请重新读取授权目录');
  for (const key of apipathKeys(channelId)) {
    const ids: string[] = JSON.parse(key.supportedModels);
    const next = ids.filter(id=>id!==modelId);
    if (entry.keyIds.includes(key.id) && key.status===1) next.push(modelId);
    db.update(apipathChannelKeys).set({supportedModels:JSON.stringify([...new Set(next)])}).where(eq(apipathChannelKeys.id,key.id)).run();
  }
  // New model descriptions only; existing administrator text, prices and switches remain intact.
  const model = db.select().from(models).where(eq(models.modelId,modelId)).get();
  if (model && !model.description?.trim()) db.update(models).set({description:entry.description}).where(eq(models.id,model.id)).run();
}

export function previewApipathRequest(draft: ChannelModelDraft, entry: ApipathCatalogEntry, sample: V6kRequestSample) {
  if (!sample || typeof sample!=='object' || Array.isArray(sample)) throw fail('预览参数无效');
  const l=draft.limits,d=l.duration;
  const input={seconds:sample.seconds??l.defaultSeconds??(d.mode==='options'?d.values[0]:d.min),ratio:sample.ratio??l.ratios[0],resolution:sample.resolution??l.resolutions[0],
    images:sample.images??l.minImages,videos:sample.videos??0,audios:sample.audios??0,firstFrame:sample.firstFrame??false,lastFrame:sample.lastFrame??false,outputs:1};
  if (![input.images,input.videos,input.audios].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=100) || !Number.isSafeInteger(input.seconds)
    || typeof input.firstFrame!=='boolean'||typeof input.lastFrame!=='boolean') throw fail('预览参数无效');
  const mismatch=routingMismatches(l,input,draft.kind as 'image'|'video');if(mismatch.length)throw fail(mismatch.join('；'));
  const refs=(n:number,ext:string)=>Array.from({length:n},(_,i)=>`https://example.invalid/ref-${i+1}.${ext}`);
  if(draft.kind==='video')return {method:'POST',path:'/v1/video/generations',body:buildApipathVideoPayload(draft.upstreamModel,'请求体预览示例',{
    ...input,images:refs(input.images,'jpg'),videos:refs(input.videos,'mp4'),audios:refs(input.audios,'wav'),firstFrame:input.firstFrame?'https://example.invalid/first.jpg':'',lastFrame:input.lastFrame?'https://example.invalid/last.jpg':''},entry.apipath)};
  return {method:'POST',path:input.images?'/v1/images/edits':'/v1/images/generations',body:{model:draft.upstreamModel,prompt:'请求体预览示例',n:1,aspect_ratio:input.ratio,
    size:isApipathSunburstSpec(draft.upstreamModel)?apipathImageSize(input.ratio,input.resolution):'auto',quality:'auto',...(input.images?{'image[]':refs(input.images,'jpg')}:{})}};
}

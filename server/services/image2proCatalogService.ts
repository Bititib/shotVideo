import { eq } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { channels, models } from '../db/schema.js';
import { defaultRoutingLimits, type ModelInputLimits } from '../../shared/modelRouting.js';
import { image2proModels, type Image2proChannel } from './image2proAdapter.js';
import { getModelSpecification, saveModelSpecification } from './modelRoutingService.js';
export async function syncImage2proModels(c: Image2proChannel & { id: number; priority: number }) {
  const discovered = await image2proModels(c);
  // Synchronize only self describing media and Veo/Omni capabilities; legacy profiles are not guessed.
  const entries = discovered.filter((m: any) => m.metadata.type === 'text' || m.metadata.type === 'image' || m.metadata.media_contract === 1 || typeof m.metadata.supports_frame_control === 'boolean' || Number.isInteger(m.metadata.duration_min) && Number.isInteger(m.metadata.duration_max));
  let added = 0;
  sqlite.transaction(() => {
    for (const m of entries) {
      const old = db.select().from(models).where(eq(models.modelId, m.id)).get();
      if (old && old.provider !== 'image2pro') throw new Error('模型 ID 已存在，需核对产品身份：' + m.id);
      if(m.metadata.type==='text'){
        if(!old){db.insert(models).values({provider:'image2pro',modelId:m.id,displayName:m.name||m.id,capabilities:'["text"]',description:'Image2Pro Chat Completions；配置售价后启用。',isActive:0}).run();added++;}
        continue;
      }
      const md = m.metadata, kind = md.type as 'image' | 'video';
      const durationValues = Array.isArray(md.durations) ? md.durations.filter((v: unknown) => Number.isInteger(v) && Number(v) > 0) : Number.isInteger(md.duration_min)&&Number.isInteger(md.duration_max)&&md.duration_min>0&&md.duration_max>=md.duration_min&&md.duration_max<=120 ? Array.from({length:md.duration_max-md.duration_min+1},(_,i)=>md.duration_min+i) : [];
      if (kind === 'video' && !durationValues.length) throw new Error('Image2Pro 未公布视频时长：' + m.id);
      const limits: ModelInputLimits = { ...defaultRoutingLimits(), maxImages: Number.isSafeInteger(md.max_images) ? md.max_images : md.supports_reference_images ? 3 : md.supports_frame_control ? 2 : 0, firstFrame: md.supports_frame_control === true || md.modes?.includes('keyframe')===true, lastFrame: md.supports_frame_control === true || md.modes?.includes('keyframe')===true, maxVideos: Number.isSafeInteger(md.max_video_references)?md.max_video_references:0, maxAudios: Number.isSafeInteger(md.max_audio_references)?md.max_audio_references:0,
        minImages: Number.isSafeInteger(md.min_images) ? md.min_images : 0, maxOutputs: 1,
        resolutions: Array.isArray(md.resolutions) ? md.resolutions.length ? md.resolutions : ['auto'] : typeof md.size==='string'?[md.size]:['auto'], ratios: Array.isArray(md.aspect_ratios) ? md.aspect_ratios.length ? md.aspect_ratios : ['auto'] : ['auto'],
        duration: kind === 'video' ? { mode:'options', min: Math.min(...durationValues), max: Math.max(...durationValues), step:1, values:durationValues } : defaultRoutingLimits().duration };
      if (!old) { db.insert(models).values({ provider:'image2pro', modelId:m.id, displayName:m.name || m.id,
        capabilities:JSON.stringify([kind]), description:'Image2Pro 异步任务；配置售价与模型支持的参数后启用。', isActive:0 }).run(); added++; }
      const existing = getModelSpecification(m.id);
      if (existing?.routes.some(r => r.channelId === c.id)) continue;
      const route = { id:'image2pro-' + c.id + '-' + m.id, channelId:c.id, executionModel:m.id, upstreamModel:m.id,
        enabled:true, limits, cost:null, costUnit:'unknown' as const, resolutionCosts:{}, priority:c.priority };
      saveModelSpecification(existing ? {...existing, routes:[...existing.routes,route]} : {modelId:m.id,kind,enabled:true,aliases:[],limits,routes:[route]});
    }
    const saved=db.select().from(channels).where(eq(channels.id,c.id)).get()!;
    db.update(channels).set({ supportedModels:JSON.stringify([...new Set([...JSON.parse(saved.supportedModels || '[]'),...entries.map((m:any)=>m.id)])]),
      modelMapping:JSON.stringify({...Object.fromEntries(entries.map((m:any)=>[m.id,m.id])),...JSON.parse(saved.modelMapping || '{}')}), updatedAt:new Date().toISOString() }).where(eq(channels.id,c.id)).run();
  })();
  return {count:entries.length,added,models:entries.map((m:any)=>m.id),skipped:discovered.length-entries.length,warnings:['新模型默认停用；未公布图片规格时使用 auto（沿用上游默认），未公布参考图上限时不开放参考图。',...(discovered.length>entries.length?['部分视频型号尚未提供已接入的能力协议，本次未同步：'+discovered.filter((m:any)=>!entries.includes(m)).map((m:any)=>m.id).join('、')]:[])]};
}

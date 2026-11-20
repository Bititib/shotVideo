import { fetchHussModelIds, fetchHussUnifiedCapabilities, type HussChannel } from './hussVideoAdapter.js';
import { HUSS_MJ_MODEL, hussMjLimits } from '../../shared/hussMidjourney.js';
import { HUSS_HSS_B_MODEL, hussHssModelLimits } from '../../shared/hussBbVideo.js';
import { defaultRoutingLimits, type ModelInputLimits } from '../../shared/modelRouting.js';
import type { ChannelModelCatalogEntry } from '../../shared/channelModelConfiguration.js';

/** Parse the documented unified capability fields, not guesses based on model names. */
export function parseHussUnifiedLimits(entry:any): ModelInputLimits {
  const d=entry?.duration,r=entry?.reference_limits;
  const list=(v:any)=>Array.isArray(v)&&v.length>0&&v.every(x=>typeof x==='string'&&x.trim());
  if (!d || !Number.isSafeInteger(d.min) || !Number.isSafeInteger(d.max) || d.min<1 || d.max<d.min || d.max>3600
    || d.step!==undefined&&(!Number.isSafeInteger(d.step)||d.step<1)
    || d.enum!==undefined && (!Array.isArray(d.enum)||!d.enum.length||!d.enum.every((n:any)=>Number.isSafeInteger(n)&&n>=d.min&&n<=d.max))
    || !list(entry.resolutions)||!list(entry.ratios) || !r
    || !['images','videos','audios'].every(k=>Number.isSafeInteger(r[k])&&r[k]>=0&&r[k]<=100)
    || r.total!==undefined&&(!Number.isSafeInteger(r.total)||r.total<0||r.total>300)
    || entry.reference_transport!=='public_https_url') throw new Error('上游统一视频能力字段不完整或当前无法解析');
  if (entry.requirements && Object.keys(entry.requirements).length) throw new Error('此型号还有专属素材要求，尚未适配：'+Object.keys(entry.requirements).join('、'));
  const values=d.enum ? [...d.enum] : [];
  const limits:ModelInputLimits={...defaultRoutingLimits(),resolutions:[...entry.resolutions],ratios:[...entry.ratios],
    maxImages:r.images,maxVideos:r.videos,maxAudios:r.audios,...(r.total!==undefined?{maxReferences:r.total}:{}),
    duration:{mode:values.length?'options':'range',min:d.min,max:d.max,step:d.step??1,values}};
  if(d.default!==undefined){
    if(!Number.isSafeInteger(d.default)||d.default<d.min||d.default>d.max||values.length&&!values.includes(d.default))throw new Error('上游默认时长与能力范围不一致');
    limits.defaultSeconds=d.default;
  }
  return limits;
}

export async function hussAuthorizedCatalog(channel:HussChannel):Promise<ChannelModelCatalogEntry[]> {
  const ids=[...new Set(await fetchHussModelIds(channel))];
  let capabilities:any[]=[];let unavailable='此授权型号未出现在统一视频能力目录中；若为其他图片或文本协议，需要单独接入';
  if(ids.some(id=>id!==HUSS_MJ_MODEL))try{
    const raw=await fetchHussUnifiedCapabilities(channel);
    const rows=Array.isArray(raw)?raw:raw?.models??raw?.data;
    if(!Array.isArray(rows))throw new Error('统一视频能力接口未返回有效列表');
    capabilities=rows;
  }catch(error:any){unavailable='统一视频能力读取失败：'+error.message;}
  return ids.map(id=>{
    if(id===HUSS_MJ_MODEL)return {id,kind:'image',limits:hussMjLimits()};
    const entry=capabilities.find(e=>(e?.model??e?.id)===id);
    if(entry)try{return {id,kind:'video',limits:parseHussUnifiedLimits(entry)};}catch(error:any){return {id,kind:'video',unavailableReason:error.message};}
    // Existing B contract remains supported even when omitted from the public unified directory.
    if(id===HUSS_HSS_B_MODEL)return {id,kind:'video',limits:hussHssModelLimits()};
    return {id,unavailableReason:unavailable};
  });
}

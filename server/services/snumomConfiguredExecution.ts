import type { ModelSpecification } from '../../shared/modelRouting.js';
import type { SpecificationRequest } from './specificationAdapters.js';
import { probeReferenceVideoSeconds } from './videoDurationProbe.js';

export function snumomConfiguredPolicy(spec: ModelSpecification) {
  const policies = spec.routes.map(r=>r.snumom);
  if (!policies.some(Boolean)) return undefined;
  if (!policies.length || policies.some(p=>!p || JSON.stringify(p)!==JSON.stringify(policies[0]))) throw new Error('snumom 线路计费规则不一致，请检查配置');
  return policies[0]!;
}

/** Normalize aliases before the shared input parser; no client duration is trusted for billing. */
export function normalizeConfiguredSnumomBody(body: any) {
  for (const keys of [['seconds','duration','video_length','duration_seconds'],['resolution','output_resolution','size'],['aspect_ratio','ratio']]) {
    const values=keys.filter(k=>body[k]!==undefined).map(k=>keys[0]==='seconds'?Number(body[k]):String(body[k]).toLowerCase());
    if(new Set(values).size>1 || values.some(v=>typeof v==='number'&&!Number.isFinite(v))) throw new Error(keys.join('/')+' 参数不一致');
    if(values.length)body[keys[0]]=values[0];
  }
  if(body.input!==undefined || body.content!==undefined || body.prompt_extend!==undefined || body.parameters && Object.keys(body.parameters).length)
    throw new Error('此后台协议仅配置基础参数及图/视频/音频参考，不支持 input、content 或扩展参数');
  for(const key of ['reference_images','image_urls','images','reference_videos','video_urls','reference_audios','audio_urls','audios']) {
    if(!Array.isArray(body[key]))continue;
    body[key]=body[key].map((v:any)=>{
      if(typeof v==='string')return v;
      if(!v || typeof v.url!=='string' || v.role && v.role!=='reference_image')throw new Error('素材需为 URL；独立首尾帧请使用 first_frame/last_frame');
      return v.url;
    });
  }
}
export function validateConfiguredSnumomRequest(request: SpecificationRequest) {
  if(request.lastFrame&&!request.firstFrame)throw new Error('尾帧需要同时提供首帧');
  if((request.firstFrame||request.lastFrame)&&(request.images.length||request.videos.length||request.audios.length))throw new Error('独立首尾帧不能和普通参考素材混用');
}
export async function prepareConfiguredSnumomBilling(spec: ModelSpecification, request: SpecificationRequest) {
  const policy=snumomConfiguredPolicy(spec);
  if(!policy)return undefined;
  validateConfiguredSnumomRequest(request);
  const measured=policy.referenceVideoBilling && request.videos.length ? await probeReferenceVideoSeconds(request.videos) : {total:0,durations:[]};
  return { snumomConfiguredBilling:structuredClone(policy), referenceVideoSeconds:measured.total,
    referenceVideoDurations:measured.durations, billableSeconds:request.input.seconds+measured.total };
}

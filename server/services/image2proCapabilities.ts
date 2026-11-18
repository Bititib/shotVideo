import type { Image2proImageOptions } from '../../shared/channelModelConfiguration.js';
import { defaultRoutingLimits, type ModelInputLimits } from '../../shared/modelRouting.js';
export function image2proMediaSupported(m:any) { return m.metadata?.type === 'image' || m.metadata?.type === 'video' && (m.metadata.media_contract === 1 || typeof m.metadata.supports_frame_control === 'boolean' || Number.isInteger(m.metadata.duration_min) && Number.isInteger(m.metadata.duration_max)); }
export function image2proLimits(m:any): ModelInputLimits {
 if (!image2proMediaSupported(m)) throw new Error('Image2Pro 此型号尚未接入媒体协议：'+m.id);
      const md = m.metadata, kind = md.type as 'image' | 'video';
      const durationValues = Array.isArray(md.durations) ? md.durations.filter((v: unknown) => Number.isInteger(v) && Number(v) > 0) : Number.isInteger(md.duration_min)&&Number.isInteger(md.duration_max)&&md.duration_min>0&&md.duration_max>=md.duration_min&&md.duration_max<=120 ? Array.from({length:md.duration_max-md.duration_min+1},(_,i)=>md.duration_min+i) : [];
      if (kind === 'video' && !durationValues.length) throw new Error('Image2Pro 未公布视频时长：' + m.id);
      const limits: ModelInputLimits = { ...defaultRoutingLimits(), maxImages: Number.isSafeInteger(md.max_images) ? Math.min(kind === 'image' ? 16 : 100, md.max_images) : kind === 'image' ? (typeof md.image_to_image_price === 'number' && md.image_to_image_price >= 0 ? 1 : 0) : md.supports_reference_images ? 3 : md.supports_frame_control ? 2 : 0, firstFrame: md.supports_frame_control === true || md.modes?.includes('keyframe')===true, lastFrame: md.supports_frame_control === true || md.modes?.includes('keyframe')===true, maxVideos: Number.isSafeInteger(md.max_video_references)?md.max_video_references:0, maxAudios: Number.isSafeInteger(md.max_audio_references)?md.max_audio_references:0,
        minImages: Number.isSafeInteger(md.min_images) ? md.min_images : 0, maxOutputs: 1,
        resolutions: Array.isArray(md.resolutions) ? md.resolutions.length ? md.resolutions : ['auto'] : typeof md.size==='string'?[md.size]:['auto'], ratios: Array.isArray(md.aspect_ratios) ? md.aspect_ratios.length ? md.aspect_ratios : ['auto'] : ['auto'],
        duration: kind === 'video' ? { mode:'options', min: Math.min(...durationValues), max: Math.max(...durationValues), step:1, values:durationValues } : defaultRoutingLimits().duration };
 if (kind === 'image') { limits.firstFrame = false; limits.lastFrame = false; limits.maxVideos = 0; limits.maxAudios = 0; }
 else if (md.media_contract === 1) { limits.firstFrame = false; limits.lastFrame = false; limits.maxVideos = 0; limits.maxAudios = 0; }
 else if (typeof md.supports_frame_control === 'boolean') { limits.maxVideos = 0; limits.maxAudios = 0; }
 return limits;
}

// These are request-format limits, not a claim that every image model supports each value.
// Missing catalog enumerations must not disable documented configurable fields.
export function image2proImageOptions(m: any): Image2proImageOptions {
 const md=m.metadata;
 return {customRatios:!Array.isArray(md.aspect_ratios)||!md.aspect_ratios.length,
 customResolutions:!Array.isArray(md.resolutions)||!md.resolutions.length,
 maxImages:Number.isSafeInteger(md.max_images)?Math.min(16,md.max_images):16};
}
export function validImage2proRatio(v:string) { return v==='auto'||/^[1-9]\d{0,3}:[1-9]\d{0,3}$/.test(v); }
export function validImage2proResolution(v:string) { return v==='auto'||/^[1-9]\d?K$/i.test(v)||/^[1-9]\d{2,4}p$/i.test(v); }

import { defaultRoutingLimits, type ModelInputLimits } from './modelRouting.js';

export const V6K_FULL_720_MODEL = 'seadanco2.5-720-30';
export const V6K_FULL_720_LEGACY_UPSTREAM = '稳定极速seadanco2.5-720-30图';
export const V6K_FULL_720_LEGACY_DESCRIPTION = '30图/720P/5-30秒/不支持音频和视频参考/满参满血/按条计费';
// Exact provider spelling; the similarly named legacy model accepts images only.
export const V6K_FULL_720_UPSTREAM = '稳定极速seadnco2.5-720';
export const V6K_FULL_720_DESCRIPTION = '30图10音10视/720P/5-30秒/极速/按条计费';
export function v6kFull720Limits(): ModelInputLimits {
  return { ...defaultRoutingLimits(), maxImages: 30, maxVideos: 10, maxAudios: 10, resolutions: ['720p'],
    duration: { mode: 'range', min: 5, max: 30, step: 1, values: [] } };
}

/** Validate unsupported input before reservation; material aliases are counted by specificationRequest. */
export function normalizeFull720VideoInput(body: Record<string, any>, configured = false): void {
  if (!configured && body.model !== V6K_FULL_720_MODEL) return;
  const supplied = (key: string) => body[key] !== undefined && body[key] !== null && body[key] !== ''
    && (!Array.isArray(body[key]) || body[key].length > 0);
  if (['first_frame','first_frame_url','first_image','start_frame','last_frame','last_frame_url','last_image','end_frame','end_frame_url'].some(supplied))
    throw new Error('该型号不支持独立首尾帧，请使用普通参考图片');
  if (['content','input_reference','image'].some(supplied) || body.metadata?.content !== undefined)
    throw new Error('该型号参考图请使用 reference_images 或 images 数组');
  const durations = [body.seconds,body.duration,body.video_length,body.duration_seconds].filter(v => v !== undefined).map(Number);
  if (durations.some(v => !Number.isSafeInteger(v)) || new Set(durations).size > 1) throw new Error('视频时长字段必须一致且为整数秒');
  if (body.duration_seconds !== undefined && body.seconds === undefined) body.seconds = body.duration_seconds;
}

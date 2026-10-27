import { HUSS_BB_PUBLIC_MODEL, hussBbModelLimits, HUSS_HSS_MODEL, hussHssModelLimits } from '../../shared/hussBbVideo.js';
import { V6K_TTT_720_MODEL } from '../../shared/zonghengVideo.js';
import { defaultRoutingLimits, type ModelInputLimits } from '../../shared/modelRouting.js';
import { getHmStudioAdditionalVideoModel } from '../../shared/hmStudioVideo.js';
import { getHayaVideoSpec, hayaVideoSeconds, HAYA_XG_SEEDANCE_20_MODEL, HAYA_XG_RATIOS } from '../../shared/hayaVideo.js';
import { isLongxiaModel, longxiaResolution, LONGXIA_RATIOS } from '../../shared/longxiaVideo.js';
import { getSiYueTianC2Model, getSiYueTianSeedance25VideoSpec } from './siYueTianVideoModels.js';


/** Capability drafts come from existing adapters, never from the spelling of a display name. */
export function existingModelLimits(id: string, kind: 'image' | 'video'): ModelInputLimits | null {
  const l = defaultRoutingLimits();
  const video = (images: number, videos: number, audios: number, resolution: string, min = 4, max = 30) => ({ ...l, maxImages: images, maxVideos: videos, maxAudios: audios, resolutions: [resolution], duration: { mode: 'range' as const, min, max, step: 1, values: [] } });
  if (kind === 'image') {
    if (!/^(gpt-image-2(?:-siyuetian|-mingfei|\.5-flare|\.5-sunburst)?|nano-banana(?:-2|-2\.1|-2-lite|-pro))$/.test(id)) return null;
    const textOnly = ['gpt-image-2.5-flare', 'nano-banana-2.1', 'nano-banana-2-lite'].includes(id);
    return { ...l, maxImages: textOnly ? 0 : id === 'gpt-image-2-mingfei' ? 16 : 10, maxOutputs: 4, resolutions: id === 'gpt-image-2' ? ['1K','4K'] : ['1K','2K','4K'], ratios: ['1:1','16:9','9:16','4:3','3:4','3:2','2:3'] };
  }
  if (id === HUSS_HSS_MODEL) return hussHssModelLimits();
  if (id === HUSS_BB_PUBLIC_MODEL) return hussBbModelLimits();
  if (id === V6K_TTT_720_MODEL) return video(30,10,10,'720p',5,30);
  const hm = getHmStudioAdditionalVideoModel(id);
  if (hm) return { ...video(hm.maxImages, hm.maxVideos, hm.maxAudios, hm.resolution, hm.minSeconds, hm.maxSeconds), resolutions: [...(hm.resolutions || [hm.resolution])], firstFrame: hm.supportsDedicatedFrames, lastFrame: hm.supportsDedicatedFrames };
  if (id === 'seedance_v2.5') return { ...video(10,0,0,'720p'), firstFrame: true, lastFrame: true };
  const c2 = getSiYueTianC2Model(id); if (c2) return video(c2.images,c2.videos,c2.audios,c2.resolution,c2.minSeconds,c2.maxSeconds);
  const sy = getSiYueTianSeedance25VideoSpec(id); if (sy) return video(30,0,10,sy.resolution);
  const haya = getHayaVideoSpec(id);
  if (haya?.confirmedMediaLimits) {
    const seconds = hayaVideoSeconds(id);
    return { ...video(haya.maxImages,haya.maxVideos,haya.maxAudios,haya.resolution,seconds[0],seconds.at(-1)!),
      ...(id === HAYA_XG_SEEDANCE_20_MODEL ? { ratios: [...HAYA_XG_RATIOS] } : {}) };
  }
  if (isLongxiaModel(id)) return { ...video(30,0,10,longxiaResolution(id),4,25), ratios: [...LONGXIA_RATIOS] };
  if (id === 'sd2.5' || id === '2.5-s') return { ...video(id === 'sd2.5' ? 9 : 30, id === 'sd2.5' ? 0 : 10, id === 'sd2.5' ? 0 : 10, '720p'), duration: { mode: 'fixed', min: 30, max: 30, step: 1, values: [] } };
  if (/^(?:ad|vd|td|xd|nd|cd)-seedance-2\.[05]-(480p|720p)$/.test(id)) {
    const wide = /^(ad|td)-/.test(id), zeroAudio = /^(vd|xd)-/.test(id), zeroVideo = /^xd-/.test(id);
    return video(wide ? 30 : 9, wide ? 10 : zeroVideo ? 0 : 3, zeroAudio ? 0 : wide ? 10 : 3, id.endsWith('480p') ? '480p' : '720p', /^cd-/.test(id) ? 5 : 4, /2\.0/.test(id) ? 15 : 30);
  }
  if (id === 'seedance-2.5-deal') return { ...video(30,0,10,'720p',5,30), resolutions: ['480p','720p'] };
  if (id === 'seedance-2.5-pro') return { ...video(30,10,10,'720p'), resolutions: ['480p','720p'] };
  if (id === 'wan3.0th') return video(10,5,5,'720p');
  if (id === 'Minimax-H3-768p-933-10s-15s') return { ...video(9,3,3,'768p',10,15), duration: { mode: 'options', min: 10, max: 15, step: 1, values: [10,15] } };
  if (id === 'seedance-2.0' || id === 'sd2-mini') return video(9,0,id === 'sd2-mini' ? 3 : 0,'720p',4,15);
  return null;
}

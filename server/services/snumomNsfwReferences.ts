import { probeReferenceAudioSeconds, probeReferenceVideoSeconds } from './videoDurationProbe.js';
import { normalizeSnumomWanInputMedia, validateSnumomNsfwInput } from './snumomWanAdapter.js';
import { SNUMOM_WAN_NSFW_MODEL } from '../../shared/snumomWanNsfw.js';
import type { SpecificationRequest } from './specificationAdapters.js';

/** Server probes only; client-supplied duration hints never determine a debit. */
export async function prepareSnumomNsfwReferences(request: SpecificationRequest) {
  const promptExtend = request.body.parameters?.prompt_extend ?? request.body.prompt_extend;
  if (promptExtend !== undefined && typeof promptExtend !== 'boolean') throw new Error('prompt_extend 必须为布尔值');
  const smart = Number(request.body.parameters?.duration ?? request.body.duration_seconds ?? request.body.video_length ?? request.body.seconds ?? request.body.duration) === -1;
  const inputMedia = normalizeSnumomWanInputMedia(request.body.input?.media);
  validateSnumomNsfwInput({model:request.body.model,prompt:request.prompt,seconds:request.input.seconds,
    resolution:request.input.resolution,aspectRatio:request.input.ratio,smartDuration:smart,inputMedia,
    images:[...request.images.map(url=>({url})),...(request.firstFrame?[{url:request.firstFrame,role:'first_frame' as const}]:[]),...(request.lastFrame?[{url:request.lastFrame,role:'last_frame' as const}]:[])],
    videos:request.videos.map(url=>({url})),audios:request.audios.map(url=>({url}))});
  const video = request.videos.length ? await probeReferenceVideoSeconds(request.videos) : {rawDurations:[],durations:[],total:0};
  const audio = request.audios.length ? await probeReferenceAudioSeconds(request.audios) : {rawDurations:[],durations:[],total:0};
  if (video.durations.some(v=>v<1 || v>15) || video.total>15) throw new Error('Wan 3.0 参考视频单段须为1-15秒，合计不能超过15秒');
  if (audio.total>15) throw new Error('Wan 3.0 参考音频合计不能超过15秒');
  const outputSeconds = smart ? video.durations[0] : request.input.seconds;
  const chargeReferences=request.body.model===SNUMOM_WAN_NSFW_MODEL;
  if (!Number.isFinite(outputSeconds) || outputSeconds<=0 || (chargeReferences && outputSeconds+video.total>30)) throw new Error('输出与参考视频总时长不能超过30秒');
  request.input.seconds = outputSeconds;
  return {snumomReferenceBilling:true,outputSeconds,billableSeconds:outputSeconds+(chargeReferences?video.total:0),
    requestedSeconds:smart ? -1 : outputSeconds,referenceVideoSeconds:video.total,referenceVideoDurations:video.durations,referenceVideoRawDurations:video.rawDurations,
    referenceAudioSeconds:audio.total,referenceAudioDurations:audio.durations,referenceAudioRawDurations:audio.rawDurations};
}

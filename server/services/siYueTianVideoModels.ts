export const SI_YUE_TIAN_SEEDANCE_25_MAX_IMAGES = 30;
export const SI_YUE_TIAN_SEEDANCE_25_MAX_VIDEOS = 0;
export const SI_YUE_TIAN_SEEDANCE_25_MAX_AUDIOS = 10;
export const SI_YUE_TIAN_SEEDANCE_25_MIN_SECONDS = 4;
export const SI_YUE_TIAN_SEEDANCE_25_MAX_SECONDS = 30;

export const SI_YUE_TIAN_SEEDANCE_25_VIDEO_SPECS = [
  { id: 'seedance-2.5-480p', resolution: '480p', upstreamPrice: 3, price: 4 },
  { id: 'seedance-2.5-720p', resolution: '720p', upstreamPrice: 4, price: 5 },
  { id: 'seedance-2.5-1080p', resolution: '1080p', upstreamPrice: 5, price: 6 },
] as const;

export const SI_YUE_TIAN_SEEDANCE_25_VIDEO_MODELS = SI_YUE_TIAN_SEEDANCE_25_VIDEO_SPECS.map(spec => spec.id);

export function getSiYueTianSeedance25VideoSpec(modelId: string) {
  return SI_YUE_TIAN_SEEDANCE_25_VIDEO_SPECS.find(spec => spec.id === modelId);
}

export function validateSiYueTianSeedance25VideoInput(modelId: string, input: {
  seconds: number;
  resolution: string;
  imageCount: number;
  videoCount: number;
  audioCount: number;
}): string | null {
  const spec = getSiYueTianSeedance25VideoSpec(modelId);
  if (!spec) return null;
  if (!Number.isInteger(input.seconds) || input.seconds < SI_YUE_TIAN_SEEDANCE_25_MIN_SECONDS || input.seconds > SI_YUE_TIAN_SEEDANCE_25_MAX_SECONDS) {
    return `${modelId} 仅支持 ${SI_YUE_TIAN_SEEDANCE_25_MIN_SECONDS}-${SI_YUE_TIAN_SEEDANCE_25_MAX_SECONDS} 秒整数时长`;
  }
  if (input.resolution.toLowerCase() !== spec.resolution) {
    return `${modelId} 仅支持 ${spec.resolution}`;
  }
  if (input.imageCount > SI_YUE_TIAN_SEEDANCE_25_MAX_IMAGES) {
    return `${modelId} 最多支持 ${SI_YUE_TIAN_SEEDANCE_25_MAX_IMAGES} 张参考图片`;
  }
  if (input.videoCount > SI_YUE_TIAN_SEEDANCE_25_MAX_VIDEOS) {
    return `${modelId} 不支持参考视频`;
  }
  if (input.audioCount > SI_YUE_TIAN_SEEDANCE_25_MAX_AUDIOS) {
    return `${modelId} 最多支持 ${SI_YUE_TIAN_SEEDANCE_25_MAX_AUDIOS} 段参考音频`;
  }
  return null;
}

export function buildSiYueTianSeedance25VideoPayload(input: {
  model: string;
  prompt: string;
  seconds: number;
  aspectRatio: string;
  imageUrls: string[];
  audioUrls: string[];
}) {
  return {
    model: input.model,
    prompt: input.prompt,
    duration: input.seconds,
    aspect_ratio: input.aspectRatio,
    image_refs: input.imageUrls.length > 0 ? input.imageUrls : undefined,
    audio_refs: input.audioUrls.length > 0 ? input.audioUrls : undefined,
  };
}

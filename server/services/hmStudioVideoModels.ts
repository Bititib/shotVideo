export const HM_STUDIO_SEEDANCE_V20_933_MODEL = 'seedance_v2.0-933';
export const HM_STUDIO_SEEDANCE_V25_101010_MODEL = 'seedance_v2.5-101010';

export type HmStudioVideoModelSpec = {
  id: string;
  displayName: string;
  description: string;
  minSeconds: number;
  maxSeconds: number;
  resolution: '720p';
  maxImages: number;
  maxVideos: number;
  maxAudios: number;
  defaultPrice: number;
  faceRestricted: true;
};

export const HM_STUDIO_ADDITIONAL_VIDEO_MODELS: readonly HmStudioVideoModelSpec[] = [
  {
    id: HM_STUDIO_SEEDANCE_V20_933_MODEL,
    displayName: 'Seedance V2.0 933（HM Studio）',
    description: '卡脸；720p；支持4-15秒；最多9张图片、3个视频、3段音频参考；固定按次计费',
    minSeconds: 4,
    maxSeconds: 15,
    resolution: '720p',
    maxImages: 9,
    maxVideos: 3,
    maxAudios: 3,
    defaultPrice: 0.50,
    faceRestricted: true,
  },
  {
    id: HM_STUDIO_SEEDANCE_V25_101010_MODEL,
    displayName: 'Seedance V2.5 101010（HM Studio）',
    description: '卡脸；720p；支持4-30秒；最多10张图片、10个视频、10段音频参考；固定按次计费',
    minSeconds: 4,
    maxSeconds: 30,
    resolution: '720p',
    maxImages: 10,
    maxVideos: 10,
    maxAudios: 10,
    defaultPrice: 0.70,
    faceRestricted: true,
  },
] as const;

export const HM_STUDIO_ADDITIONAL_VIDEO_MODEL_IDS = HM_STUDIO_ADDITIONAL_VIDEO_MODELS.map(model => model.id);

export function getHmStudioAdditionalVideoModel(modelId: string): HmStudioVideoModelSpec | undefined {
  return HM_STUDIO_ADDITIONAL_VIDEO_MODELS.find(model => model.id === modelId);
}

export function validateHmStudioAdditionalVideoInput(modelId: string, input: {
  seconds: number;
  resolution: string;
  imageCount: number;
  videoCount: number;
  audioCount: number;
  hasFirstFrame?: boolean;
  hasLastFrame?: boolean;
}): string | null {
  const spec = getHmStudioAdditionalVideoModel(modelId);
  if (!spec) return null;
  if (!Number.isInteger(input.seconds) || input.seconds < spec.minSeconds || input.seconds > spec.maxSeconds) {
    return `${modelId} 仅支持 ${spec.minSeconds}-${spec.maxSeconds} 秒的整数时长`;
  }
  if (input.resolution.toLowerCase() !== spec.resolution) {
    return `${modelId} 仅支持 ${spec.resolution}`;
  }
  if (input.imageCount > spec.maxImages || input.videoCount > spec.maxVideos || input.audioCount > spec.maxAudios) {
    return `${modelId} 最多支持 ${spec.maxImages} 张图片、${spec.maxVideos} 个视频和 ${spec.maxAudios} 段音频参考`;
  }
  if (input.hasFirstFrame || input.hasLastFrame) {
    return `${modelId} 不支持首尾帧专用参数，请使用普通参考图片`;
  }
  return null;
}

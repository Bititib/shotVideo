export const HM_STUDIO_SEEDANCE_V20_933_MODEL = 'seedance_v2.0-933';
export const HM_STUDIO_SEEDANCE_V25_101010_MODEL = 'seedance_v2.5-101010';
export const HM_STUDIO_SEEDANCE_V25_301010_MODEL = 'seedance_v2.5-301010';
export const HM_STUDIO_FAST803_MODEL = 'SD2.0FAST803';
export const HM_STUDIO_FAST813_MODEL = 'SD2.0FAST813';
export const HM_STUDIO_MINI503_MODEL = 'SD2.0MINI503';

export const HM_STUDIO_UPSTREAM_VIDEO_MODEL_MAP: Readonly<Record<string, string>> = {
  'seedance_v2.5': 'MINIMAX-H3-2.5采样',
  [HM_STUDIO_SEEDANCE_V20_933_MODEL]: 'MINIMAX-H3-2.0采样-933',
  [HM_STUDIO_SEEDANCE_V25_101010_MODEL]: 'MINIMAX-H3-2.5采样-101010',
  [HM_STUDIO_SEEDANCE_V25_301010_MODEL]: 'MINIMAX-H3-2.5采样-301010',
  [HM_STUDIO_FAST803_MODEL]: HM_STUDIO_FAST803_MODEL,
  [HM_STUDIO_FAST813_MODEL]: HM_STUDIO_FAST813_MODEL,
  [HM_STUDIO_MINI503_MODEL]: HM_STUDIO_MINI503_MODEL,
};

export function getHmStudioUpstreamVideoModel(modelId: string): string {
  return HM_STUDIO_UPSTREAM_VIDEO_MODEL_MAP[modelId] || modelId;
}

export type HmStudioVideoModelSpec = {
  id: string;
  displayName: string;
  description: string;
  minSeconds: number;
  maxSeconds: number;
  resolution: '720p';
  resolutions?: readonly string[];
  resolutionPrices?: Readonly<Record<string, number>>;
  maxImages: number;
  maxVideos: number;
  maxAudios: number;
  defaultPrice: number;
  faceRestricted?: true;
  supportsDedicatedFrames: boolean;
};

export const HM_STUDIO_ADDITIONAL_VIDEO_MODELS: readonly HmStudioVideoModelSpec[] = [
  {
    id: HM_STUDIO_FAST803_MODEL,
    displayName: 'HM-Seedance V2.0 Fast 803',
    description: '720p/1080p/2k；支持4-15秒；最多8张图片、0个视频、3段音频参考；按分辨率按次计费',
    minSeconds: 4, maxSeconds: 15, resolution: '720p',
    resolutions: ['720p', '1080p', '2k'],
    resolutionPrices: { '720p': 1.10, '1080p': 1.30, '2k': 1.50 },
    maxImages: 8, maxVideos: 0, maxAudios: 3,
    defaultPrice: 1.10, supportsDedicatedFrames: true,
  },
  {
    id: HM_STUDIO_FAST813_MODEL,
    displayName: 'HM-Seedance V2.0 Fast 813',
    description: '720p/1080p/2k；支持4-15秒；最多8张图片、1个视频、3段音频参考；按分辨率按次计费',
    minSeconds: 4, maxSeconds: 15, resolution: '720p',
    resolutions: ['720p', '1080p', '2k'],
    resolutionPrices: { '720p': 1.30, '1080p': 1.50, '2k': 1.70 },
    maxImages: 8, maxVideos: 1, maxAudios: 3,
    defaultPrice: 1.30, supportsDedicatedFrames: true,
  },
  {
    id: HM_STUDIO_MINI503_MODEL,
    displayName: 'HM-Seedance V2.0 Mini 503',
    description: '720p；支持4-15秒；最多5张图片、0个视频、3段音频参考；固定按次计费',
    minSeconds: 4, maxSeconds: 15, resolution: '720p',
    maxImages: 5, maxVideos: 0, maxAudios: 3,
    defaultPrice: 0.90, supportsDedicatedFrames: true,
  },
  {
    id: HM_STUDIO_SEEDANCE_V20_933_MODEL,
    displayName: 'HM-Seedance V2.0 933',
    description: '卡脸；720p；支持4-15秒；最多9张图片、3个视频、3段音频参考；固定按次计费',
    minSeconds: 4,
    maxSeconds: 15,
    resolution: '720p',
    maxImages: 9,
    maxVideos: 3,
    maxAudios: 3,
    defaultPrice: 0.50,
    faceRestricted: true,
    supportsDedicatedFrames: true,
  },
  {
    id: HM_STUDIO_SEEDANCE_V25_101010_MODEL,
    displayName: 'HM-Seedance V2.5 101010',
    description: '卡脸；720p；支持4-30秒；最多10张图片、10个视频、10段音频参考；固定按次计费',
    minSeconds: 4,
    maxSeconds: 30,
    resolution: '720p',
    maxImages: 10,
    maxVideos: 10,
    maxAudios: 10,
    defaultPrice: 0.70,
    faceRestricted: true,
    supportsDedicatedFrames: true,
  },
  {
    id: HM_STUDIO_SEEDANCE_V25_301010_MODEL,
    displayName: 'HM-Seedance V2.5 301010',
    description: '卡脸；720p；支持4-30秒；最多30张图片、10个视频、10段音频参考；固定按次计费',
    minSeconds: 4,
    maxSeconds: 30,
    resolution: '720p',
    maxImages: 30,
    maxVideos: 10,
    maxAudios: 10,
    defaultPrice: 5.50,
    faceRestricted: true,
    supportsDedicatedFrames: true,
  },
] as const;

export const HM_STUDIO_ADDITIONAL_VIDEO_MODEL_IDS = HM_STUDIO_ADDITIONAL_VIDEO_MODELS.map(model => model.id);

export function getHmStudioAdditionalVideoModel(modelId: string): HmStudioVideoModelSpec | undefined {
  return HM_STUDIO_ADDITIONAL_VIDEO_MODELS.find(model => model.id === modelId);
}

export function normalizeHmStudioVideoResolution(modelId: string, resolution: unknown): string | undefined {
  const spec = getHmStudioAdditionalVideoModel(modelId);
  return spec ? String(resolution || spec.resolution).trim().toLowerCase() : undefined;
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
  const resolutions = spec.resolutions || [spec.resolution];
  if (!resolutions.includes(input.resolution.toLowerCase())) {
    return `${modelId} 仅支持 ${resolutions.join('/')}`;
  }
  const imageCount = input.imageCount + Number(Boolean(input.hasFirstFrame)) + Number(Boolean(input.hasLastFrame));
  if (imageCount > spec.maxImages || input.videoCount > spec.maxVideos || input.audioCount > spec.maxAudios) {
    return `${modelId} 最多支持 ${spec.maxImages} 张图片、${spec.maxVideos} 个视频和 ${spec.maxAudios} 段音频参考`;
  }
  if (!spec.supportsDedicatedFrames && (input.hasFirstFrame || input.hasLastFrame)) {
    return `${modelId} 不支持首尾帧专用参数，请使用普通参考图片`;
  }
  return null;
}

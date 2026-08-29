export const NEWTOKEN_VIDEO_MODELS = [
  'veo-omni-flash',
  'veo-omni-flash-video-edit',
  'veo-3-1',
  'nd-seedance-2.0-480p',
  'nd-seedance-2.0-720p',
] as const;

const NEWTOKEN_VIDEO_MODEL_SET = new Set<string>(NEWTOKEN_VIDEO_MODELS);

export function isNewTokenChannel(channel: { name?: string | null; baseUrl?: string | null } | null | undefined): boolean {
  if (!channel) return false;
  const baseUrl = String(channel.baseUrl || '').replace(/\/+$/, '').toLowerCase();
  return channel.name === 'NewToken 渠道' || baseUrl === 'https://newtoken.club';
}

export function isNewTokenVideoModel(model: string): boolean {
  return NEWTOKEN_VIDEO_MODEL_SET.has(model);
}

export function newTokenVideoCreateUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/v1/videos`;
}

function mapReferencePrompt(prompt: string, videoCount: number, audioCount: number): string {
  let result = prompt.replace(/\[ref_(\d+)(?:\.[a-zA-Z0-9]+)?\]/g, (_match, index) => `@Image${Number(index) + 1}`);
  for (let index = 0; index < videoCount; index++) {
    result = result.replace(new RegExp(`\\[ref_video_${index + 1}\\]`, 'g'), `@Video${index + 1}`);
  }
  result = result.replace(/\[ref_video\]/g, '@Video1');
  for (let index = 0; index < audioCount; index++) {
    result = result.replace(new RegExp(`\\[ref_audio_${index + 1}\\]`, 'g'), `@Audio${index + 1}`);
  }
  return result.replace(/\[ref_audio\]/g, '@Audio1');
}

export function buildNewTokenVideoPayload(input: {
  model: string;
  upstreamModel?: string;
  prompt: string;
  duration: number;
  aspectRatio: string;
  images?: string[];
  videos?: string[];
  audios?: string[];
  firstFrame?: string;
  lastFrame?: string;
  complianceEnabled?: boolean;
  complianceMode?: string;
}): Record<string, any> {
  if (!isNewTokenVideoModel(input.model)) {
    throw new Error(`Unsupported NewToken video model: ${input.model}`);
  }

  const images = input.images || [];
  const videos = input.videos || [];
  const audios = input.audios || [];
  const model = input.upstreamModel || input.model;
  const aspectRatio = input.aspectRatio === '9:16' ? '9:16' : '16:9';

  if (input.model === 'veo-omni-flash') {
    return {
      model,
      prompt: input.prompt.trim(),
      duration: 10,
      aspect_ratio: aspectRatio,
      ...(images.length > 0 ? { Ingredients_images: images } : {}),
    };
  }

  if (input.model === 'veo-omni-flash-video-edit') {
    if (videos.length !== 1) {
      throw new Error('veo-omni-flash-video-edit requires exactly one video_url');
    }
    return {
      model,
      prompt: input.prompt.trim(),
      duration: 10,
      aspect_ratio: aspectRatio,
      video_url: videos[0],
      ...(images.length > 0 ? { Ingredients_images: images } : {}),
    };
  }

  if (input.model === 'veo-3-1') {
    return {
      model,
      prompt: input.prompt.trim(),
      duration: 8,
      aspect_ratio: aspectRatio,
      ...(images.length > 0 ? { reference_images: images.slice(0, 9) } : {}),
      ...(input.firstFrame ? { first_frame_image: input.firstFrame } : {}),
      ...(input.lastFrame ? { last_frame_image: input.lastFrame } : {}),
    };
  }

  return {
    model,
    prompt: mapReferencePrompt(input.prompt.trim(), videos.length, audios.length),
    duration: input.duration,
    aspect_ratio: input.aspectRatio,
    ...(images.length > 0 ? { image_refs: images.slice(0, 9) } : {}),
    ...(videos.length > 0 ? { video_refs: videos.slice(0, 3) } : {}),
    ...(audios.length > 0 ? { audio_refs: audios.slice(0, 3) } : {}),
    ...(input.complianceEnabled !== undefined ? { compliance_enabled: input.complianceEnabled } : {}),
    ...(input.complianceMode ? { compliance_mode: input.complianceMode } : {}),
  };
}

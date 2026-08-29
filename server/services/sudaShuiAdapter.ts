export const SUDASHUI_VIDEO_CREATE_PATH = '/v1/video/generations';

export interface SudaShuiVideoPayloadInput {
  model: string;
  prompt: string;
  duration: number;
  aspectRatio: string;
  imageUrls?: string[];
  videoUrls?: string[];
  audioUrls?: string[];
}

function nonEmptyUrls(urls: string[] | undefined): string[] {
  return (urls || []).map(url => String(url || '').trim()).filter(Boolean);
}

/** Convert the placeholders accepted by our public APIs into SudaShui references. */
export function normalizeSudaShuiPrompt(prompt: string): string {
  return String(prompt || '')
    .trim()
    .replace(/\[ref_(\d+)(?:\.[a-zA-Z0-9]+)?\]/g, (_match, index) => `@image${Number(index) + 1}`)
    .replace(/\[ref_video_(\d+)\]/g, '@video$1')
    .replace(/\[ref_video\]/g, '@video1')
    .replace(/\[ref_audio_(\d+)\]/g, '@audio$1')
    .replace(/\[ref_audio\]/g, '@audio1');
}

/** Build the exact JSON body accepted by POST /v1/video/generations. */
export function buildSudaShuiVideoPayload(input: SudaShuiVideoPayloadInput): Record<string, unknown> {
  const imageUrls = nonEmptyUrls(input.imageUrls);
  const videoUrls = nonEmptyUrls(input.videoUrls);
  const audioUrls = nonEmptyUrls(input.audioUrls);
  const providerPayload = {
    aspectRatio: input.aspectRatio,
    mode: 'references',
    ...(imageUrls.length ? { imageUrls } : {}),
    ...(videoUrls.length ? { videoUrls } : {}),
    ...(audioUrls.length ? { audioUrls } : {}),
  };

  return {
    model: input.model,
    prompt: normalizeSudaShuiPrompt(input.prompt),
    duration: input.duration,
    metadata: {
      payload: JSON.stringify(providerPayload),
    },
  };
}

export function sudaShuiVideoCreateUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${SUDASHUI_VIDEO_CREATE_PATH}`;
}

export const JULUN_MINIMAX_H3_MODEL = 'Minimax-H3-768p-933-10s-15s';
export const JULUN_MINIMAX_H3_RESOLUTION = '768p';
export const JULUN_MINIMAX_H3_SECONDS = [10, 15] as const;
export const JULUN_SD25_MODEL = 'sd2.5';
export const JULUN_HOSTNAME = 'julun.cc';

export function isJulunChannel(channel: { baseUrl?: string | null } | null | undefined): boolean {
  if (!channel?.baseUrl) return false;
  try {
    return new URL(channel.baseUrl).hostname.toLowerCase() === JULUN_HOSTNAME;
  } catch {
    return false;
  }
}

export function isJulunMinimaxH3Model(model: unknown): boolean {
  return String(model || '') === JULUN_MINIMAX_H3_MODEL;
}

export function buildJulunMinimaxH3Payload(input: {
  model?: string;
  prompt: string;
  seconds: number;
  ratio: string;
  imageUrls?: string[];
  videoUrls?: string[];
  audioUrls?: string[];
}): Record<string, unknown> {
  return {
    model: input.model || JULUN_MINIMAX_H3_MODEL,
    prompt: input.prompt,
    seconds: input.seconds,
    ratio: input.ratio,
    resolution: JULUN_MINIMAX_H3_RESOLUTION,
    image_urls: input.imageUrls?.length ? input.imageUrls.slice(0, 9) : undefined,
    video_urls: input.videoUrls?.length ? input.videoUrls.slice(0, 3) : undefined,
    audio_urls: input.audioUrls?.length ? input.audioUrls.slice(0, 3) : undefined,
  };
}

export function buildJulunSd25Payload(input: {
  prompt: string;
  ratio: string;
  imageUrls?: string[];
}): Record<string, unknown> {
  return {
    model: JULUN_SD25_MODEL,
    prompt: input.prompt,
    seconds: 30,
    ratio: input.ratio,
    resolution: '720p',
    image_urls: input.imageUrls?.length ? input.imageUrls.slice(0, 10) : undefined,
  };
}

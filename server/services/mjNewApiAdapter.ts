export interface MjNewApiChannelLike {
  baseUrl?: string | null;
}

export interface MjNewApiVideoPayloadInput {
  model: string;
  prompt: string;
  duration: number;
  aspectRatio: string;
  resolution: string;
  images?: string[];
  videos?: string[];
  audios?: string[];
}

export function isMjNewApiChannel(channel: MjNewApiChannelLike | null | undefined): boolean {
  if (!channel?.baseUrl) return false;
  try {
    return new URL(channel.baseUrl).hostname.toLowerCase() === 'mjnewapi.diwdiw.cn';
  } catch {
    return false;
  }
}

export function normalizeMjNewApiPrompt(prompt: string): string {
  return prompt
    .replace(/\[ref_(\d+)(?:\.[a-zA-Z0-9]+)?\]/g, (_match, idxStr) => `@Image${Number(idxStr) + 1}`)
    .replace(/\[ref_video_(\d+)\]/g, (_match, idxStr) => `@Video${Number(idxStr)}`)
    .replace(/\[ref_video\]/g, '@Video1')
    .replace(/\[ref_audio_(\d+)\]/g, (_match, idxStr) => `@Audio${Number(idxStr)}`)
    .replace(/\[ref_audio\]/g, '@Audio1');
}

export function buildMjNewApiVideoPayload(input: MjNewApiVideoPayloadInput): Record<string, unknown> {
  const images = input.images?.filter(Boolean) || [];
  const videos = input.videos?.filter(Boolean) || [];
  const audios = input.audios?.filter(Boolean) || [];

  return {
    model: input.model,
    prompt: normalizeMjNewApiPrompt(input.prompt.trim()),
    duration: input.duration,
    aspect_ratio: input.aspectRatio,
    resolution: input.resolution,
    ...(images.length > 0 ? { images } : {}),
    ...(videos.length > 0 ? { videos } : {}),
    ...(audios.length > 0 ? { audios } : {}),
  };
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

export function isPublicHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return url.protocol === 'https:'
      && hostname !== 'localhost'
      && hostname !== '::1'
      && !hostname.endsWith('.local')
      && !isPrivateIpv4(hostname);
  } catch {
    return false;
  }
}

export function findInvalidMjNewApiMaterialUrls(...groups: string[][]): string[] {
  return groups.flat().filter(url => !isPublicHttpsUrl(url));
}

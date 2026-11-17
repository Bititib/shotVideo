import { defaultRoutingLimits, type ModelInputLimits } from './modelRouting.js';

export const WANFENG_CHANNEL_TYPE = 'wanfeng';
export const WANFENG_BASE_URL = 'https://api.pro666.top';

export function wanfengBaseUrl(url: string) {
  if (!/^https:\/\/api\.pro666\.top(?:\/v1)?\/?$/i.test(url.trim())) {
    throw new Error('晚风统一视频接口地址应为 ' + WANFENG_BASE_URL);
  }
  return WANFENG_BASE_URL;
}

const publicModels = {
  'm-sd2.0-fast-903-720p': [4, 15, 9, 3, 3, false],
  'sd2-903-720p': [15, 15, 9, 0, 3, false],
  'sd2-933-720p': [4, 15, 9, 3, 3, false],
  'sd2-933-720p-cf': [4, 15, 9, 3, 3, false],
  'sd2-fast-903-720p': [4, 15, 9, 3, 3, false],
  'sd2.0': [4, 15, 9, 3, 3, true],
  'sd2.0-933-pro': [4, 15, 9, 3, 3, true],
  'sd2.0-fast-933': [4, 15, 9, 3, 3, true],
  'sd2.0-mini-933': [4, 15, 9, 3, 3, true],
  'sd2.5': [4, 30, 30, 10, 10, true],
  'sd2.5-flash': [4, 30, 10, 0, 5, true],
  'sd2.5-pro': [4, 30, 30, 10, 10, true],
  'video-v1': [4, 15, 9, 0, 0, false],
  'video-v2': [5, 15, 9, 0, 0, false],
} as const;

export function wanfengVideoLimits(id: string): ModelInputLimits | undefined {
  if (!Object.hasOwn(publicModels, id)) return;
  const [min, max, maxImages, maxVideos, maxAudios, multiResolution] = publicModels[id as keyof typeof publicModels];
  const values = id === 'video-v2' ? [5, 10, 15] : [];
  return {
    ...defaultRoutingLimits(), maxImages, maxVideos, maxAudios,
    resolutions: multiResolution ? ['480p', '720p'] : ['720p'],
    ratios: ['16:9', '9:16', '1:1'], firstFrame: true, lastFrame: true,
    duration: { mode: values.length ? 'options' : min === max ? 'fixed' : 'range', min, max, step: 1, values },
  };
}

export const wanfengVideoCatalog = () => Object.keys(publicModels).map(id => ({ id, limits: wanfengVideoLimits(id)! }));

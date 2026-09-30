// Explicitly supported by the existing video route/adapters. Unknown models
// remain usable in other modes; never infer multimodal support from a name.
export type VideoReferenceLimits = { images: number; videos: number; audios: number; wavOnly?: boolean };
export function canvasVideoReferenceLimits(model: string): VideoReferenceLimits | undefined {
  if (['ad-seedance-2.5-480p', 'td-seedance-2.5-720p'].includes(model)) return { images: 30, videos: 10, audios: 10 };
  if (['vd-seedance-2.5-480p', 'vd-seedance-2.5-720p'].includes(model)) return { images: 9, videos: 3, audios: 0 };
  if (['Minimax-H3-768p-933-10s-15s', 'sd-mini'].includes(model)) return { images: 9, videos: 3, audios: 3 };
  if (['wan3.0th', 'wan3.0-video', 'wan3.0-video-prime'].includes(model)) return { images: 10, videos: 5, audios: 5, wavOnly: model === 'wan3.0th' };
}

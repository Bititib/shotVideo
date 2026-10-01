// Duration/resolution defaults follow the existing model families until upstream confirmation.
export const SI_YUE_TIAN_C2_MODELS = [
  { id: 'seedance-2.0-c2', name: 'Seedance 2.0 C2', images: 9, videos: 0, audios: 3, price: 2.5, minSeconds: 4, maxSeconds: 15, resolution: '720p' },
  { id: 'seedance-2.0-fast-c2', name: 'Seedance 2.0 Fast C2', images: 9, videos: 1, audios: 3, price: 2, minSeconds: 5, maxSeconds: 15, resolution: '720p' },
  { id: 'wan-3.0-c2', name: 'Wan 3.0 C2', images: 10, videos: 5, audios: 5, price: 3, minSeconds: 4, maxSeconds: 30, resolution: '720p' },
] as const;

export function getSiYueTianC2Model(model: string) {
  return SI_YUE_TIAN_C2_MODELS.find(spec => spec.id === model);
}

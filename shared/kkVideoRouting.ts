export const KK_VIDEO_MODEL = 'kkseadanco2.5';
export const KK_VIDEO_SOURCES = { stable: '稳定seadanco2.5-720', kk: KK_VIDEO_MODEL } as const;
export type KkVideoSource = keyof typeof KK_VIDEO_SOURCES;
export type KkVideoRouting = { primary: KkVideoSource; fallback: boolean; channelId: number };
export function isKkVideoSource(value: unknown): value is KkVideoSource {
  return value === 'stable' || value === 'kk';
}

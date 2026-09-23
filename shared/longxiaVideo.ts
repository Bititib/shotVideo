export const LONGXIA_MODELS = [
  'LongXia-video-seedance2_5-standard-480p-express-PerSecond',
  'LongXia-video-seedance2_5-standard-720p-express-PerSecond',
] as const;

export const LONGXIA_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
export const LONGXIA_SECONDS = Array.from({ length: 22 }, (_, index) => index + 4);
export function isLongxiaModel(model: string): boolean {
  return (LONGXIA_MODELS as readonly string[]).includes(model);
}
export function longxiaResolution(model: string): '480p' | '720p' {
  return model === LONGXIA_MODELS[0] ? '480p' : '720p';
}
export function longxiaRate(model: string): number {
  return model === LONGXIA_MODELS[0] ? 0.4 : 0.58;
}

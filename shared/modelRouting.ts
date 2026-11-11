export type MediaKind = 'image' | 'video';
export type DurationRule = { mode: 'range' | 'fixed' | 'options'; min: number; max: number; step: number; values: number[] };
export type ModelInputLimits = {
  /** Documented default used when a caller omits the video duration. */
  defaultSeconds?: number;
  /** Optional combined cap across all reference types. */
  maxReferences?: number;
  /** A native image task produces this many results with one upstream submission. */
  outputsPerTask?: number;
  maxImages: number; maxVideos: number; maxAudios: number; maxOutputs: number; minImages: number;
  resolutions: string[]; ratios: string[]; duration: DurationRule;
  firstFrame: boolean; lastFrame: boolean; qualities: string[];
};
export type ModelRoute = {
  minikey?: { upstreamChannel: number | null; imageProtocol: 'banana' | 'size' };
  id: string; channelId: number; executionModel: string; upstreamModel: string; enabled: boolean;
  limits: ModelInputLimits; cost: number | null; costUnit: 'per_call' | 'per_second' | 'per_image' | 'unknown';
  resolutionCosts: Record<string, number>; priority: number;
};
export type ModelSpecification = {
  kkRouting?: import('./kkVideoRouting.js').KkVideoRouting;
  /** Image siblings share a model family and legacy aliases; each has one output resolution. */
  imageFamily?: string;
  modelId: string; kind: MediaKind; enabled: boolean; aliases: string[]; limits: ModelInputLimits; routes: ModelRoute[];
};
export type RoutingInput = {
  images: number; videos: number; audios: number; outputs: number; seconds: number;
  resolution: string; ratio: string; firstFrame: boolean; lastFrame: boolean; quality?: string;
};
export const defaultRoutingLimits = (): ModelInputLimits => ({
  maxImages: 0, maxVideos: 0, maxAudios: 0, maxOutputs: 1, minImages: 0,
  resolutions: ['720p'], ratios: ['16:9', '9:16', '1:1'],
  duration: { mode: 'range', min: 4, max: 30, step: 1, values: [] },
  firstFrame: false, lastFrame: false, qualities: [],
});
export function allowsDuration(rule: DurationRule, seconds: number): boolean {
  if (rule.mode === 'fixed') return seconds === rule.min;
  if (rule.mode === 'options') return rule.values.includes(seconds);
  const steps = (seconds - rule.min) / rule.step;
  return seconds >= rule.min && seconds <= rule.max && Math.abs(steps - Math.round(steps)) < 1e-8;
}
export function routingMismatches(l: ModelInputLimits, i: RoutingInput, kind: MediaKind): string[] {
  const reasons: string[] = [];
  const images = i.images + Number(i.firstFrame) + Number(i.lastFrame);
  if (images < l.minImages || images > l.maxImages) reasons.push('图片数量需为 ' + l.minImages + '–' + l.maxImages);
  if (i.videos > l.maxVideos) reasons.push('视频最多 ' + l.maxVideos + ' 个');
  if (i.audios > l.maxAudios) reasons.push('音频最多 ' + l.maxAudios + ' 段');
  if (l.maxReferences !== undefined && images + i.videos + i.audios > l.maxReferences) reasons.push('图片、视频和音频合计最多 ' + l.maxReferences + ' 项');
  if (i.outputs > l.maxOutputs) reasons.push('输出最多 ' + l.maxOutputs + ' 个');
  if (l.outputsPerTask && i.outputs !== l.outputsPerTask) reasons.push('每次任务固定返回 ' + l.outputsPerTask + ' 张图片');
  if (i.firstFrame && !l.firstFrame) reasons.push('不支持独立首帧');
  if (i.lastFrame && !l.lastFrame) reasons.push('不支持独立尾帧');
  if (l.resolutions.length && !l.resolutions.some(r => r.toLowerCase() === i.resolution.toLowerCase())) reasons.push('分辨率不匹配');
  if (l.ratios.length && !l.ratios.includes(i.ratio)) reasons.push('宽高比不匹配');
  if (i.quality && l.qualities.length && !l.qualities.includes(i.quality)) reasons.push('质量档位不匹配');
  if (kind === 'video' && !allowsDuration(l.duration, i.seconds)) reasons.push('时长不匹配');
  return reasons;
}
export function routeRequestCost(route: ModelRoute, input: RoutingInput): number | null {
  if (route.costUnit === 'unknown') return null;
  const rate = Object.entries(route.resolutionCosts).find(([key]) => key.toLowerCase() === input.resolution.toLowerCase())?.[1] ?? route.cost;
  if (rate === null || !Number.isFinite(rate) || rate < 0) return null;
  const calls = route.limits.outputsPerTask ? input.outputs / route.limits.outputsPerTask : input.outputs;
  return rate * (route.costUnit === 'per_second' ? input.seconds : route.costUnit === 'per_call' ? calls : input.outputs);
}


export function canShareImageAliases(a: ModelSpecification, b: ModelSpecification): boolean {
  return a.kind === 'image' && b.kind === 'image' && Boolean(a.imageFamily) && a.imageFamily === b.imageFamily
    && a.limits.resolutions.length === 1 && b.limits.resolutions.length === 1
    && a.limits.resolutions[0].toLowerCase() !== b.limits.resolutions[0].toLowerCase();
}
export function imageSpecificationId(family: string, resolution: string) { return family + '-' + resolution.toLowerCase(); }

export type MediaKind = 'image' | 'video';
export type DurationRule = { mode: 'range' | 'fixed' | 'options'; min: number; max: number; step: number; values: number[] };
export type ModelInputLimits = {
  /** A native image task produces this many results with one upstream submission. */
  outputsPerTask?: number;
  maxImages: number; maxVideos: number; maxAudios: number; maxOutputs: number; minImages: number;
  resolutions: string[]; ratios: string[]; duration: DurationRule;
  firstFrame: boolean; lastFrame: boolean; qualities: string[];
};
export type ModelRoute = {
  id: string; channelId: number; executionModel: string; upstreamModel: string; enabled: boolean;
  limits: ModelInputLimits; cost: number | null; costUnit: 'per_call' | 'per_second' | 'per_image' | 'unknown';
  resolutionCosts: Record<string, number>; priority: number;
};
export type ModelSpecification = {
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
export function routingMismatches(l: ModelInputLimits, i: RoutingInput, kind: MediaKind): string[] {
  const reasons: string[] = [];
  const images = i.images + Number(i.firstFrame) + Number(i.lastFrame);
  if (images < l.minImages || images > l.maxImages) reasons.push('图片数量需为 ' + l.minImages + '–' + l.maxImages);
  if (i.videos > l.maxVideos) reasons.push('视频最多 ' + l.maxVideos + ' 个');
  if (i.audios > l.maxAudios) reasons.push('音频最多 ' + l.maxAudios + ' 段');
  if (i.outputs > l.maxOutputs) reasons.push('输出最多 ' + l.maxOutputs + ' 个');
  if (l.outputsPerTask && i.outputs !== l.outputsPerTask) reasons.push('每次任务固定返回 ' + l.outputsPerTask + ' 张图片');
  if (i.firstFrame && !l.firstFrame) reasons.push('不支持独立首帧');
  if (i.lastFrame && !l.lastFrame) reasons.push('不支持独立尾帧');
  if (l.resolutions.length && !l.resolutions.some(r => r.toLowerCase() === i.resolution.toLowerCase())) reasons.push('分辨率不匹配');
  if (l.ratios.length && !l.ratios.includes(i.ratio)) reasons.push('宽高比不匹配');
  if (i.quality && l.qualities.length && !l.qualities.includes(i.quality)) reasons.push('质量档位不匹配');
  if (kind === 'video') {
    const d = l.duration;
    const valid = d.mode === 'fixed' ? i.seconds === d.min : d.mode === 'options' ? d.values.includes(i.seconds)
      : i.seconds >= d.min && i.seconds <= d.max && Math.abs((i.seconds - d.min) / d.step - Math.round((i.seconds - d.min) / d.step)) < 1e-8;
    if (!valid) reasons.push('时长不匹配');
  }
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

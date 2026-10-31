import type { VideoModel } from '../api/video';

export interface VideoModelCard extends VideoModel {
  displayKey?: string;
  resolutionModels?: Record<string, VideoModel>;
}

export function tt25Resolution(id: string): string | null {
  const match = /^(?:ZH-|zongheng-)?TTseadanco2\.5-(480|720|1080)$/.exec(id);
  return match ? match[1] + 'p' : null;
}

/** A presentation group only; quotes, validation and generation always use a real model ID. */
export function groupTt25ModelCards(models: VideoModel[], selectedModel: string, resolution: string): VideoModelCard[] {
  const family = models.filter(model => tt25Resolution(model.id));
  if (family.length < 2) return models;
  const byResolution: Record<string, VideoModel> = {};
  const constraints = (model: VideoModel) => JSON.stringify({
    maxSeconds: model.maxSeconds, allowedSeconds: model.allowedSeconds, requireRef: Boolean(model.requireRef),
    limits: model.routingLimits ? { ...model.routingLimits, resolutions: [] } : null,
  });
  const expected = constraints(family[0]);
  for (const model of family) {
    const native = tt25Resolution(model.id)!;
    const rate = model.rates?.[native as keyof NonNullable<VideoModel['rates']>];
    // Never hide distinct products/prices or join models with incompatible material limits.
    if (byResolution[native] || model.billingType !== 'per_second' || typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0
      || constraints(model) !== expected || model.routingLimits && !model.routingLimits.resolutions.includes(native)) return models;
    byResolution[native] = model;
  }
  const ordered = Object.entries(byResolution).sort(([a], [b]) => parseInt(a) - parseInt(b));
  const selected = family.find(model => model.id === selectedModel)
    || (byResolution[resolution]?.available ? byResolution[resolution] : undefined)
    || ordered.find(([, model]) => model.available)?.[1] || ordered[0][1];
  const limits = selected.routingLimits;
  const description = limits
    ? `${ordered.map(([value]) => value.toUpperCase()).join(' / ')} · ${limits.duration.min}–${limits.duration.max}秒；最多${limits.maxImages}图、${limits.maxVideos}视频、${limits.maxAudios}音频`
    : selected.description;
  const card: VideoModelCard = { ...selected, displayKey: 'tt-seedance-2.5', name: 'TT Seedance 2.5', description,
    rates: Object.fromEntries(ordered.map(([value, model]) => [value, model.rates![value as keyof NonNullable<VideoModel['rates']>]])),
    resolutionModels: Object.fromEntries(ordered) };
  let shown = false;
  return models.flatMap(model => {
    if (!tt25Resolution(model.id)) return [model];
    if (shown) return [];
    shown = true;
    return [card];
  });
}

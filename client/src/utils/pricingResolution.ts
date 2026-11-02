import { getHmStudioAdditionalVideoModel, getHmStudioPublicVideoModel, isHmStudioDdlongVideoModel } from '../../../shared/hmStudioVideo';
import { snumomOutputOnlySpec } from '../../../shared/snumomWanNsfw';

const WAN_RESOLUTIONS = ['480p', '720p', '1080p'];
const MINGFEI_RESOLUTIONS = ['1K', '2K', '4K'];

export function isResolutionPriceKey(key: string): boolean {
  return /^(?:\d{3,4}p|\d+k)$/i.test(String(key || '').trim());
}

// Retain archived prices in storage, but do not advertise them as current capabilities.
export function isArchivedResolutionPrice(modelPattern: string, key: string): boolean {
  if (!isResolutionPriceKey(key) || !isHmStudioDdlongVideoModel(modelPattern)) return false;
  const spec = getHmStudioAdditionalVideoModel(getHmStudioPublicVideoModel(modelPattern));
  return Boolean(spec && !(spec.resolutions || [spec.resolution]).some(resolution => resolution.toLowerCase() === key.toLowerCase()));
}

function sortResolutionKeys(keys: string[]): string[] {
  return [...keys].sort((left, right) => {
    const numeric = (value: string) => value.toLowerCase().endsWith('k')
      ? Number.parseFloat(value) * 1000
      : Number.parseInt(value, 10);
    return numeric(left) - numeric(right);
  });
}

export function pricingResolutionFields(
  modelPattern: string,
  extraParams: Record<string, unknown> = {},
): { keys: string[]; values: Record<string, string | number>; otherText: string } {
  const existingKeys = Object.keys(extraParams).filter(key => isResolutionPriceKey(key) && !isArchivedResolutionPrice(modelPattern, key));
  const hmSpec = getHmStudioAdditionalVideoModel(getHmStudioPublicVideoModel(modelPattern));
  const keys = sortResolutionKeys(Array.from(new Set([
    ...(snumomOutputOnlySpec(modelPattern) ? [snumomOutputOnlySpec(modelPattern)!.resolution] : []),
    ...(['wan3.0-video-nsfw'].includes(modelPattern) ? WAN_RESOLUTIONS : []),
    ...(modelPattern === 'gpt-image-2-mingfei' ? MINGFEI_RESOLUTIONS : []),
    ...(hmSpec?.resolutions || (hmSpec ? [hmSpec.resolution] : [])),
    ...existingKeys,
  ].map(key => existingKeys.find(existing => existing.toLowerCase() === key.toLowerCase()) || key))));
  const values: Record<string, string | number> = Object.fromEntries(keys.map(key => {
    const value = extraParams[key];
    return [key, typeof value === 'number' || typeof value === 'string' ? value : ''];
  }));
  const otherText = Object.entries(extraParams)
    .filter(([key]) => key !== 'category' && !isResolutionPriceKey(key))
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
  return { keys, values, otherText };
}

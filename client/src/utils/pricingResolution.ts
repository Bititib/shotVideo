const WAN_RESOLUTIONS = ['480p', '720p', '1080p'];

export function isResolutionPriceKey(key: string): boolean {
  return /^(?:\d{3,4}p|\d+k)$/i.test(String(key || '').trim());
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
  const existingKeys = Object.keys(extraParams).filter(isResolutionPriceKey);
  const keys = sortResolutionKeys(Array.from(new Set([
    ...(modelPattern === 'wan3.0-video' || modelPattern === 'wan3.0-video-prime' ? WAN_RESOLUTIONS : []),
    ...existingKeys,
  ])));
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

/** Reference limits for the legacy website adapters. Managed specifications publish their own limits. */
export function legacyImageReferenceLimit(modelId: string): number {
  if (modelId === 'gpt-image-2-mingfei') return 16;
  if (['gpt-image-2-siyuetian', 'gpt-image-2.5-sunburst', 'nano-banana-2', 'nano-banana-pro'].includes(modelId)) return 9;
  if (['gpt-image-2.5-flare', 'nano-banana-2.1', 'nano-banana-2-lite'].includes(modelId)) return 0;
  return modelId.startsWith('gpt-image') ? 5 : 0;
}

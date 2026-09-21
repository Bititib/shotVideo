export interface VideoReferenceCounts {
  images: number;
  videos: number;
  audios: number;
}

export interface VideoReferenceAssets {
  images: string[];
  videos: string[];
  audios: string[];
}

function firstAssetList(meta: Record<string, unknown>, arrayKeys: string[], scalarKeys: string[]): string[] {
  for (const key of arrayKeys) {
    const value = meta[key];
    if (Array.isArray(value)) {
      const assets = value.filter((item): item is string => typeof item === 'string' && item.length > 0);
      if (assets.length > 0) return assets;
    }
  }
  for (const key of scalarKeys) {
    const value = meta[key];
    if (typeof value === 'string' && value.length > 0) return [value];
  }
  return [];
}

/** Normalize reference fields written by the web UI, API and older records. */
export function getVideoReferenceAssets(metadata: unknown): VideoReferenceAssets {
  let meta: Record<string, unknown> = {};
  try {
    meta = typeof metadata === 'string' ? JSON.parse(metadata || '{}') : ((metadata || {}) as Record<string, unknown>);
  } catch { }
  return {
    images: firstAssetList(meta, ['reference_images', 'image_urls', 'images', 'image_refs', 'referenceImages'], ['reference_image', 'image_url']),
    videos: firstAssetList(meta, ['reference_videos', 'video_urls', 'videos', 'video_refs', 'referenceVideos'], ['reference_video', 'video_url']),
    audios: firstAssetList(meta, ['audio_urls', 'reference_audios', 'audios', 'audio_refs', 'referenceAudios'], ['audio_url', 'reference_audio']),
  };
}

/** Include counts retained by compact list responses when inline media is omitted. */
export function getVideoReferenceCounts(metadata: unknown): VideoReferenceCounts {
  let meta: Record<string, any> = {};
  try {
    meta = typeof metadata === 'string' ? JSON.parse(metadata || '{}') : ((metadata || {}) as Record<string, any>);
  } catch { }
  const assets = getVideoReferenceAssets(meta);
  const compacted = meta.referenceAssetCounts && typeof meta.referenceAssetCounts === 'object'
    ? meta.referenceAssetCounts
    : {};
  const count = (key: keyof VideoReferenceCounts, fallback: number) => {
    const value = Number(compacted[key]);
    return Math.max(fallback, Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);
  };
  return {
    images: count('images', assets.images.length),
    videos: count('videos', assets.videos.length),
    audios: count('audios', assets.audios.length),
  };
}

export function restoreVideoPromptRefs(targetPrompt: string): string {
  if (!targetPrompt) return '';
  return targetPrompt
    .replace(/\[ref_(\d+)(?:\.[a-zA-Z0-9]+)?\]/g, (_match, idxStr) => `@图${Number(idxStr) + 1}`)
    .replace(/\[ref_video_(\d+)\]/g, (_match, idxStr) => `@视频${Number(idxStr)}`)
    .replace(/\[ref_video\]/g, '@视频1')
    .replace(/\[ref_audio_(\d+)\]/g, (_match, idxStr) => `@音频${Number(idxStr)}`)
    .replace(/\[ref_audio\]/g, '@音频1');
}

export type VideoPromptReferenceLabel = '图' | '视频' | '音频';

/** Remove one visible reference mention and keep later numbered mentions aligned with the asset list. */
export function removeVideoPromptReference(
  prompt: string,
  label: VideoPromptReferenceLabel,
  removedIndex: number,
): string {
  if (!prompt || removedIndex < 1) return prompt;

  const pattern = label === '图'
    ? /([@＠])图(\d+)([ \t]?)/g
    : new RegExp(`([@＠])${label}(\\d*)([ \\t]?)`, 'g');

  return prompt.replace(pattern, (match, atSign: string, rawIndex: string, trailingSpace: string) => {
    const index = rawIndex ? Number(rawIndex) : 1;
    if (!Number.isFinite(index)) return match;
    if (index === removedIndex) return '';
    if (index > removedIndex) return `${atSign}${label}${index - 1}${trailingSpace}`;
    return match;
  });
}

function hasNumberedMention(prompt: string, label: '图' | '视频' | '音频', index: number): boolean {
  return new RegExp(`[@＠]${label}${index}(?!\\d)`).test(prompt);
}

export function buildReplicatedVideoPrompt(rawPrompt: string, counts: VideoReferenceCounts): string {
  const restored = restoreVideoPromptRefs(rawPrompt);
  const missing: string[] = [];

  for (let index = 1; index <= counts.images; index++) {
    if (!hasNumberedMention(restored, '图', index)) missing.push(`@图${index}`);
  }
  for (let index = 1; index <= counts.videos; index++) {
    if (!hasNumberedMention(restored, '视频', index)) missing.push(`@视频${index}`);
  }
  for (let index = 1; index <= counts.audios; index++) {
    if (!hasNumberedMention(restored, '音频', index)) missing.push(`@音频${index}`);
  }

  if (missing.length === 0) return restored;
  return `${missing.join(' ')}${restored.trim() ? '\n\n' : ''}${restored.trimStart()}`;
}

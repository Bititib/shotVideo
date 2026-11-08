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

export function getVideoReferenceFrames(meta: Record<string, unknown>): { first: string | null; last: string | null } {
  const read = (keys: string[]) => keys.map(key => meta[key]).find(value => typeof value === 'string' && value.length > 0) as string | undefined;
  return { first: read(['first_frame', 'first_frame_url', 'firstFrame']) || null,
    last: read(['last_frame', 'last_frame_url', 'end_frame_url', 'lastFrame']) || null };
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
    .replace(/\[ref_(\d+)(?:\.[a-zA-Z0-9]+)?\]/g, (_match, idxStr) => `@Image${Number(idxStr) + 1}`)
    .replace(/\[ref_video_(\d+)\]/g, (_match, idxStr) => `@Video${Number(idxStr)}`)
    .replace(/\[ref_video\]/g, '@Video1')
    .replace(/\[ref_audio_(\d+)\]/g, (_match, idxStr) => `@Audio${Number(idxStr)}`)
    .replace(/\[ref_audio\]/g, '@Audio1')
    .replace(/[@＠](图片|图|视频|音频)(\d*)/g, (_, kind: string, index: string) => '@' + ({图片:'Image',图:'Image',视频:'Video',音频:'Audio'} as Record<string,string>)[kind] + (index || '1'));
}

export type VideoPromptReferenceLabel = '图' | '视频' | '音频';

/** Remove one visible reference mention and keep later numbered mentions aligned with the asset list. */
export function removeVideoPromptReference(
  prompt: string,
  label: VideoPromptReferenceLabel,
  removedIndex: number,
): string {
  if (!prompt || removedIndex < 1) return prompt;

  const name = {图:'Image',视频:'Video',音频:'Audio'}[label];
  return restoreVideoPromptRefs(prompt).replace(new RegExp('@' + name + '(\\d+)([ \\t]?)', 'g'), (match, rawIndex: string, space: string) => {
    const index = Number(rawIndex);
    if (index === removedIndex) return '';
    return index > removedIndex ? '@' + name + (index - 1) + space : match;
  });
}

export function buildReplicatedVideoPrompt(rawPrompt: string, counts: VideoReferenceCounts): string {
  const restored = restoreVideoPromptRefs(rawPrompt);
  const missing: string[] = [];
  for (const [kind, count] of [['Image',counts.images],['Video',counts.videos],['Audio',counts.audios]] as const) {
    for (let index = 1; index <= count; index++) {
      if (!new RegExp(`@${kind}${index}(?!\\d)`).test(restored)) missing.push(`@${kind}${index}`);
    }
  }
  return missing.length ? `${missing.join(' ')}${restored.trim() ? '\n\n' : ''}${restored.trimStart()}` : restored;
}

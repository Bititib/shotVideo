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

export function restoreVideoPromptRefs(targetPrompt: string): string {
  if (!targetPrompt) return '';
  return targetPrompt
    .replace(/\[ref_(\d+)(?:\.[a-zA-Z0-9]+)?\]/g, (_match, idxStr) => `@图${Number(idxStr) + 1}`)
    .replace(/\[ref_video_(\d+)\]/g, (_match, idxStr) => `@视频${Number(idxStr)}`)
    .replace(/\[ref_video\]/g, '@视频1')
    .replace(/\[ref_audio_(\d+)\]/g, (_match, idxStr) => `@音频${Number(idxStr)}`)
    .replace(/\[ref_audio\]/g, '@音频1');
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

export type MediaReferenceKind = 'image' | 'video' | 'audio';
export type MediaReferenceCounts = Record<MediaReferenceKind, number>;
export const MEDIA_REFERENCE_NAMES = { image: 'Image', video: 'Video', audio: 'Audio' } as const;
export const MEDIA_REFERENCE_LABELS = { image: '图片', video: '视频', audio: '音频' } as const;
export type MediaReference = {
    start: number;
    text: string;
    kind: MediaReferenceKind;
    index: number;
    rawIndex: string;
    syntax: 'legacy' | 'canvas' | 'mention' | 'bare';
    numbered: boolean;
};
/** Only token parsing lives here. Channel-specific transports/states never do. */
export function parseMediaReferences(prompt: string): MediaReference[] {
    const aliases: Record<string, MediaReferenceKind> = { Image: 'image', image: 'image', Video: 'video', video: 'video', Audio: 'audio', audio: 'audio', 图: 'image', 图片: 'image', 视频: 'video', 音频: 'audio' };
    const pattern = /\[ref_(?:(video|audio)(?:_(\d+))?|(\d+)(?:\.[a-zA-Z0-9]+)?)\]|参考(图片|视频|音频)(\d+)(?!\d)|(?<![\w@])[@＠](Image|Video|Audio|image|video|audio|图片|图|视频|音频)(\d*)(?![A-Za-z0-9_])|(?<![\w@])@(\d+)(?![\w])|(图片|视频|音频)[ \t]*(\d+)(?!\d)/g;
    return Array.from(prompt.matchAll(pattern)).filter(m => !m[6] || Boolean(m[7]) || !/^[A-Za-z]+$/.test(m[6])).map(m => {
        if (m[1] || m[3] !== undefined)
            return { start: m.index!, text: m[0], kind: (m[1] || 'image') as MediaReferenceKind,
                index: m[3] !== undefined ? Number(m[3]) + 1 : Number(m[2] ?? 1), rawIndex: m[3] ?? m[2] ?? '1', syntax: 'legacy' as const, numbered: m[3] !== undefined || m[2] !== undefined };
        const kind = aliases[m[4] || m[6] || m[9]] || 'image', raw = m[5] ?? m[7] ?? m[8] ?? m[10];
        return { start: m.index!, text: m[0], kind, index: Number(raw || 1), rawIndex: raw || '1',
            syntax: m[4] ? 'canvas' as const : m[9] ? 'bare' as const : 'mention' as const, numbered: Boolean(raw) };
    });
}
export function renderMediaReferences(prompt: string, options: {
    names?: Record<MediaReferenceKind, string>;
    include?: (ref: MediaReference) => boolean;
    index?: (ref: MediaReference) => number;
} = {}): string {
    let result = prompt;
    for (const ref of parseMediaReferences(prompt).reverse()) {
        if (options.include && !options.include(ref))
            continue;
        const index = options.index ? options.index(ref) : ref.index;
        if (!Number.isSafeInteger(index) || index < 1)
            continue;
        result = result.slice(0, ref.start) + '@' + (options.names || MEDIA_REFERENCE_NAMES)[ref.kind] + index + result.slice(ref.start + ref.text.length);
    }
    return result;
}
export function missingMediaReferences(prompt: string, counts: MediaReferenceCounts, include: (ref: MediaReference) => boolean = () => true): MediaReference[] {
    return parseMediaReferences(prompt).filter(ref => include(ref) && (!Number.isSafeInteger(ref.index) || ref.index < 1 || ref.index > counts[ref.kind]));
}
/** Shared new-submission boundary. Keep legacy placeholders for their channel's
 * historical numbering; do not mutate arrays, reorder, deduplicate or drop media.
 */
export function prepareMediaSubmission<T>(prompt: string, assets: {
    images: T[];
    videos: T[];
    audios: T[];
}, frameCount = 0) {
    const counts = { image: assets.images.length + frameCount, video: assets.videos.length, audio: assets.audios.length };
    const current = (ref: MediaReference) => ref.syntax === 'canvas' || ref.syntax === 'mention';
    const missing = missingMediaReferences(prompt, counts, current);
    if (missing.length)
        throw new Error(`素材引用 ${missing[0].text} 没有对应素材，本次实际提交${counts[missing[0].kind]}个${MEDIA_REFERENCE_LABELS[missing[0].kind]}参考。请补齐素材或修正编号。`);
    return { prompt: renderMediaReferences(prompt, { include: current }), images: [...assets.images], videos: [...assets.videos], audios: [...assets.audios] };
}

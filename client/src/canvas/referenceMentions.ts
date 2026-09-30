import type { CanvasNode, GenerationDraft } from './model';

export type ReferenceBindings = Record<string, string>;
export const referenceKinds = { image: '图片', video: '视频', audio: '音频' } as const;
export function bindReferences(previous: ReferenceBindings = {}, nodes: CanvasNode[]): ReferenceBindings {
  const next = { ...previous };
  for (const node of nodes) {
    if (node.kind === 'text' || !node.src || Object.values(next).includes(node.id)) continue;
    const prefix = referenceKinds[node.kind];
    let number = 1;
    while (next[prefix + number]) number++;
    next[prefix + number] = node.id;
  }
  return next;
}
export function referenceLabel(bindings: ReferenceBindings, id: string) {
  return Object.keys(bindings).find(key => bindings[key] === id);
}
export function insertReference(prompt: string, start: number, end: number, label: string) {
  const token = '@' + label + ' ';
  return { prompt: prompt.slice(0, start) + token + prompt.slice(end), caret: start + token.length };
}
/** Match the per-media order actually submitted by CanvasStudio, not visual position. */
export function resolveReferenceMentions(prompt: string, bindings: ReferenceBindings, nodes: CanvasNode[], options: Pick<GenerationDraft, 'kind' | 'videoMode' | 'firstFrameId' | 'lastFrameId'>) {
  let error = '';
  const resolved = prompt.replace(/@(图片|视频|音频)(\d+)(?!\d)/g, (token, kind, number) => {
    const node = nodes.find(n => n.id === bindings[kind + number]);
    if (!node?.src || node.kind === 'text' || node.job?.status === 'running') {
      error ||= `${token} 的素材已断开或不可用，请重新引用或删除提示词中的标记。`;
      return token;
    }
    if (options.kind === 'video' && options.videoMode === 'frames' && node.kind === 'image') {
      if (node.id === options.firstFrameId) return '首帧参考图片';
      if (node.id === options.lastFrameId) return '尾帧参考图片';
      error ||= `${token} 未设为首帧或尾帧，本次不会使用，请重新选择。`;
      return token;
    }
    const list = nodes.filter(n => n.kind === node.kind && n.src);
    return `参考${referenceKinds[node.kind]}${list.findIndex(n => n.id === node.id) + 1}`;
  });
  return { prompt: resolved, error };
}

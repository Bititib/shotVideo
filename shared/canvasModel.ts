export type Point = { x: number; y: number };
export type View = Point & { zoom: number };
export type NodeKind = 'text' | 'image' | 'video' | 'audio';
export type CanvasVersion = { id: string; src: string; prompt: string; model?: string; ratio?: string; resolution?: string; createdAt: number; requestId?: string; contentId?: number };
export type CanvasNode = Point & {
  id: string; kind: NodeKind; title: string; text: string; width: number; height: number;
  src?: string; assetFolder?: string; group?: string; model?: string; ratio?: string;
  generator?: boolean; versions?: CanvasVersion[];
  settings?: { resolution: string; seconds: number };
  origin?: { projectId: string; nodeId: string; title: string };
  job?: { status: 'running' | 'done' | 'error' | 'interrupted'; contentId?: number; requestId?: string; expectedCount?: number; message: string; progress?: number };
};
export type Edge = { id: string; from: string; to: string };
export type GenerationDraft = { kind: 'image' | 'video' | 'audio'; prompt: string; model: string; ratio: string; resolution: string; seconds: number; count?: number; videoMode?: 'text' | 'reference' | 'frames' | 'edit' | 'multimodal'; firstFrameId?: string; lastFrameId?: string; voice?: string; referenceBindings?: Record<string, string> };
export type CanvasDocument = { assetFolders?: string[]; id: string; title: string; nodes: CanvasNode[]; edges: Edge[]; view: View; updatedAt: number; drafts?: Record<string, GenerationDraft> };
export type Workspace = { version: 2; activeId: string; projects: CanvasDocument[]; cloudRevision?: number; cloudPending?: boolean };
export type Snapshot = Pick<CanvasDocument, 'nodes' | 'edges'>;
export const uid = () => globalThis.crypto?.randomUUID?.() ?? `canvas-${Date.now()}-${Math.random().toString(36).slice(2)}`;
export const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
export function newDocument(title = '未命名画布'): CanvasDocument {
  return { id: uid(), title, nodes: [], edges: [], view: { x: 0, y: 0, zoom: 1 }, updatedAt: Date.now() };
}
export function newNode(kind: NodeKind, at: Point, text = ''): CanvasNode {
  return { id: uid(), kind, ...at, title: kind === 'text' ? '灵感笔记' : kind === 'image' ? '图像创作' : kind === 'audio' ? '音频创作' : '视频素材', text, width: 300, height: kind === 'text' ? 228 : kind === 'audio' ? 180 : 270 };
}
export function screenToWorld(point: Point, view: View): Point { return { x: (point.x - view.x) / view.zoom, y: (point.y - view.y) / view.zoom }; }
export function zoomAround(view: View, point: Point, factor: number): View {
  const zoom = clamp(view.zoom * factor, .15, 2.5), ratio = zoom / view.zoom;
  return { zoom, x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio };
}
export function bounds(nodes: CanvasNode[]) {
  if (!nodes.length) return { x: 0, y: 0, width: 600, height: 400 };
  const x = Math.min(...nodes.map(n => n.x)), y = Math.min(...nodes.map(n => n.y));
  return { x, y, width: Math.max(...nodes.map(n => n.x + n.width)) - x, height: Math.max(...nodes.map(n => n.y + n.height)) - y };
}
export function fitView(nodes: CanvasNode[], width: number, height: number): View {
  const b = bounds(nodes), zoom = clamp(Math.min(Math.max(1, width - (width < 600 ? 48 : 160)) / b.width, Math.max(1, height - (height < 500 ? 48 : 160)) / b.height), .15, 1.25);
  return { zoom, x: (width - b.width * zoom) / 2 - b.x * zoom, y: (height - b.height * zoom) / 2 - b.y * zoom };
}
export function intersects(node: CanvasNode, a: Point, b: Point) {
  return node.x + node.width >= Math.min(a.x, b.x) && node.x <= Math.max(a.x, b.x)
    && node.y + node.height >= Math.min(a.y, b.y) && node.y <= Math.max(a.y, b.y);
}
export function arrange(nodes: CanvasNode[], ids: string[]): CanvasNode[] {
  const chosen = nodes.filter(n => ids.includes(n.id));
  if (!chosen.length) return nodes;
  const b = bounds(chosen), columns = Math.ceil(Math.sqrt(chosen.length));
  const cellW = Math.max(...chosen.map(n => n.width)) + 48, cellH = Math.max(...chosen.map(n => n.height)) + 64;
  return nodes.map(n => {
    const i = chosen.findIndex(c => c.id === n.id);
    return i < 0 ? n : { ...n, x: b.x + (i % columns) * cellW, y: b.y + Math.floor(i / columns) * cellH };
  });
}
export function canConnect(edges: Edge[], from: string, to: string): boolean {
  if (from === to || edges.some(e => e.from === from && e.to === to)) return false;
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (id === from) return true;
    if (visited.has(id)) return false;
    visited.add(id);
    return edges.filter(e => e.from === id).some(e => visit(e.to));
  };
  return !visit(to);
}
export function duplicateSelection(doc: Snapshot, ids: string[]): { snapshot: Snapshot; ids: string[] } {
  const mapping = new Map(ids.map(id => [id, uid()]));
  const groups = new Map<string, string>();
  const copies = doc.nodes.filter(n => mapping.has(n.id)).map(n => {
    if (n.group && !groups.has(n.group)) groups.set(n.group, uid());
    return { ...n, id: mapping.get(n.id)!, title: `${n.title} 副本`, x: n.x + 40, y: n.y + 40,
      group: n.group ? groups.get(n.group) : undefined, job: n.job?.status === 'running' ? undefined : n.job };
  });
  const edges = doc.edges.filter(e => mapping.has(e.from) && mapping.has(e.to)).map(e => ({ id: uid(), from: mapping.get(e.from)!, to: mapping.get(e.to)! }));
  return { snapshot: { nodes: [...doc.nodes, ...copies], edges: [...doc.edges, ...edges] }, ids: copies.map(n => n.id) };
}
export type History = { past: Snapshot[]; future: Snapshot[] };
export function checkpoint(history: History, snapshot: Snapshot): History { return { past: [...history.past.slice(-39), snapshot], future: [] }; }
export function stepHistory(history: History, current: Snapshot, direction: 'undo' | 'redo') {
  const source = direction === 'undo' ? history.past : history.future;
  if (!source.length) return { history, snapshot: current };
  const snapshot = source[source.length - 1];
  return { snapshot, history: direction === 'undo'
    ? { past: history.past.slice(0, -1), future: [...history.future, current] }
    : { past: [...history.past, current], future: history.future.slice(0, -1) } };
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 1e7;
export function safeMedia(value: unknown): value is string {
  return typeof value === 'string' && (/^data:(image\/(png|jpeg|webp|gif)|video\/(mp4|webm)|audio\/(mpeg|mp3|wav|x-wav|ogg|webm));base64,[a-z0-9+/=\s]+$/i.test(value)
    || /^https?:\/\//i.test(value) || /^\/(?!\/)/.test(value));
}
// Validate backups before they can enter the editor. Legacy drafts keep their positions and images.
export function parseDocument(raw: any): CanvasDocument {
  if (!raw || typeof raw !== 'object') throw new Error('画布文件格式不正确');
  const source = raw.nodes ?? raw.items;
  if (!Array.isArray(source)) throw new Error('画布文件格式不正确');
  const ids = new Set<string>();
  const nodes: CanvasNode[] = source.map((n: any) => {
    if (!n || !finite(n.x) || !finite(n.y) || typeof n.id !== 'string' || ids.has(n.id)) throw new Error('画布中存在无效素材');
    ids.add(n.id);
    const kind: NodeKind = n.kind ?? (n.image ? 'image' : 'text');
    if (!['text', 'image', 'video', 'audio'].includes(kind)) throw new Error('不支持的素材类型');
    const src = n.src ?? n.image;
    if (src && !safeMedia(src)) throw new Error('画布中存在不支持的素材地址');
    return { id: n.id, kind, x: n.x, y: n.y, width: finite(n.width) ? clamp(n.width, 220, 1000) : 300,
      height: finite(n.height) ? clamp(n.height, 160, 1000) : kind === 'text' ? 228 : 270,
      title: typeof n.title === 'string' ? n.title.slice(0, 120) : kind === 'text' ? '灵感笔记' : '图片素材',
      text: typeof n.text === 'string' ? n.text.slice(0, 50000) : '', src,
      assetFolder: typeof n.assetFolder === 'string' && n.assetFolder.trim() ? n.assetFolder.trim().slice(0,40) : undefined,
      generator: n.generator === true || undefined,
      versions: Array.isArray(n.versions) ? n.versions.slice(-100).filter((v: any) => v && typeof v.id === 'string' && safeMedia(v.src)).map((v: any) => ({ id: v.id, src: v.src, prompt: typeof v.prompt === 'string' ? v.prompt.slice(0, 50000) : '', model: typeof v.model === 'string' ? v.model : undefined, ratio: typeof v.ratio === 'string' ? v.ratio : undefined, resolution: typeof v.resolution === 'string' ? v.resolution : undefined, createdAt: Number.isSafeInteger(v.createdAt) ? v.createdAt : 0, requestId: typeof v.requestId === 'string' ? v.requestId : undefined, contentId: Number.isSafeInteger(v.contentId) ? v.contentId : undefined })) : undefined,
      group: typeof n.group === 'string' ? n.group : undefined, model: typeof n.model === 'string' ? n.model : undefined,
      ratio: typeof n.ratio === 'string' ? n.ratio : undefined,
      settings: n.settings && typeof n.settings.resolution === 'string' && finite(n.settings.seconds) ? { resolution: n.settings.resolution.slice(0, 20), seconds: n.settings.seconds } : undefined,
      origin: n.origin && ['projectId', 'nodeId', 'title'].every(k => typeof n.origin[k] === 'string') ? { projectId: n.origin.projectId, nodeId: n.origin.nodeId, title: n.origin.title.slice(0, 120) } : undefined,
      job: n.job && ['running', 'done', 'error', 'interrupted'].includes(n.job.status) ? {
        status: n.job.status === 'running' && !(Number.isSafeInteger(n.job.contentId) && n.job.contentId > 0) && !(typeof n.job.requestId === 'string' && /^[a-zA-Z0-9-]{16,100}$/.test(n.job.requestId)) ? 'interrupted' : n.job.status,
        requestId: typeof n.job.requestId === 'string' && /^[a-zA-Z0-9-]{16,100}$/.test(n.job.requestId) ? n.job.requestId : undefined,
        expectedCount: Number.isInteger(n.job.expectedCount) ? clamp(n.job.expectedCount, 1, 4) : undefined,
        contentId: Number.isSafeInteger(n.job.contentId) && n.job.contentId > 0 ? n.job.contentId : undefined,
        message: typeof n.job.message === 'string' ? n.job.message : '', progress: finite(n.job.progress) ? clamp(n.job.progress, 0, 100) : undefined,
      } : undefined,
    };
  });
  const edges: Edge[] = [];
  for (const e of Array.isArray(raw.edges) ? raw.edges : []) {
    if (ids.has(e.from) && ids.has(e.to) && canConnect(edges, e.from, e.to)) edges.push({ id: typeof e.id === 'string' ? e.id : uid(), from: e.from, to: e.to });
  }
  const v = raw.view;
  const drafts: Record<string, GenerationDraft> = Object.create(null);
  for (const [key, value] of Object.entries(raw.drafts && typeof raw.drafts === 'object' ? raw.drafts : {}).slice(0, 1001)) {
    const d = value as any;
    if (d && ['image', 'video', 'audio'].includes(d.kind) && ['prompt', 'model', 'ratio', 'resolution'].every(k => typeof d[k] === 'string') && finite(d.seconds))
      drafts[key.slice(0, 160)] = { kind: d.kind, prompt: d.prompt.slice(0, 5000), model: d.model.slice(0, 200), ratio: d.ratio.slice(0, 20), resolution: d.resolution.slice(0, 20), seconds: d.seconds, count: [1, 2, 4].includes(d.count) ? d.count : 1, videoMode: ['text', 'reference', 'frames', 'edit', 'multimodal'].includes(d.videoMode) ? d.videoMode : 'reference', firstFrameId: typeof d.firstFrameId === 'string' ? d.firstFrameId : '', lastFrameId: typeof d.lastFrameId === 'string' ? d.lastFrameId : '', voice: typeof d.voice === 'string' ? d.voice.slice(0, 40) : 'Zephyr', referenceBindings: d.referenceBindings && typeof d.referenceBindings === 'object' ? Object.fromEntries(Object.entries(d.referenceBindings).filter(([label, id]) => /^(图片|视频|音频)[1-9][0-9]{0,4}$/.test(label) && typeof id === 'string').slice(0, 1000).map(([label, id]) => [label, (id as string).slice(0, 160)])) : undefined };
  }
  return { id: typeof raw.id === 'string' ? raw.id : uid(), title: typeof raw.title === 'string' ? raw.title.slice(0, 80) : '我的画布', nodes, edges,
    assetFolders: Array.isArray(raw.assetFolders) ? [...new Set<string>(raw.assetFolders.filter((f:unknown)=>typeof f === 'string' && f.trim()).map((f:string)=>f.trim().slice(0,40)))].slice(0,100) : undefined,
    drafts: Object.keys(drafts).length ? drafts : undefined,
    view: v && finite(v.x) && finite(v.y) && finite(v.zoom) ? { x: v.x, y: v.y, zoom: clamp(v.zoom, .15, 2.5) } : { x: 0, y: 0, zoom: 1 }, updatedAt: Number.isSafeInteger(raw.updatedAt) && raw.updatedAt > 0 ? raw.updatedAt : Date.now() };
}

export function templateNodes(type: 'story' | 'product' | 'mood', at: Point): Snapshot {
  const outlines = type === 'story' ? [
    ['故事起点', '一句话讲清楚这个故事。\n\n主角是谁？\n想得到什么？\n遇到了什么阻碍？'],
    ['镜头 01 · 建立场景', '景别：远景\n画面：交代时间、地点与氛围\n运镜：缓慢推进'],
    ['镜头 02 · 情绪与细节', '景别：近景\n画面：主角的动作和表情\n运镜：跟随主体'],
  ] : type === 'product' ? [
    ['产品与受众', '产品：\n核心卖点：\n目标人群：\n使用场景：'],
    ['视觉方向', '背景：简洁、有呼吸感\n光线：柔和的自然光\n构图：突出产品质感\n色彩：与品牌保持一致'],
    ['三个画面', '01 · 吸引注意的开场\n02 · 展示产品解决的问题\n03 · 使用场景与行动引导'],
  ] : [
    ['灵感关键词', '写下三个关键词。\n\n情绪 / 材质 / 色彩\n\n把参考图放在旁边，连接到图像节点。'],
    ['视觉语言', '主色：\n辅助色：\n光线：\n构图：\n想保留的细节：'],
    ['创作约定', '保持一致：\n\n可以探索：\n\n需要避免：'],
  ];
  const nodes = outlines.map(([title, text], i) => ({ ...newNode('text', { x: at.x + i * 350, y: at.y }, text), title }));
  const image = { ...newNode('image', { x: at.x + 350, y: at.y + 340 }), title: '把想法变成画面' };
  return { nodes: [...nodes, image], edges: [{ id: uid(), from: nodes[1].id, to: image.id }] };
}

export const DEFAULT_ASSET_FOLDERS = ['参考素材', '场景', '分镜', '风格', '角色', '文档', '音乐'];
export function assetFolder(node: CanvasNode): string { return node.assetFolder || (node.kind === 'text' ? '文档' : node.kind === 'audio' ? '音乐' : node.kind === 'video' ? '分镜' : '参考素材'); }

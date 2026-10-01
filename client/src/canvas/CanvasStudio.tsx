import { bindReferences, referenceLabel, insertReference } from './referenceMentions';
import BrandMark from '../components/BrandMark';
import ProjectLibrary from './ProjectLibrary';
import AssetPicker from './AssetPicker';
import { connectionError } from './videoInputs';
import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, ArrowUpRight, Check, ChevronDown, Copy, Download, FolderOpen, Frame, Hand, HelpCircle, Image as ImageIcon, LayoutGrid, Link2, Maximize, Minus, MousePointer2, PanelRightClose, Plus, Redo2, Search, Sparkles, Trash2, Type, Undo2, Upload, Video, X, Layers3, Loader2, CheckCircle2, Music2, Eye, EyeOff, Sun, Moon } from 'lucide-react';
import { useAuthGuard } from '../hooks/useAuthGuard';
import { contentApi } from '../api/content';
import { api } from '../api/client';
import { analysisApi } from '../api/analysis';
import { downloadGeneratedImage } from '../api/imageGen';
import { normalizeImageFile, isSupportedImageFile } from '../utils/imageNormalization';
import { startPolling } from '../utils/polling';
import GeneratorPanel from './GeneratorPanel';

import ImageTools from './ImageTools';
import { VIDEO_EDIT_MODEL, videoInputError, readVideoDuration } from './videoInputs';
import { canvasVideoReferenceLimits } from '../../../shared/canvasVideoReferences';
import type { GenerateOptions } from './GeneratorPanel';
import { applyGenerationEvent, applyPendingGeneration, referenceDataUrl, streamGeneration } from './generation';
import { arrange, bounds, canConnect, checkpoint, clamp, duplicateSelection, fitView, intersects, newDocument, newNode, parseDocument, safeMedia, screenToWorld, stepHistory, templateNodes, uid, zoomAround } from './model';
import type { CanvasDocument, CanvasNode, History, NodeKind, Point, Snapshot } from './model';

type Props = { key?: string; initial: CanvasDocument; projects: CanvasDocument[]; status: string; onSync?: () => void; onImportGuest?: () => Promise<void>; onPersist?: () => Promise<void>; onChange: (doc: CanvasDocument) => void; onSwitch: (id: string) => void; onCreate: (doc: CanvasDocument) => void };
type Gesture = { kind: 'pan' | 'move' | 'box' | 'resize'; pointer: number; start: Point; last: Point; doc: CanvasDocument; ids: string[]; additive: boolean; checkpointed: boolean };
const isEditing = (target: EventTarget | null) => target instanceof HTMLElement && Boolean(target.closest('input,textarea,select,[contenteditable="true"]'));
const iconFor = (kind: NodeKind) => kind === 'image' ? ImageIcon : kind === 'video' ? Video : kind === 'audio' ? Music2 : Type;
const playable = (src: string) => src.startsWith('data:') || src.startsWith('blob:') ? src : `/api/video/play?url=${encodeURIComponent(src)}`;

export default function CanvasStudio({ initial, projects, status, onSync, onImportGuest, onPersist, onChange, onSwitch, onCreate }: Props) {
  const [doc, setDoc] = useState(() => parseDocument(initial));
  const docRef = useRef(doc);
  const [selected, setSelected] = useState<string[]>([]);
  const [history, setHistory] = useState<History>({ past: [], future: [] });
  const historyRef = useRef(history);
  const [mode, setMode] = useState<'select' | 'hand'>('select');
  const [space, setSpace] = useState(false);
  const [panel, setPanel] = useState(false);
  const composerElement = useRef<HTMLDivElement>(null);
  const [composerHeight, setComposerHeight] = useState(300);
  useEffect(() => {
    if (!panel || !composerElement.current) return;
    const observer = new ResizeObserver(entries => { const height = entries[0]?.contentRect.height; if (height) setComposerHeight(height); });
    observer.observe(composerElement.current); return () => observer.disconnect();
  }, [panel]);
  const [library, setLibrary] = useState(false);
  const [projectMenu, setProjectMenu] = useState(false);
  const [help, setHelp] = useState(false);

  const [notice, setNotice] = useState('');
  const [connecting, setConnecting] = useState<string | null>(null);
  const linkDrag = useRef<{ id: string; side: 'in' | 'out'; pointer: number; start: Point; moved: boolean } | null>(null);
  const suppressPortClick = useRef(false);
  const [linkPreview, setLinkPreview] = useState<{ from: Point; to: Point; target?: string; valid: boolean } | null>(null);
  const [marquee, setMarquee] = useState<{ a: Point; b: Point } | null>(null);
  const [context, setContext] = useState<(Point & { nodeId?: string; link?: { id: string; side: 'in' | 'out'; at: Point } }) | null>(null);
  const [preview, setPreview] = useState<CanvasNode | null>(null);
  const [compare, setCompare] = useState<CanvasNode[] | null>(null);

  const [nodeHistory, setNodeHistory] = useState<string | null>(null);
  const [assetBrowser, setAssetBrowser] = useState(false);
  const [assetIntent, setAssetIntent] = useState<{id:string;mode:'fill'|'reference'} | null>(null);
  const openAssets = (id:string, mode:'fill'|'reference') => {setAssetIntent({id,mode});setAssetBrowser(true);};
  const [imageTools, setImageTools] = useState<CanvasNode | null>(null);
  const [batch, setBatch] = useState(false);
  const [batchText, setBatchText] = useState('');
  const [batchKind, setBatchKind] = useState<'image' | 'video'>('image');
  const [showConnections, setShowConnections] = useState(true);
  const [snap, setSnap] = useState(false);
  const [dark, setDark] = useState(() => localStorage.getItem('canvas-theme') !== 'light');
  const [importing, setImporting] = useState(false);
  const surface = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const importAt = useRef<Point | undefined>(undefined);
  const referenceInput = useRef<HTMLInputElement>(null);
  const referenceUploadTarget = useRef<string | undefined>(undefined);
  const backupInput = useRef<HTMLInputElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const touches = useRef(new Map<number, Point>());
  const pinch = useRef<{ distance: number; anchor: Point; zoom: number } | null>(null);
  const textStart = useRef<Snapshot | null>(null);
  const mounted = useRef(true);
  const controllers = useRef(new Map<string, AbortController>());
  const guard = useAuthGuard();
  const [size, setSize] = useState({ width: 1000, height: 700 });
  const selection = doc.nodes.filter(n => selected.includes(n.id));
  const active = selection.length === 1 ? selection[0] : undefined;
  const running = doc.nodes.some(n => n.job?.status === 'running');

  const previousInitial = useRef(initial);
  useEffect(() => {
    const replacements = new Map<string,string>();
    for (const node of initial.nodes) {
      const old = previousInitial.current.nodes.find(n => n.id === node.id);
      if (old?.src?.startsWith('data:') && node.src?.startsWith('/api/media/')) replacements.set(old.src,node.src);
      for (const version of node.versions || []) {
        const oldVersion=old?.versions?.find(v=>v.id===version.id);
        if(oldVersion?.src.startsWith('data:')&&version.src.startsWith('/api/media/'))replacements.set(oldVersion.src,version.src);
      }
    }
    previousInitial.current=initial;
    if (!replacements.size) return;
    const current={...docRef.current,nodes:docRef.current.nodes.map(node=>({...node,src:replacements.get(node.src)||node.src,versions:node.versions?.map(v=>({...v,src:replacements.get(v.src)||v.src}))}))};
    docRef.current=current;setDoc(current);
  },[initial]);

  const update = (next: CanvasDocument) => {
    const result = { ...next, updatedAt: Date.now() };
    docRef.current = result; setDoc(result); onChange(result);
  };
  const record = (snapshot: Snapshot = docRef.current) => {
    const next = checkpoint(historyRef.current, { nodes: snapshot.nodes, edges: snapshot.edges });
    historyRef.current = next; setHistory(next);
  };
  const commit = (transform: (current: CanvasDocument) => CanvasDocument) => { record(); update(transform(docRef.current)); };
  const editNode = (id: string, patch: Partial<CanvasNode>) => update({ ...docRef.current, nodes: docRef.current.nodes.map(n => n.id === id ? { ...n, ...patch } : n) });
  const undo = (direction: 'undo' | 'redo') => {
    if (running) { setNotice('生成过程中可以继续编辑；任务完成后可撤销或重做。'); return; }
    const result = stepHistory(historyRef.current, docRef.current, direction);
    historyRef.current = result.history; setHistory(result.history);
    update({ ...docRef.current, ...result.snapshot }); setSelected([]);
  };
  const localPoint = (clientX: number, clientY: number): Point => {
    const rect = surface.current!.getBoundingClientRect(); return { x: clientX - rect.left, y: clientY - rect.top };
  };
  const center = (): Point => {
    const p = screenToWorld({ x: size.width / 2, y: size.height / 2 }, docRef.current.view);
    return { x: p.x - 150, y: p.y - 110 };
  };
  const fit = (nodes = docRef.current.nodes) => update({ ...docRef.current, view: fitView(nodes, size.width, size.height) });
  const focusNode = (node: CanvasNode) => { setPanel(false); setSelected([node.id]); fit([node]); };
  const addAssets = (assets: CanvasNode[]) => {
    const at = center();
    const nodes = assets.map((n, i) => ({ ...n, id: uid(), x: at.x + i % 3 * 350, y: at.y + Math.floor(i / 3) * 320 }));
    commit(d => ({ ...d, nodes: [...d.nodes, ...nodes], view: fitView(nodes, size.width, size.height) }));
    setSelected(nodes.map(n => n.id)); setAssetBrowser(false);
  };
  const createBatch = () => {
    const prompts = batchText.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (!prompts.length || prompts.length > 20) { setNotice('每行一个提示词，每次可创建 1–20 个节点。'); return; }
    const at = center();
    const nodes = prompts.map((text, i) => ({ ...newNode(batchKind, { x: at.x + i % 4 * 370, y: at.y + Math.floor(i / 4) * 340 }, text), generator: true, title: `${batchKind === 'image' ? '图片' : '视频'} ${String(i + 1).padStart(2, '0')}` }));
    commit(d => ({ ...d, nodes: [...d.nodes, ...nodes], view: fitView(nodes, size.width, size.height) })); setBatch(false); setBatchText(''); setSelected([nodes[0].id]); setPanel(true);
    setNotice(`已创建 ${nodes.length} 个独立生成节点，尚未调用模型。`);
  };
  const continueCreation = (kind: 'image' | 'video') => {
    if (!active?.src) return;
    const node: CanvasNode = { ...newNode(kind, { x: active.x + active.width + 100, y: active.y + 40 }),
      title: kind === 'image' ? '继续修改 · 新版本' : '图片生成视频', ratio: active.ratio,
      text: kind === 'image' ? '保留主体与构图，' : '保留主体细节，镜头缓慢推进，自然流畅的运动',
      origin: { projectId: doc.id, nodeId: active.id, title: active.title } };
    commit(d => ({ ...d, nodes: [...d.nodes, node], edges: [...d.edges, { id: uid(), from: active.id, to: node.id }] }));
    setSelected([node.id]); setPanel(true); fit([active, node]);
  };
  const editVideo = () => {
    if (active?.kind !== 'video' || !active.src) return;
    const node: CanvasNode = { ...newNode('video', { x: active.x + active.width + 100, y: active.y }), generator: true, title: '视频编辑 · 新版本', ratio: '16:9', origin: { projectId: doc.id, nodeId: active.id, title: active.title } };
    commit(d => ({ ...d, nodes: [...d.nodes, node], edges: [...d.edges, { id: uid(), from: active.id, to: node.id }], drafts: { ...d.drafts, [node.id]: { kind: 'video', videoMode: 'edit', prompt: '', model: VIDEO_EDIT_MODEL, ratio: '16:9', resolution: '720p', seconds: 10 } } }));
    setSelected([node.id]); setPanel(true); fit([active, node]);
  };
  const reuse = (project: CanvasDocument, asset: CanvasNode) => {
    const node = { ...asset, ...center(), id: uid(), group: undefined, job: undefined,
      title: `${asset.title} · 引用`, origin: { projectId: project.id, nodeId: asset.id, title: project.title } };
    commit(d => ({ ...d, nodes: [...d.nodes, node] })); setSelected([node.id]); setLibrary(false);
    setNotice('素材已加入当前画布，原项目保持完整。');
  };
  const add = (kind: NodeKind, at = center(), text = '') => {
    const node = { ...newNode(kind, at, text), generator: kind !== 'text' };
    commit(d => ({ ...d, nodes: [...d.nodes, node] })); setSelected([node.id]); setContext(null);
    if (kind !== 'text') setPanel(true);
    return node;
  };
  const remove = () => {
    const allowed = selected.filter(id => docRef.current.nodes.find(n => n.id === id)?.job?.status !== 'running');
    if (!allowed.length) return;
    commit(d => ({ ...d, nodes: d.nodes.filter(n => !allowed.includes(n.id)), edges: d.edges.filter(e => !allowed.includes(e.from) && !allowed.includes(e.to)) }));
    setSelected([]); setNotice('已删除素材，可按 Ctrl / ⌘ Z 撤销。');
  };
  const duplicate = () => {
    const result = duplicateSelection(docRef.current, selected); commit(d => ({ ...d, ...result.snapshot })); setSelected(result.ids);
  };
  const group = () => { const id = uid(); commit(d => ({ ...d, nodes: d.nodes.map(n => selected.includes(n.id) ? { ...n, group: id } : n) })); };
  const linkError = (from: string, to: string) => {
    const a = docRef.current.nodes.find(n => n.id === from), b = docRef.current.nodes.find(n => n.id === to);
    return a && b ? connectionError(a, b) : '节点不存在';
  };
  const connect = (id: string) => {
    if (!connecting) { setConnecting(id); setNotice('再点击另一张卡片的连接点，将它们关联。'); return; }
    if (!canConnect(docRef.current.edges, connecting, id)) { setNotice('不能重复连接、连接自身或形成循环。'); setConnecting(null); return; }
    const error = linkError(connecting, id); if (error) { setNotice(error); setConnecting(null); return; }
    commit(d => ({ ...d, edges: [...d.edges, { id: uid(), from: connecting, to: id }] })); setConnecting(null); setNotice('已连接为参考，请在目标节点中查看素材。');
  };
  const connectSelectionToVideo = (targetId: string) => {
    const current = docRef.current;
    const target = current.nodes.find(n => n.id === targetId && n.kind === 'video');
    if (!target || target.job?.status === 'running') { setNotice('请选择未在生成中的视频节点。'); return; }
    const edges = [...current.edges];
    let added = 0, existing = 0, skipped = 0;
    for (const source of current.nodes.filter(n => selected.includes(n.id) && n.id !== targetId)) {
      if (edges.some(e => e.from === source.id && e.to === targetId)) { existing++; continue; }
      if (source.job?.status === 'running' || (source.kind === 'text' ? !source.text.trim() : !source.src)
        || connectionError(source, target) || !canConnect(edges, source.id, targetId)) { skipped++; continue; }
      edges.push({ id: uid(), from: source.id, to: targetId }); added++;
    }
    if (added) commit(d => ({ ...d, edges }));
    setConnecting(null);
    setNotice(`已连接 ${added} 项素材到「${target.title}」${existing ? `，${existing} 项已连接` : ''}${skipped ? `，跳过 ${skipped} 项未就绪或会形成循环的素材` : ''}。生成前可在视频节点中确认参考和模型限制。`);
  };
  const portPoint = (node: CanvasNode, side: 'in' | 'out'): Point => ({ x: node.x + (side === 'out' ? node.width : 0), y: node.y + node.height / 2 });
  const linkTarget = (point: Point, drag: NonNullable<typeof linkDrag.current>) => {
    const opposite = drag.side === 'out' ? 'in' : 'out';
    return docRef.current.nodes.filter(n => n.id !== drag.id).map(node => ({ node, distance: Math.hypot(portPoint(node, opposite).x - point.x, portPoint(node, opposite).y - point.y) }))
      .filter(hit => hit.distance * docRef.current.view.zoom <= 24).sort((a, b) => a.distance - b.distance)[0]?.node;
  };
  const beginLink = (event: ReactPointerEvent, node: CanvasNode, side: 'in' | 'out') => {
    event.stopPropagation();
    if (event.button !== 0 || linkDrag.current || gesture.current) return;
    suppressPortClick.current = false;
    linkDrag.current = { id: node.id, side, pointer: event.pointerId, start: localPoint(event.clientX, event.clientY), moved: false };
    // Capture on the port: a short press still produces its ordinary accessible click.
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const cancelLink = () => { linkDrag.current = null; setLinkPreview(null); };
  const useTemplate = (type: 'story' | 'product' | 'mood') => {
    const at = center(); const existing = docRef.current.nodes;
    if (existing.length) at.x = bounds(existing).x + bounds(existing).width + 100;
    const template = templateNodes(type, at);
    commit(d => ({ ...d, nodes: [...d.nodes, ...template.nodes], edges: [...d.edges, ...template.edges], view: fitView(template.nodes, size.width, size.height) }));
    setSelected([]); setNotice('已添加可编辑的创作起点，不会自动产生生成费用。');
  };

  useEffect(() => {
    mounted.current = true;
    const element = surface.current!;
    let firstMeasure = true;
    const resize = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      setSize({ width, height });
      if (firstMeasure && width > 0 && height > 0) {
        firstMeasure = false;
        const current = docRef.current;
        const hasVisibleCenter = current.nodes.some(n => {
          const x = (n.x + n.width / 2) * current.view.zoom + current.view.x;
          const y = (n.y + n.height / 2) * current.view.zoom + current.view.y;
          return x >= 0 && x <= width && y >= 0 && y <= height;
        });
        if (current.nodes.length && !hasVisibleCenter) update({ ...current, view: fitView(current.nodes, width, height) });
      }
    }); resize.observe(element);
    const wheel = (event: WheelEvent) => {
      if ((event.target as HTMLElement).closest('textarea,video,[data-canvas-ui]')) return;
      event.preventDefault();
      const d = docRef.current, point = localPoint(event.clientX, event.clientY);
      if (event.ctrlKey || event.metaKey || event.deltaMode !== 0 || Math.abs(event.deltaY) >= 50 && !event.deltaX) {
        update({ ...d, view: zoomAround(d.view, point, Math.exp(-event.deltaY * (event.deltaMode ? .04 : .002))) });
      } else update({ ...d, view: { ...d.view, x: d.view.x - (event.shiftKey ? event.deltaY : event.deltaX), y: d.view.y - (event.shiftKey ? 0 : event.deltaY) } });
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => { mounted.current = false; resize.disconnect(); element.removeEventListener('wheel', wheel); controllers.current.forEach(c => c.abort()); };
  }, []);

  const importFiles = async (files: File[], at = center(), targetId?: string, fill = false, folder?: string) => {
    if (importing) return;
    setImporting(true);
    const imported: CanvasNode[] = [], failures: string[] = [];
    for (const [i, file] of files.slice(0, 20).entries()) {
      try {
        const previousReferences = targetId ? docRef.current.edges.filter(e => e.to === targetId).length : 0;
        const position = targetId ? { x: at.x, y: at.y + (previousReferences + i) * 310 } : { x: at.x + (i % 3) * 340, y: at.y + Math.floor(i / 3) * 310 };
        if (isSupportedImageFile(file) || file.type === 'image/gif') {
          const image = await normalizeImageFile(file, { maxInputBytes: 20 * 1024 * 1024, maxDimension: 2560 });
          imported.push({ ...newNode('image', position), title: file.name, generator: false, src: image.dataUrl });
        } else if (['video/mp4', 'video/webm', 'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/webm'].includes(file.type) && file.size <= 40 * 1024 * 1024) {
          const src = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
          imported.push({ ...newNode(file.type.startsWith('audio/') ? 'audio' : 'video', position), title: file.name, src });
        } else throw new Error('图片限 20 MB，MP4 / WebM 视频限 40 MB');
      } catch { failures.push(file.name); }
    }
    if (!mounted.current) return;
    if (folder) imported.forEach(n=>{n.assetFolder=folder;});
    if (imported.length && fill && targetId) { applyAssets(imported.slice(0,1), {id:targetId,mode:'fill'});setImporting(false);return; }
    if (imported.length && targetId) { applyAssets(imported,{id:targetId,mode:'reference'});setImporting(false);return; }
    if (imported.length) {
      const targetExists = targetId && docRef.current.nodes.some(n => n.id === targetId);
      commit(d => ({ ...d, nodes: [...d.nodes, ...imported], edges: targetExists ? [...d.edges, ...imported.map(n => ({ id: uid(), from: n.id, to: targetId! }))] : d.edges }));
      setSelected(targetExists ? [targetId!] : imported.map(n => n.id));
      if (targetExists) setPanel(true);
    }
    setNotice(failures.length ? `${failures.length} 个文件未能导入。支持常见图片（20 MB 内）、MP4 / WebM 视频与 MP3 / WAV / OGG 音频（40 MB 内）。` : `已导入 ${imported.length} 个素材${files.length > 20 ? '，每次最多导入 20 个' : ''}`);
    setImporting(false);
  };
  const applyAssets = (assets: CanvasNode[], intent = assetIntent) => {
    if (!intent) { addAssets(assets); return; }
    const target = docRef.current.nodes.find(n=>n.id === intent.id);
    if (!target || target.job?.status === 'running') {setNotice('目标节点不可用或正在生成');return;}
    const eligible=assets.filter(n=>n.src || n.kind === 'text' && n.text.trim());
    if (!eligible.length) {setNotice('没有可用的同类型素材');return;}
    const attached: CanvasNode[] = [];
    if (intent.mode === 'fill') {
      const source=eligible[0];if(source.kind !== target.kind){setNotice('请选择与当前节点相同类型的素材');return;}
      const versions=[...(target.versions || [])];if(target.src && !versions.some(v=>v.src === target.src))versions.push({id:uid(),src:target.src,prompt:target.text,createdAt:Date.now(),model:target.model});
      commit(d=>({...d,nodes:d.nodes.map(n=>n.id === target.id ? {...n,src:source.src,text:source.kind === 'text' ? source.text : n.text,origin:source.origin,versions,job:undefined} : n)}));
    } else {
      let next={...docRef.current,nodes:[...docRef.current.nodes],edges:[...docRef.current.edges]};
      for (const [i,source] of eligible.entries()) {
        const error=connectionError(source,target);if(error){setNotice(error);return;}
        const existing=source.origin?.projectId === next.id ? next.nodes.find(n=>n.id === source.origin?.nodeId) : undefined;
        const node=existing || {...source,id:uid(),generator:false,job:undefined,x:target.x-380,y:target.y+i*310};
        if (!canConnect(next.edges,node.id,target.id)) {setNotice('此素材已连接或会形成循环');return;}
        attached.push(node);
        if(!existing)next.nodes.push(node);
        next.edges.push({id:uid(),from:node.id,to:target.id});
      }
      commit(()=>next);
    }
    setSelected([target.id]);setAssetBrowser(false);setAssetIntent(null);setPanel(true);setNotice(intent.mode === 'fill' ? '已填入节点，原素材保留' : '已引用素材并连接到当前节点');
    return attached;
  };
  const referenceTarget = (kind: GenerateOptions['kind']) => {
    if (active && active.kind === kind && (!active.src || active.generator)) return active;
    const node = { ...newNode(kind, center()), generator: true };
    const draft = docRef.current.drafts?.[active?.id || 'general'];
    commit(d => ({ ...d, nodes: [...d.nodes, node], drafts: draft ? { ...d.drafts, [node.id]: { ...draft, kind } } : d.drafts }));
    setSelected([node.id]); setPanel(true); return node;
  };
  const uploadReferences = (kind: GenerateOptions['kind'], files?: File[]) => {
    if (importing || files && !files.length) return;
    const target = referenceTarget(kind);
    if (files) void importFiles(files, { x: target.x - 380, y: target.y }, target.id);
    else { referenceUploadTarget.current = target.id; referenceInput.current?.click(); }
  };
  const actions = useRef<any>(null);
  actions.current = { undo, remove, duplicate, fit, add, group, importFiles, selected, mode, projectMenu, preview: preview || compare || batch || nodeHistory || assetBrowser || imageTools || context, help };
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      const a = actions.current, key = event.key.toLowerCase(), mod = event.ctrlKey || event.metaKey;
      if (key === 'escape') { suppressPortClick.current = true; cancelLink(); setConnecting(null); setContext(null); setHelp(false); setProjectMenu(false); setPreview(null); setCompare(null); setBatch(false); setNodeHistory(null); setAssetBrowser(false); setAssetIntent(null); setImageTools(null); setSelected([]); return; }
      if (isEditing(event.target)) return;
      if (a.help || a.projectMenu || a.preview) return;
      if (event.code === 'Space') { event.preventDefault(); setSpace(true); }
      else if (mod && key === 'z') { event.preventDefault(); a.undo(event.shiftKey ? 'redo' : 'undo'); }
      else if (mod && key === 'y') { event.preventDefault(); a.undo('redo'); }
      else if (mod && key === 'a') { event.preventDefault(); setSelected(docRef.current.nodes.map(n => n.id)); }
      else if (mod && key === 'd') { event.preventDefault(); if (a.selected.length) a.duplicate(); }
      else if (mod && key === 'g') { event.preventDefault(); if (a.selected.length > 1) a.group(); }
      else if (key === 'delete' || key === 'backspace') { event.preventDefault(); a.remove(); }
      else if (!mod && key === 'v') setMode('select');
      else if (!mod && key === 'h') setMode('hand');
      else if (!mod && key === 't') a.add('text');
      else if (!mod && key === 'f') a.fit();
      else if (!mod && key === '/') { event.preventDefault(); setPanel(true); document.getElementById('canvas-prompt')?.focus(); }
    };
    const up = (event: KeyboardEvent) => { if (event.code === 'Space') setSpace(false); };
    const blur = () => { suppressPortClick.current = true; cancelLink(); setSpace(false); gesture.current = null; pinch.current = null; touches.current.clear(); setMarquee(null); };
    const paste = (event: ClipboardEvent) => {
      if (isEditing(event.target) || actions.current.projectMenu || actions.current.help || actions.current.preview) return;
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length) { event.preventDefault(); void actions.current.importFiles(files); }
      else { const text = event.clipboardData?.getData('text/plain'); if (text) { event.preventDefault(); actions.current.add('text', undefined, text.slice(0, 50000)); } }
    };
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', blur); window.addEventListener('paste', paste);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur); window.removeEventListener('paste', paste); };
  }, []);

  useEffect(() => {
    if (!projectMenu && !help && !preview && !compare && !batch && !nodeHistory && !assetBrowser && !imageTools) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector<HTMLElement>('.studio-shell [role="dialog"]');
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled),input,select,textarea,a[href]') ?? []);
    focusable()[0]?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const elements = focusable(), first = elements[0], last = elements[elements.length - 1];
      if (!first) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', trap);
    return () => { document.removeEventListener('keydown', trap); previous?.focus(); };
  }, [projectMenu, help, preview, compare, batch, nodeHistory, assetBrowser, imageTools]);

  const begin = (event: ReactPointerEvent, ids?: string[], resize = false) => {
    if (linkDrag.current) return;
    if (event.pointerType === 'touch') {
      touches.current.set(event.pointerId, localPoint(event.clientX, event.clientY));
      if (touches.current.size === 2) {
        event.preventDefault(); event.stopPropagation();
        const [a, b] = [...touches.current.values()];
        pinch.current = { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), anchor: screenToWorld({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, docRef.current.view), zoom: docRef.current.view.zoom };
        gesture.current = null; setMarquee(null); surface.current?.setPointerCapture(event.pointerId); return;
      }
    }
    if (event.button !== 0 && event.button !== 1 || gesture.current) return;
    event.preventDefault(); event.stopPropagation(); setContext(null);
    const point = localPoint(event.clientX, event.clientY);
    const pan = space || mode === 'hand' || event.button === 1;
    // Selecting or moving a node never opens the composer; creation is explicit.
    if (ids) setPanel(false);
    let moving = ids ?? [];
    if (!pan && ids) {
      if (event.shiftKey && ids.length === 1) { setSelected(current => current.includes(ids[0]) ? current.filter(id => id !== ids[0]) : [...current, ids[0]]); return; }
      moving = ids.every(id => selected.includes(id)) ? selected : ids;
      setSelected(moving);
    } else if (!pan && !event.shiftKey) setSelected([]);
    gesture.current = { kind: pan ? 'pan' : resize ? 'resize' : ids ? 'move' : 'box', pointer: event.pointerId, start: point, last: point, doc: docRef.current, ids: moving, additive: event.shiftKey, checkpointed: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: ReactPointerEvent) => {
    const drag = linkDrag.current;
    if (drag) {
      if (drag.pointer !== event.pointerId) return;
      const local = localPoint(event.clientX, event.clientY);
      if (!drag.moved && Math.hypot(local.x - drag.start.x, local.y - drag.start.y) < 4) return;
      drag.moved = true; suppressPortClick.current = true; setConnecting(null);
      const point = screenToWorld(local, docRef.current.view), source = docRef.current.nodes.find(n => n.id === drag.id);
      if (!source) { cancelLink(); return; }
      const target = linkTarget(point, drag), fixed = portPoint(source, drag.side);
      const moving = target ? portPoint(target, drag.side === 'out' ? 'in' : 'out') : point;
      const from = drag.side === 'out' ? drag.id : target?.id, to = drag.side === 'out' ? target?.id : drag.id;
      const batchVideo = drag.side === 'out' && target?.kind === 'video' && selected.length > 1 && selected.includes(drag.id);
      const valid = batchVideo ? target.job?.status !== 'running' && docRef.current.nodes.some(n => selected.includes(n.id)
        && n.job?.status !== 'running' && (n.kind === 'text' ? n.text.trim() : n.src)
        && canConnect(docRef.current.edges, n.id, target.id) && !connectionError(n, target))
        : Boolean(from && to && canConnect(docRef.current.edges, from, to) && !linkError(from, to));
      setLinkPreview({ from: drag.side === 'out' ? fixed : moving, to: drag.side === 'out' ? moving : fixed,
        target: target?.id, valid });
      return;
    }
    if (touches.current.has(event.pointerId)) touches.current.set(event.pointerId, localPoint(event.clientX, event.clientY));
    if (pinch.current && touches.current.size === 2) {
      const [a, b] = [...touches.current.values()], p = pinch.current;
      const zoom = clamp(p.zoom * Math.hypot(a.x - b.x, a.y - b.y) / p.distance, .15, 2.5);
      update({ ...docRef.current, view: { zoom, x: (a.x + b.x) / 2 - p.anchor.x * zoom, y: (a.y + b.y) / 2 - p.anchor.y * zoom } }); return;
    }
    const g = gesture.current; if (!g || g.pointer !== event.pointerId) return;
    const point = localPoint(event.clientX, event.clientY), dx = point.x - g.start.x, dy = point.y - g.start.y;
    if (Math.abs(dx) + Math.abs(dy) < 3 && !g.checkpointed) return;
    if (!g.checkpointed) { if (g.kind === 'move' || g.kind === 'resize') record(g.doc); g.checkpointed = true; }
    g.last = point;
    const d = docRef.current;
    if (g.kind === 'pan') update({ ...d, view: { ...g.doc.view, x: g.doc.view.x + dx, y: g.doc.view.y + dy } });
    else if (g.kind === 'box') setMarquee({ a: g.start, b: point });
    else update({ ...d, nodes: d.nodes.map(n => {
      if (!g.ids.includes(n.id)) return n;
      const original = g.doc.nodes.find(o => o.id === n.id)!;
      return g.kind === 'resize' ? { ...n, width: clamp(original.width + dx / d.view.zoom, 220, 1000), height: clamp(original.height + dy / d.view.zoom, 160, 1000) }
        : { ...n, x: snap ? Math.round((original.x + dx / d.view.zoom) / 24) * 24 : original.x + dx / d.view.zoom, y: snap ? Math.round((original.y + dy / d.view.zoom) / 24) * 24 : original.y + dy / d.view.zoom };
    }) });
  };
  const end = (event?: ReactPointerEvent) => {
    const drag = linkDrag.current;
    if (drag) {
      if (event && event.pointerId !== drag.pointer) return;
      cancelLink();
      if (event?.type !== 'pointerup') { suppressPortClick.current = true; setConnecting(null); return; }
      if (!drag.moved) return;
      const local = localPoint(event.clientX, event.clientY), at = screenToWorld(local, docRef.current.view);
      const target = linkTarget(at, drag);
      const from = drag.side === 'out' ? drag.id : target?.id, to = drag.side === 'out' ? target?.id : drag.id;
      if (drag.side === 'out' && target?.kind === 'video' && selected.length > 1 && selected.includes(drag.id)) {
        connectSelectionToVideo(target.id); return;
      }
      if (from && to && linkError(from, to)) { setNotice(linkError(from, to)); return; }
      if (from && to && canConnect(docRef.current.edges, from, to)) {
        commit(d => ({ ...d, edges: [...d.edges, { id: uid(), from, to }] }));
        setNotice('已连接，参考素材会用于下一步创作。');
      } else if (target) setNotice('不能重复连接或形成循环，请选择其他节点。');
      else {
        const hit = document.elementFromPoint?.(event.clientX, event.clientY);
        const overNode = docRef.current.nodes.some(n => at.x >= n.x && at.x <= n.x + n.width && at.y >= n.y && at.y <= n.y + n.height);
        if (!overNode && local.x >= 0 && local.y >= 0 && local.x <= size.width && local.y <= size.height && (!hit || hit.closest('.studio-stage'))) {
          setContext({ ...local, link: { id: drag.id, side: drag.side, at } });
          setPanel(false);
        }
      }
      return;
    }
    if (event) touches.current.delete(event.pointerId);
    if (pinch.current) { pinch.current = null; gesture.current = null; setMarquee(null); return; }
    const g = gesture.current;
    if (g && event && event.pointerId !== g.pointer) return;
    if (g?.kind === 'box' && g.checkpointed) {
      const a = screenToWorld(g.start, docRef.current.view), b = screenToWorld(g.last, docRef.current.view);
      const ids = docRef.current.nodes.filter(n => intersects(n, a, b)).map(n => n.id);
      setSelected(current => [...new Set([...(g.additive ? current : []), ...ids])]);
    }
    gesture.current = null; setMarquee(null);
  };

  const references = active && (!active.src || active.generator) && active.kind !== 'text'
    ? doc.edges.filter(e => e.to === active.id).map(e => doc.nodes.find(n => n.id === e.from)).filter((n): n is CanvasNode => Boolean(n))
    : selection.filter(n => n.src);
  const generate = async (options: GenerateOptions) => {
    if (!guard()) return;
    if (!options.model || !options.prompt.trim()) { setNotice('请先填写提示词并选择模型。'); return; }
    if (active?.job?.status === 'running') { setNotice('这个节点正在生成，可以在其他节点继续创作。'); return; }
    const inputError = videoInputError(options, references);
    if (inputError) { setNotice(inputError); return; }
    const source = active;
    const target = source && source.kind === options.kind && (!source.src || source.generator) ? source
      : newNode(options.kind, source ? { x: source.x + source.width + 100, y: source.y } : center());
    const capturedRefs = references.slice();
    const imageLimit = options.videoMode === 'multimodal' ? canvasVideoReferenceLimits(options.model)?.images || 10 : 10;
    const imageRefs = capturedRefs.filter(n => n.kind === 'image' && n.src);
    if (imageRefs.length > imageLimit) { setNotice(`当前模式最多使用 ${imageLimit} 张参考图片，请移除多余连线。`); return; }
    if (options.kind === 'video' && options.videoMode === 'frames' && (!/^(veo|wan3\.0)/i.test(options.model) || !imageRefs.some(n => n.id === options.firstFrameId) || Boolean(options.lastFrameId && !imageRefs.some(n => n.id === options.lastFrameId)))) { setNotice('请重新选择有效的首尾帧，并使用支持首尾帧的模型。'); return; }
    const versions = [...(target.versions || [])];
    if (target.src && !versions.some(v => v.src === target.src)) versions.push({ id: uid(), src: target.src, prompt: target.text, model: target.model, ratio: target.ratio, createdAt: Date.now() });
    const result: CanvasNode = { ...target, versions, src: undefined, generator: true, text: options.prompt, model: options.model, ratio: options.ratio, settings: { resolution: options.resolution, seconds: options.seconds },
      title: source?.id === target.id ? target.title : options.kind === 'image' ? 'AI 图像' : options.kind === 'audio' ? 'AI 配音' : 'AI 视频', job: { status: 'running', requestId: options.kind === 'audio' ? undefined : uid(), expectedCount: options.kind === 'image' ? options.count || 1 : 1, message: '正在准备参考素材…' } };
    const exists = docRef.current.nodes.some(n => n.id === result.id);
    commit(d => ({ ...d, drafts: { ...d.drafts, [result.id]: { ...options, prompt: options.inputPrompt ?? options.prompt } }, nodes: exists ? d.nodes.map(n => n.id === result.id ? result : n) : [...d.nodes, result],
      edges: exists ? d.edges : [...d.edges, ...selection.filter(n => n.id !== result.id).map(n => ({ id: uid(), from: n.id, to: result.id }))] }));
    setSelected([result.id]);
    const controller = new AbortController(); controllers.current.set(result.id, controller);
    const patch = (fn: (n: CanvasNode) => CanvasNode) => { if (mounted.current) update({ ...docRef.current, nodes: docRef.current.nodes.map(n => n.id === result.id && n.job?.requestId === result.job?.requestId ? fn(n) : n) }); };
    let submitted = false;
    try {
      if (options.kind === 'video' && options.videoMode === 'edit') {
        patch(n => ({ ...n, job: { ...n.job!, message: '正在检查原视频时长…' } }));
        await readVideoDuration(capturedRefs.find(n => n.kind === 'video' && n.src)!.src!, controller.signal);
      }
      await onPersist?.();
      if (options.kind === 'audio') {
        if (controller.signal.aborted) return;
        submitted = true;
        const audio = await analysisApi.generateTts(options.prompt, options.voice || 'Zephyr', options.model);
        const src = `data:${audio.mimeType};base64,${audio.audioBase64}`;
        if (!safeMedia(src)) throw new Error('音频格式暂不支持，请到配音工作台查看');
        patch(n => applyGenerationEvent(n, { type: 'complete', imageUrl: src })); return;
      }
      const refs = options.kind === 'video' && options.videoMode === 'text' ? [] : await Promise.all(imageRefs.map(n => referenceDataUrl(n.src!)));
      if (controller.signal.aborted) return;
      submitted = true;
      const params = { canvasRequestId: result.job!.requestId, prompt: options.prompt, model: options.model, aspect_ratio: options.ratio, resolution: options.resolution,
        ...(options.kind === 'video' && (options.videoMode === 'edit' || options.videoMode === 'multimodal') ? { reference_videos: capturedRefs.filter(n => n.kind === 'video' && n.src).map(n => n.src!), ...(options.videoMode === 'multimodal' ? { audio_urls: capturedRefs.filter(n => n.kind === 'audio' && n.src).map(n => n.src!) } : {}) } : {}),
        reference_images: options.kind === 'video' && (options.videoMode === 'text' || options.videoMode === 'frames') ? undefined : refs.length ? refs : undefined,
        ...(options.kind === 'video' && options.videoMode === 'frames' ? { first_frame: refs[imageRefs.findIndex(n => n.id === options.firstFrameId)], last_frame: refs[imageRefs.findIndex(n => n.id === options.lastFrameId)] } : {}),
        ...(options.kind === 'image' ? { n: options.count || 1, quality: options.resolution === '4K' ? 'high' : options.resolution === '2K' ? 'medium' : 'low' } : { video_length: options.seconds }) };
      await streamGeneration(options.kind, params, controller.signal, event => patch(n => applyGenerationEvent(n, event)));
      patch(n => n.job?.status === 'running' ? { ...n, job: { ...n.job, status: n.job.contentId || n.job.requestId ? 'running' : 'interrupted', message: '响应已结束，正在核实结果。可到生成记录查看。' } } : n);
    } catch (error: any) {
      if (!controller.signal.aborted) patch(n => n.job?.status === 'done' ? n : { ...n, job: { ...n.job!, status: n.job?.contentId || submitted && n.job?.requestId ? 'running' : submitted ? 'interrupted' : 'error', message: submitted ? `${error.message}。${options.kind === 'audio' ? '请先到生成记录核实配音结果，再决定是否重试。' : '正在核实任务，避免重复提交。'}` : error.message } });
    } finally { controllers.current.delete(result.id); }
  };
  const pendingIds = doc.nodes.filter(n => n.job?.status === 'running' && (n.job.contentId || n.job.requestId)).map(n => n.job!.contentId || n.job!.requestId).join(',');
  useEffect(() => {
    if (!pendingIds) return;
    return startPolling(async signal => {
      const jobs = docRef.current.nodes.filter(n => n.job?.status === 'running' && (n.job.contentId || n.job.requestId));
      for (const node of jobs) {
        if (!node.job!.contentId) {
          if (controllers.current.has(node.id)) continue;
          try {
            const request = await api.get<{ contentId?: number; message: string; updatedAt: number }>(`/canvas/requests/${encodeURIComponent(node.job!.requestId!)}`, { signal });
            if (signal.aborted || !mounted.current) return;
            if (request.contentId) editNode(node.id, { job: { ...node.job!, contentId: request.contentId, message: '已恢复任务，正在查询结果…' } });
            else if (request.message || Date.now() - request.updatedAt > 120000) editNode(node.id, { job: { ...node.job!, status: 'interrupted', message: request.message || '任务尚未关联生成记录，请核实后再创建新任务。' } });
          } catch (error: any) {
            if (signal.aborted) return;
            if (error.status === 404) editNode(node.id, { job: { ...node.job!, status: 'interrupted', message: '未找到提交记录。请先检查生成记录，再重新创建任务。' } });
            else editNode(node.id, { job: { ...node.job!, message: '任务状态查询暂时失败，将自动重试，请勿重复提交。' } });
          }
          continue;
        }
        let data;
        try { data = await contentApi.getById(node.job!.contentId!, signal); }
        catch (error: any) {
          if (signal.aborted || !mounted.current) return;
          const current = docRef.current.nodes.find(n => n.id === node.id);
          if (current?.job?.status === 'running' && current.job.contentId === node.job!.contentId) {
            editNode(node.id, { job: { ...current.job, message: '结果查询暂时失败，将自动重试，请勿重复提交。' } });
          }
          continue;
        }
        if (signal.aborted || !mounted.current) return;
        const current = docRef.current.nodes.find(n => n.id === node.id);
        if (!current || current.job?.status !== 'running' || current.job.contentId !== node.job!.contentId) continue;
        let meta: any = {};
        try { meta = typeof data.metadata === 'string' ? JSON.parse(data.metadata || '{}') : data.metadata || {}; } catch {}
        if (data.status === 'completed' || data.status === 'success') {
          const src = data.resultUrl || meta.imageUrls?.[0];
          if (src) { const finished = applyGenerationEvent(current, { type: 'complete', contentId: current.job.contentId, imageUrls: meta.imageUrls?.length ? meta.imageUrls : [src] }); editNode(node.id, finished); }
          else editNode(node.id, { job: { ...current.job, status: 'interrupted', message: '未取得结果地址，请查看生成记录。' } });
        } else if (data.status === 'failed' || data.status === 'error') editNode(node.id, { job: { ...current.job, status: 'error', message: data.errorMessage || meta.error || '生成失败，请到生成记录查看详情。' } });
        else {
          const pending = applyPendingGeneration(current, data);
          if (pending !== current) editNode(node.id, pending);
        }
      }
    }, 5000);
  }, [pendingIds]);

  const exportBackup = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ ...docRef.current, format: 'creative-canvas-v2' })], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = `${docRef.current.title.replace(/[\\/:*?"<>|]/g, '-') || '画布'}.canvas.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice('画布备份已导出，包含当前素材与布局。');
  };
  const importBackup = async (file?: File) => {
    if (!file) return;
    try {
      if (file.size > 150 * 1024 * 1024) throw new Error('备份超过 150 MB');
      const raw = JSON.parse(await file.text());
      if ((raw?.nodes ?? raw?.items)?.length > 1000) throw new Error('每次最多导入 1000 个素材');
      const imported = parseDocument(raw);
      imported.id = uid(); imported.title += '（导入）';
      imported.nodes = imported.nodes.map(n => n.job?.status === 'running' ? { ...n, job: { status: 'interrupted', message: '备份中的历史任务，请在原账户生成记录中查看。' } } : n);
      onCreate(imported);
    } catch (error: any) { setNotice(`导入失败：${error.message}`); }
  };
  const downloadNode = async (node: CanvasNode) => {
    if (!node.src) return;
    try {
      if (node.src.startsWith('/api/media/')) await downloadGeneratedImage(node.src, /\.[a-z0-9]{2,5}$/i.test(node.title) ? node.title : `${node.title}.${node.kind==='image'?'png':node.kind==='video'?'mp4':'wav'}`);
      else if (node.kind === 'image') await downloadGeneratedImage(node.src, `${node.title}.png`);
      else { const a = document.createElement('a'); a.href = node.src; a.download = `${node.title}.${node.kind === 'audio' ? /audio\/(mpeg|mp3)/.test(node.src) ? 'mp3' : /audio\/ogg/.test(node.src) ? 'ogg' : /audio\/webm/.test(node.src) ? 'webm' : 'wav' : 'mp4'}`; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.click(); }
    } catch (error: any) { setNotice(error.message || '下载失败，请重试'); }
  };
  const groups = [...new Set(doc.nodes.map(n => n.group).filter(Boolean))].map(id => ({ id, nodes: doc.nodes.filter(n => n.group === id) }));
  const miniBounds = bounds(doc.nodes);
  const miniScale = Math.min(148 / Math.max(miniBounds.width, 1), 78 / Math.max(miniBounds.height, 1));
  const visibleNodes = doc.nodes.filter(n => intersects(n, screenToWorld({ x: -400, y: -400 }, doc.view), screenToWorld({ x: size.width + 400, y: size.height + 400 }, doc.view)) || selected.includes(n.id));
  const composerWidth = Math.min(550, Math.max(240, size.width - 24));
  const nodeLeft = active ? active.x * doc.view.zoom + doc.view.x : 0;
  const nodeRight = active ? nodeLeft + active.width * doc.view.zoom : 0;
  const belowNode = active ? (active.y + active.height) * doc.view.zoom + doc.view.y + 16 : size.height - 530;

  // Keep the composer attached below the node in screen coordinates at every zoom.
  // Viewport constraints must never flip it above the node or pin it to the screen.
  const composerLeft = active ? (nodeLeft + nodeRight - composerWidth) / 2
    : Math.max(12, (size.width - composerWidth) / 2);
  const composerTop = active ? belowNode : Math.max(70, size.height - composerHeight - 90);
  const focusActive = () => {
    if (!active) return;
    const available = Math.max(100, size.height - (panel ? composerHeight : 0) - 190);
    const zoom = Math.min(1, available / active.height, (size.width - 60) / active.width);
    update({...docRef.current, view:{zoom, x:(size.width-active.width*zoom)/2-active.x*zoom, y:80-active.y*zoom}});
  };
  useEffect(() => {
    if (!panel || !active) return;
    // Reframe only when opening/selecting a node, not while the user pans or drags it.
    if (composerTop + composerHeight > size.height - 90 || active.y * doc.view.zoom + doc.view.y < 70
      || composerLeft < 12 || composerLeft + composerWidth > size.width - 12) focusActive();
  }, [panel, active?.id]);
  const contextNode = doc.nodes.find(n => n.id === context?.nodeId);
  const historyNode = doc.nodes.find(n => n.id === nodeHistory);

  return <main data-theme={dark ? 'dark' : 'mood'} className={`studio-shell studio-node-first ${dark ? 'studio-dark' : ''}`}>
    <header className="studio-header">
      <Link to="/" className="studio-logo" aria-label="返回首页"><BrandMark /></Link>
      <div className="studio-header-divider" />
      <button className="studio-project-trigger" onClick={() => setProjectMenu(v => !v)} aria-expanded={projectMenu}><span><small>灵序 AI / 无限画布</small><strong>{doc.title}</strong></span><ChevronDown size={15} /></button>
      <button className={`studio-save ${status.includes('失败') ? 'is-error' : ''}`} onClick={onSync} title={status + ' · 点击重试同步'}><span />{status}</button>
      <div className="studio-header-actions"><span className="studio-header-divider" /><button className="studio-export" aria-label="导出画布" onClick={exportBackup}><Download size={15} /><span>导出画布</span></button><button className={`studio-create-toggle ${panel ? 'active' : ''}`} onClick={() => setPanel(v => !v)}><Sparkles size={16} /> 创作</button></div>
    </header>
    <div className="studio-body">
      <nav className="studio-rail" aria-label="画布工具">
        <button onClick={() => add('text')} aria-label="添加文字" title="文字 T"><Type size={21} /></button>
        <button onClick={() => add('image')} aria-label="添加图像节点" title="图像创作"><ImageIcon size={20} /></button>
        <button onClick={() => add('video')} aria-label="添加视频节点" title="视频创作"><Video size={20} /></button><button onClick={() => add('audio')} aria-label="添加音频节点" title="音频创作">♫</button>
        <button onClick={() => fileInput.current?.click()} disabled={importing} aria-label="导入素材" title="导入图片 / 视频 / 音频">{importing ? <Loader2 className="studio-spin" size={20} /> : <Upload size={19} />}</button><hr />
        <button className={library ? 'active' : ''} onClick={() => setLibrary(v => !v)} aria-label="素材列表" title="素材列表"><FolderOpen size={19} /></button>
        <div className="studio-rail-bottom"><button onClick={() => setHelp(true)} aria-label="操作帮助" title="快捷键与帮助"><HelpCircle size={20} /></button><Link to="/app" title="返回工作台" aria-label="返回工作台"><ArrowLeft size={19} /></Link></div>
      </nav>
      <div className="studio-stage-wrap">
        <div className="studio-studio-tools" data-canvas-ui><button onClick={() => setBatch(true)}>批量节点</button><button onClick={() => {setAssetIntent(null);setAssetBrowser(true);}}>生成资产</button><button aria-pressed={snap} onClick={() => setSnap(v => !v)}>自动吸附 {snap ? '开' : '关'}</button></div>
        {active && <div className="studio-node-extra" data-canvas-ui><button onClick={() => setNodeHistory(active.id)}>节点历史 · {active.versions?.length || 0}</button>{active.kind === 'image' && active.src && <button onClick={() => setImageTools(active)}>裁剪 / 旋转</button>}<button onClick={() => { const node = { ...newNode('image', { x: active.x + active.width + 120, y: active.y }), generator: true }; commit(d => ({ ...d, nodes: [...d.nodes, node], edges: [...d.edges, { id: uid(), from: active.id, to: node.id }] })); setSelected([node.id]); setPanel(true); }}>＋ 连接下一步</button></div>}
        {active?.kind === 'image' && active.src && <div className="studio-workflow" data-canvas-ui><span>下一步</span><button onClick={() => continueCreation('image')}><Sparkles size={14} />继续修改</button><button onClick={() => continueCreation('video')}><Video size={14} />生成视频</button></div>}
        {active?.kind === 'video' && active.src && <div className="studio-workflow" data-canvas-ui><span>下一步</span><button onClick={editVideo}><Video size={14}/>编辑视频 · 保留原片</button></div>}
        {selection.filter(n => n.kind === 'image' && n.src).length === 2 && <div className="studio-workflow" data-canvas-ui><button onClick={() => setCompare(selection.filter(n => n.kind === 'image' && n.src))}><Layers3 size={14} />并排对比这两张图</button></div>}

        <div ref={surface} className={`studio-stage ${space || mode === 'hand' ? 'is-hand' : ''} ${connecting ? 'is-connecting' : ''}`} aria-label="无限画布编辑区"
          style={{ backgroundSize: `${Math.max(32, 48 * doc.view.zoom)}px ${Math.max(32, 48 * doc.view.zoom)}px`, backgroundPosition: `${doc.view.x}px ${doc.view.y}px` }}
          onPointerDown={event => begin(event)} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
          onContextMenu={event => { if (isEditing(event.target)) return; event.preventDefault(); setContext(localPoint(event.clientX, event.clientY)); }}

          onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); void importFiles(Array.from(event.dataTransfer.files), screenToWorld(localPoint(event.clientX, event.clientY), doc.view)); }}>
          <div className="studio-world" style={{ transform: `translate(${doc.view.x}px, ${doc.view.y}px) scale(${doc.view.zoom})` }}>
            {groups.map(g => { const b = bounds(g.nodes); return <div key={g.id} className="studio-group" style={{ left: b.x - 20, top: b.y - 45, width: b.width + 40, height: b.height + 65 }}><button onPointerDown={e => begin(e, g.nodes.map(n => n.id))}><Frame size={13} /> 素材分组 · {g.nodes.length} 项</button></div>; })}
            <svg className="studio-connections" aria-label="素材关联线" style={{ opacity: showConnections || linkPreview ? 1 : 0 }}>{doc.edges.map(edge => {
              const a = doc.nodes.find(n => n.id === edge.from), b = doc.nodes.find(n => n.id === edge.to); if (!a || !b) return null;
              const x = a.x + a.width, y = a.y + a.height / 2, ex = b.x, ey = b.y + b.height / 2, bend = Math.max(80, Math.abs(ex - x) * .5);
              return <path key={edge.id} d={`M${x},${y} C${x + bend},${y} ${ex - bend},${ey} ${ex},${ey}`} />;
            })}{linkPreview && <path className={`studio-link-preview ${linkPreview.target && !linkPreview.valid ? 'invalid' : ''}`} data-testid="connection-preview" d={`M${linkPreview.from.x},${linkPreview.from.y} C${linkPreview.from.x + 80},${linkPreview.from.y} ${linkPreview.to.x - 80},${linkPreview.to.y} ${linkPreview.to.x},${linkPreview.to.y}`} />}</svg>
            {visibleNodes.map(node => { const Icon = iconFor(node.kind); const isSelected = selected.includes(node.id); return <article key={node.id} className={`studio-node kind-${node.kind} ${isSelected ? 'is-selected' : ''}`}
              style={{ left: node.x, top: node.y, width: node.width, height: node.height }} aria-label={node.title}
              onPointerDown={event => begin(event, [node.id])}
              onDoubleClick={event => {
                const target = event.target as HTMLElement;
                if (node.kind === 'text' || target.closest('input,textarea,select,video,audio,button:not(.studio-node-empty)')) return;
                event.preventDefault(); event.stopPropagation();
                setSelected([node.id]); setPanel(true);
              }}
              onContextMenu={event => { event.stopPropagation(); if (isEditing(event.target)) return; event.preventDefault(); setSelected([node.id]); setContext({ ...localPoint(event.clientX, event.clientY), nodeId: node.id }); }}>
              <button className={`studio-port port-in ${connecting || linkPreview ? 'ready' : ''} ${linkPreview?.target === node.id ? linkPreview.valid ? 'link-valid' : 'link-invalid' : ''}`} aria-label={`连接到 ${node.title}`} title="按住拖拽连接参考素材，也可点击连线" onPointerDown={e => beginLink(e, node, 'in')} onClick={e => { e.stopPropagation(); if (suppressPortClick.current && e.detail !== 0) { suppressPortClick.current = false; return; } connect(node.id); }} />
              <header><span className="studio-node-icon"><Icon size={14} /></span><input aria-label="素材名称" value={node.title} maxLength={120} onPointerDown={e => e.stopPropagation()} onFocus={() => { textStart.current = docRef.current; setPanel(false); setSelected([node.id]); }} onChange={e => editNode(node.id, { title: e.target.value })} onBlur={() => { if (textStart.current && textStart.current.nodes !== docRef.current.nodes) record(textStart.current); textStart.current = null; }} /><span className="studio-node-grip">⠿</span></header>
              {node.kind === 'text' ? <textarea aria-label="卡片文字" placeholder="写下想法、提示词或分镜…" value={node.text} maxLength={50000} onPointerDown={e => { if (space || mode === 'hand') begin(e); else { e.stopPropagation(); setSelected([node.id]); } }} onFocus={() => { textStart.current = docRef.current; }} onChange={e => editNode(node.id, { text: e.target.value })} onBlur={() => { if (textStart.current && textStart.current.nodes !== docRef.current.nodes) record(textStart.current); textStart.current = null; }} />
                : node.src ? <div className="studio-media">{node.kind === 'image' ? <img src={node.src} alt={node.title} draggable={false} loading="lazy" /> : node.kind === 'audio' ? <audio src={node.src} controls onPointerDown={e => e.stopPropagation()} /> : <video src={playable(node.src)} controls preload="metadata" onPointerDown={e => e.stopPropagation()} />}</div>
                  : <button className="studio-node-empty" onPointerDown={e => begin(e, [node.id])} onClick={e => { if (e.detail === 0) { setSelected([node.id]); setPanel(false); } }}>{node.job?.status === 'running' ? <Loader2 size={28} className="studio-spin" /> : <Icon size={30} />}<strong>{node.job ? node.job.status === 'running' ? '正在创作中' : node.job.status === 'error' ? '生成未完成' : '请核实任务结果' : node.kind === 'image' ? '下一张好作品，从这里开始' : node.kind === 'audio' ? '让文字拥有声音' : '让画面动起来'}</strong><span>{node.job?.message || '连接参考素材，双击节点开始创作'}</span></button>}
              {node.job && <div className="studio-node-job" role="status" title={node.job.message}><span>{node.job.message}</span>{node.job.status === 'running' && <progress aria-label="生成进度" max={100} value={node.job.progress == null ? undefined : Math.min(100, Math.max(0,node.job.progress))}/>}</div>}
              {node.kind !== 'text' && <button className="studio-node-pick" disabled={node.job?.status === 'running'} onPointerDown={e=>e.stopPropagation()} onClick={()=>{setSelected([node.id]);openAssets(node.id,'fill');}}>从素材库选择{node.src ? ' / 替换' : ' / 上传'}</button>}
              <footer><span>{node.kind === 'text' ? `${node.text.length} 字` : node.src ? '素材已就绪' : node.job?.progress != null ? `${Math.round(node.job.progress)}%` : '等待创作'}</span>{node.job?.status === 'done' ? <CheckCircle2 size={12} /> : <span>{node.ratio || (node.kind === 'text' ? 'NOTE' : 'CREATIVE')}</span>}</footer>
              <button className={`studio-port port-out ${connecting === node.id || linkPreview ? 'ready' : ''} ${linkPreview?.target === node.id ? linkPreview.valid ? 'link-valid' : 'link-invalid' : ''}`} aria-label={`从 ${node.title} 连接`} title="按住拖拽连接到下一步，也可点击连线" onPointerDown={e => beginLink(e, node, 'out')} onClick={e => { e.stopPropagation(); if (suppressPortClick.current && e.detail !== 0) { suppressPortClick.current = false; return; } connect(node.id); }} />
              {isSelected && <button className="studio-resize" aria-label="调整素材大小" title="拖动调整大小" onPointerDown={e => begin(e, [node.id], true)} />}
            </article>; })}
          </div>
          {!doc.nodes.length && <div className="studio-welcome" data-canvas-ui onPointerDown={e => e.stopPropagation()}><span className="studio-welcome-mark"><BrandMark size={56} /></span><p className="studio-eyebrow">A LITTLE SPACE. ENDLESS POSSIBILITIES.</p><h1>给灵感，一点自由。</h1><p>想法、参考图和新的作品，在这里自然连接。</p><div className="studio-start-actions"><button onClick={() => fileInput.current?.click()}><Plus size={17} /> 导入第一份素材</button><button onClick={() => add('text')}><Type size={16} /> 记下一个想法</button></div><div className="studio-start-label"><span /> 或者，从一个创作起点开始 <span /></div><div className="studio-template-grid"><button onClick={() => useTemplate('story')}><span className="template-symbol story">01 / 02 / 03</span><strong>短片分镜</strong><small>从故事到镜头，让叙事连贯</small><ArrowUpRight size={15} /></button><button onClick={() => useTemplate('product')}><span className="template-symbol product"><Frame size={27} /><Sparkles size={15} /></span><strong>产品视觉</strong><small>整理卖点，找到品牌的表达</small><ArrowUpRight size={15} /></button><button onClick={() => useTemplate('mood')}><span className="template-symbol mood"><i /><i /><i /></span><strong>灵感情绪板</strong><small>收集色彩、质感与视觉参考</small><ArrowUpRight size={15} /></button></div><p className="studio-welcome-tip">拖入文件或直接粘贴 · 点击左侧「添加文字」记录想法</p></div>}
          {marquee && <div className="studio-marquee" style={{ left: Math.min(marquee.a.x, marquee.b.x), top: Math.min(marquee.a.y, marquee.b.y), width: Math.abs(marquee.a.x - marquee.b.x), height: Math.abs(marquee.a.y - marquee.b.y) }} />}
        </div>
        {!!selection.length && <div className="studio-selection-bar" role="toolbar" aria-label="所选素材操作"><span>{selection.length} 项已选</span>{selection.length > 1 && <select className="studio-batch-connect" aria-label="批量连接到视频节点" value="" onChange={e => connectSelectionToVideo(e.target.value)}><option value="" disabled>连接到视频…</option>{doc.nodes.filter(n => n.kind === 'video').map(n => <option key={n.id} value={n.id} disabled={n.job?.status === 'running'}>{n.title}{n.job?.status === 'running' ? '（生成中）' : ''}</option>)}</select>}<button onClick={duplicate} aria-label="复制所选" title="复制 Ctrl / ⌘ D"><Copy size={15} /></button><button onClick={() => commit(d => ({ ...d, nodes: arrange(d.nodes, selected) }))} aria-label="排列所选" title="整齐排列"><LayoutGrid size={15} /></button>{selection.length > 1 && <button onClick={group} aria-label="组合所选" title="组合 Ctrl / ⌘ G"><Frame size={15} /></button>}{selection.some(n => n.group) && <button onClick={() => commit(d => ({ ...d, nodes: d.nodes.map(n => selected.includes(n.id) ? { ...n, group: undefined } : n) }))}>取消分组</button>}{active && doc.edges.some(e => e.from === active.id || e.to === active.id) && <button onClick={() => commit(d => ({ ...d, edges: d.edges.filter(e => e.from !== active.id && e.to !== active.id) }))} aria-label="断开素材连线" title="断开此素材的连线"><Link2 size={15} /></button>}{active?.src && <button onClick={() => setPreview(active)} aria-label="预览素材"><Maximize size={15} /></button>}{active?.src && <button onClick={() => void downloadNode(active)} aria-label="下载素材"><Download size={15} /></button>}<button onClick={remove} disabled={selection.every(n => n.job?.status === 'running')} aria-label="删除所选" title="删除，可撤销"><Trash2 size={15} /></button><button className="studio-selection-create" onClick={() => setPanel(true)}><Sparkles size={14} /> 创作</button></div>}
        {library && <ProjectLibrary document={doc} projects={projects} selected={active} onClose={()=>setLibrary(false)} onFocus={focusNode} onReuse={reuse} onReference={(p,n)=>{if(active)applyAssets([{...n,origin:{projectId:p.id,nodeId:n.id,title:p.title}}],{id:active.id,mode:'reference'});}} onMove={(id,folder)=>commit(d=>({...d,nodes:d.nodes.map(n=>n.id===id?{...n,assetFolder:folder}:n)}))} onCreateFolder={name=>update({...docRef.current,assetFolders:[...new Set([...(docRef.current.assetFolders||[]),name])].slice(0,100)})} onUpload={(files,folder)=>void importFiles(files,center(),undefined,false,folder)} onDownload={n=>void downloadNode(n)}/>}
        {context && <div className="studio-context" data-canvas-ui role="menu" aria-label={contextNode ? '节点操作' : context.link ? '添加并连接节点' : '添加节点'} style={{ left: clamp(context.x, 8, Math.max(8, size.width - 206)), top: clamp(context.y, 8, Math.max(8, size.height - 340)) }}>
          {contextNode ? <>
            <p className="studio-context-title">{contextNode.title}</p>
            <button role="menuitem" onClick={() => { duplicate(); setContext(null); }}><Copy size={15}/> 复制节点</button>
            <button role="menuitem" onClick={() => { const node = { ...newNode(contextNode.kind, { x: contextNode.x + contextNode.width + 60, y: contextNode.y }), generator: contextNode.kind !== 'text' }; commit(d => ({ ...d, nodes: [...d.nodes, node] })); setSelected([node.id]); setContext(null); setPanel(node.kind !== 'text'); }}><Plus size={15}/> 克隆空节点</button>
            {contextNode.kind !== 'text' && <button role="menuitem" onClick={() => { setPanel(true); setContext(null); }}><Sparkles size={15}/> 打开创作面板</button>}
            {contextNode.src && <><hr/><button role="menuitem" onClick={() => { setPreview(contextNode); setContext(null); }}><Maximize size={15}/> 预览素材</button><button role="menuitem" onClick={() => { void downloadNode(contextNode); setContext(null); }}><Download size={15}/> 下载素材</button></>}
            {!!contextNode.versions?.length && <button role="menuitem" onClick={() => { setNodeHistory(contextNode.id); setContext(null); }}><Layers3 size={15}/> 生成历史</button>}
            {doc.edges.some(e => e.from === contextNode.id || e.to === contextNode.id) && <button role="menuitem" onClick={() => { commit(d => ({ ...d, edges: d.edges.filter(e => e.from !== contextNode.id && e.to !== contextNode.id) })); setContext(null); }}><Link2 size={15}/> 断开连线</button>}
            <hr/><button role="menuitem" className="studio-context-danger" disabled={contextNode.job?.status === 'running'} onClick={() => { remove(); setContext(null); }}><Trash2 size={15}/> 删除节点</button>
          </> : <>
          {context.link && <p className="studio-context-title">添加并连接节点</p>}
          {!context.link && <button role="menuitem" disabled={importing} onClick={() => { importAt.current = screenToWorld(context, doc.view); setContext(null); fileInput.current?.click(); }}><Upload size={15}/> 上传素材</button>}
          {(['text', 'image', 'video', 'audio'] as NodeKind[]).map(kind => { const Icon = iconFor(kind); return <button role="menuitem" key={kind} onClick={() => {
            const link = context.link;
            if (!link) { add(kind, screenToWorld(context, doc.view)); return; }
            if (!docRef.current.nodes.some(n => n.id === link.id)) { setContext(null); return; }
            const node = { ...newNode(kind, link.at), generator: kind !== 'text' };
            node.x = link.at.x - (link.side === 'in' ? node.width : 0); node.y = link.at.y - node.height / 2;
            commit(d => ({ ...d, nodes: [...d.nodes, node], edges: [...d.edges, { id: uid(), from: link.side === 'out' ? link.id : node.id, to: link.side === 'out' ? node.id : link.id }] }));
            setContext(null); setSelected([node.id]); setPanel(kind !== 'text');
          }}><Icon size={15} /> 添加{kind === 'text' ? '文字' : kind === 'image' ? '图像节点' : kind === 'audio' ? '音频节点' : '视频节点'}</button>; })}
          {!context.link && <><hr/><button role="menuitem" onClick={() => { setAssetIntent(null); setAssetBrowser(true); setContext(null); }}><FolderOpen size={15}/> 生成资产库</button><button role="menuitem" onClick={() => { setBatch(true); setContext(null); }}><LayoutGrid size={15}/> 批量创建节点</button></>}
          {!context.link && <button role="menuitem" onClick={() => { fit(); setContext(null); }}><Maximize size={15} /> 查看全部素材</button>}<button role="menuitem" onClick={() => setContext(null)}><X size={15} /> 关闭菜单</button></>}</div>}
        <div className="studio-bottom-left"><span className="studio-board-count"><span /> {doc.nodes.length} 个素材{running && ' · 正在生成'}</span><span className="studio-key-hint"><kbd>空格</kbd> 拖动画布 <kbd>F</kbd> 查看全部</span></div>
        <div className="studio-navigation">
          {!!doc.nodes.length && <div className="studio-minimap" title="点击定位画布" onPointerDown={e => { const r = e.currentTarget.getBoundingClientRect(); const x = (e.clientX - r.left - 10) / miniScale + miniBounds.x, y = (e.clientY - r.top - 10) / miniScale + miniBounds.y; update({ ...docRef.current, view: { ...docRef.current.view, x: size.width / 2 - x * doc.view.zoom, y: size.height / 2 - y * doc.view.zoom } }); }}><svg viewBox="0 0 168 98" aria-label="画布缩略图">{doc.nodes.map(n => <rect key={n.id} x={10 + (n.x - miniBounds.x) * miniScale} y={10 + (n.y - miniBounds.y) * miniScale} width={n.width * miniScale} height={n.height * miniScale} rx="2" className={selected.includes(n.id) ? 'selected' : n.kind} />)}<rect className="viewport" x={10 + (-doc.view.x / doc.view.zoom - miniBounds.x) * miniScale} y={10 + (-doc.view.y / doc.view.zoom - miniBounds.y) * miniScale} width={size.width / doc.view.zoom * miniScale} height={size.height / doc.view.zoom * miniScale} /></svg></div>}
          <div className="studio-zoom" role="toolbar" aria-label="画布视图工具">        <button className={mode === 'select' ? 'active' : ''} onClick={() => setMode('select')} aria-label="选择工具" title="选择 / 框选 V"><MousePointer2 size={19} /></button>
        <button className={mode === 'hand' ? 'active' : ''} onClick={() => setMode('hand')} aria-label="平移工具" title="平移 H · 按住空格"><Hand size={19} /></button><hr />
<button onClick={() => update({ ...doc, view: zoomAround(doc.view, { x: size.width / 2, y: size.height / 2 }, 1 / 1.2) })} aria-label="缩小画布"><Minus size={15} /></button><button onClick={() => update({ ...doc, view: zoomAround(doc.view, { x: size.width / 2, y: size.height / 2 }, 1 / doc.view.zoom) })} title="恢复 100%">{Math.round(doc.view.zoom * 100)}%</button><button onClick={() => update({ ...doc, view: zoomAround(doc.view, { x: size.width / 2, y: size.height / 2 }, 1.2) })} aria-label="放大画布"><Plus size={15} /></button><button onClick={() => fit()} aria-label="查看全部素材" title="适应画布 F"><Maximize size={15} /></button><hr/><button aria-label={showConnections ? '隐藏连线' : '显示连线'} title="显示 / 隐藏连线" onClick={() => setShowConnections(v => !v)}>{showConnections ? <Eye size={16}/> : <EyeOff size={16}/>}</button><button aria-label={dark ? '浅色画布' : '深色画布'} title={dark ? '切换到灵感浅色 · 鼠尾草绿 / 暖沙 / 奶油米' : '切换到经典黑色'} onClick={() => { const next = !dark; setDark(next); localStorage.setItem('canvas-theme', next ? 'dark' : 'light'); }}>{dark ? <Sun size={16}/> : <Moon size={16}/>}</button><hr/><button className="studio-icon" disabled={!history.past.length || running} onClick={() => undo('undo')} aria-label="撤销" title="撤销 Ctrl / ⌘ Z"><Undo2 size={17} /></button><button className="studio-icon" disabled={!history.future.length || running} onClick={() => undo('redo')} aria-label="重做" title="重做 Ctrl / ⌘ Shift Z"><Redo2 size={17} /></button></div>
        </div>
      {panel && <div ref={composerElement} className="studio-composer-anchor" data-canvas-ui style={{ left: composerLeft, top: composerTop, width: composerWidth }}><GeneratorPanel document={doc} projects={projects} onMentionReference={(source,draft,start,end) => {
        if(draft.prompt.length + 20 > 5000) {setNotice('提示词过长，请先缩短再引用素材');return;}
        const target=referenceTarget(draft.kind);
        const nodes=applyAssets([source],{id:target.id,mode:'reference'});
        if(!nodes?.[0]) return;
        const bindings=bindReferences(draft.referenceBindings,nodes);
        const result=insertReference(draft.prompt,start,end,referenceLabel(bindings,nodes[0].id)!);
        update({...docRef.current,drafts:{...docRef.current.drafts,[target.id]:{...draft,prompt:result.prompt,referenceBindings:bindings}}});
        return {...result,bindings};
      }} onPickReferences={kind => {const target=referenceTarget(kind);openAssets(target.id,'reference');}} onFocus={active ? focusActive : undefined} onReorderReference={active ? (id, direction) => { const incoming = docRef.current.edges.filter(e => e.to === active.id); const index = incoming.findIndex(e => e.from === id); const next = index + direction; if (index < 0 || next < 0 || next >= incoming.length) return; [incoming[index], incoming[next]] = [incoming[next], incoming[index]]; commit(d => ({...d, edges:[...d.edges.filter(e => e.to !== active.id), ...incoming]})); } : undefined} importing={importing} onUploadReferences={kind => uploadReferences(kind)} onDropReferences={(kind, files) => uploadReferences(kind, files)} key={active?.id || "general"} draft={doc.drafts?.[active?.id || "general"]} onDraft={draft => { const key = active?.id || "general"; if (JSON.stringify(docRef.current.drafts?.[key]) !== JSON.stringify(draft)) update({ ...docRef.current, drafts: { ...docRef.current.drafts, [key]: draft } }); }} onRemoveReference={active && (active.generator || !active.src) ? id => { commit(d => ({ ...d, edges: d.edges.filter(e => !(e.from === id && e.to === active.id)) })); } : undefined} references={references} selected={active} busy={active?.job?.status === 'running'} onClose={() => setPanel(false)} onGenerate={options => void generate(options)} onConnect={() => { setLibrary(true); setNotice('选中一张图片即可作为参考；按 Shift 可选择多张。'); }} /></div>}
        {notice && <div className="studio-toast" role="status"><span>{notice}</span><button onClick={() => setNotice('')} aria-label="关闭提示"><X size={15} /></button></div>}
      </div>

    </div>
    <input ref={referenceInput} type="file" aria-label="上传节点参考素材" accept="image/*,video/mp4,video/webm,audio/mpeg,audio/wav,audio/x-wav,audio/ogg,audio/webm" multiple hidden onChange={e => { const targetId = referenceUploadTarget.current; referenceUploadTarget.current = undefined; const target = docRef.current.nodes.find(n => n.id === targetId); void importFiles(Array.from(e.target.files ?? []), target ? { x: target.x - 380, y: target.y } : center(), targetId); e.target.value = ''; }} />
    <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/heic,image/heif,video/mp4,video/webm,audio/mpeg,audio/wav,audio/ogg" multiple hidden onChange={e => { void importFiles(Array.from(e.target.files ?? []), importAt.current); importAt.current = undefined; e.target.value = ''; }} />
    <input ref={backupInput} type="file" accept=".json" hidden onChange={e => { void importBackup(e.target.files?.[0]); e.target.value = ''; }} />
    {assetBrowser && <div className="studio-overlay" onClick={() => {setAssetBrowser(false);setAssetIntent(null);}}><div onClick={e => e.stopPropagation()}><AssetPicker document={doc} projects={projects} target={doc.nodes.find(n=>n.id === assetIntent?.id)} mode={assetIntent?.mode || 'add'} onClose={()=>{setAssetBrowser(false);setAssetIntent(null);}} onChoose={nodes=>applyAssets(nodes)} onFiles={files=>{const intent=assetIntent;setAssetBrowser(false);setAssetIntent(null);void importFiles(files,center(),intent?.id,intent?.mode === 'fill');}}/></div></div>}
    {imageTools && <div className="studio-overlay"><ImageTools node={imageTools} onClose={() => setImageTools(null)} onApply={src => { const source = imageTools; const node = { ...newNode('image', { x: source.x + source.width + 100, y: source.y }), src, title: `${source.title} · 编辑`, origin: { projectId: doc.id, nodeId: source.id, title: source.title } }; commit(d => ({ ...d, nodes: [...d.nodes, node], edges: [...d.edges, { id: uid(), from: source.id, to: node.id }] })); setImageTools(null); setSelected([node.id]); }}/></div>}
    {batch && <div className="studio-overlay"><section className="studio-batch-dialog" role="dialog" aria-modal="true" aria-label="批量创建生成节点"><header><h2>批量创建生成节点</h2><button onClick={() => setBatch(false)} aria-label="关闭批量节点">✕</button></header><p>每行一个提示词，最多 20 个。先创建草稿，再按节点设置模型与参考图。</p><label>节点类型<select value={batchKind} onChange={e => setBatchKind(e.target.value as 'image' | 'video')}><option value="image">图片生成</option><option value="video">视频生成</option></select></label><textarea aria-label="批量节点提示词" value={batchText} maxLength={30000} onChange={e => setBatchText(e.target.value)} placeholder={'远景：晨雾中的山间湖泊\n近景：人物沿湖边小路前行\n特写：阳光透过树叶落在水面'} /><button className="studio-primary-action" onClick={createBatch}>创建节点 · 不产生生成费用</button></section></div>}
    {historyNode && <div className="studio-overlay"><section className="studio-node-history" role="dialog" aria-modal="true" aria-label="节点生成历史"><header><div><h2>{historyNode.title} · 生成历史</h2><p>每次生成的结果都保留在节点中</p></div><button onClick={() => setNodeHistory(null)} aria-label="关闭节点历史">✕</button></header><div className="studio-version-grid">{[...(historyNode.versions || [])].reverse().map(v => <article key={v.id}>{historyNode.kind === 'image' ? <img src={v.src} alt="历史生成结果"/> : historyNode.kind === 'audio' ? <audio src={v.src} controls/> : <video src={playable(v.src)} controls preload="metadata"/>}<small>{new Date(v.createdAt).toLocaleString()} · {v.model || '生成结果'}</small><p>{v.prompt}</p><div><button disabled={historyNode.job?.status === 'running'} onClick={() => { commit(d => ({ ...d, nodes: d.nodes.map(n => n.id === historyNode.id ? { ...n, src: v.src, text: v.prompt, model: v.model, ratio: v.ratio, job: { status: 'done', contentId: v.contentId, message: '已恢复历史版本' } } : n), drafts: { ...d.drafts, [historyNode.id]: { kind: historyNode.kind === 'text' ? 'image' : historyNode.kind, prompt: v.prompt, model: v.model || '', ratio: v.ratio || '16:9', resolution: v.resolution || '1K', seconds: historyNode.settings?.seconds || 5 } } })); setNodeHistory(null); setPanel(false); }}>设为当前版本</button><button onClick={() => { addAssets([{ ...newNode(historyNode.kind, center()), src: v.src, text: v.prompt, model: v.model, title: `${historyNode.title} · 历史版本` }]); setNodeHistory(null); }}>复制到画布</button></div></article>)}</div>{!historyNode.versions?.length && <p>此节点还没有生成结果。生成后可以在这里比较、恢复或复制各个版本。</p>}</section></div>}
    {projectMenu && <div className="studio-overlay" onClick={() => setProjectMenu(false)}><section className="studio-project-menu" role="dialog" aria-modal="true" aria-label="画布项目" onClick={e => e.stopPropagation()}><header><h2>我的创作空间</h2><button className="studio-icon" onClick={() => setProjectMenu(false)} aria-label="关闭项目列表"><X size={18} /></button></header><label className="studio-field">当前画布名称<input value={doc.title} maxLength={80} onChange={e => update({ ...docRef.current, title: e.target.value })} /></label><div className="studio-project-list">{projects.map(p => <button key={p.id} onClick={() => { onSwitch(p.id); setProjectMenu(false); }}><Layers3 size={18} /><span><strong>{p.title || '未命名画布'}</strong><small>{p.nodes.length} 个素材</small></span>{p.id === doc.id && <Check size={15} />}</button>)}</div><div className="studio-project-actions"><button onClick={() => onCreate(newDocument(`新画布 ${projects.length + 1}`))}><Plus size={16} /> 新建画布</button><button onClick={() => backupInput.current?.click()}><Upload size={16} /> 导入备份</button></div><p>{status}</p>{onImportGuest && <button className="studio-import-guest" onClick={() => void onImportGuest()}>导入此浏览器的访客作品</button>}<p>访客保存在此浏览器；登录后自动同步到账户。云端暂不可用时可继续编辑，导出备份可独立保存作品。</p></section></div>}
    {help && <div className="studio-overlay" onClick={() => setHelp(false)}><section className="studio-help" role="dialog" aria-modal="true" aria-label="画布操作帮助" onClick={e => e.stopPropagation()}><header><div><span className="studio-eyebrow">MAKE YOURSELF AT HOME</span><h2>顺手的小技巧</h2></div><button className="studio-icon" onClick={() => setHelp(false)} aria-label="关闭操作帮助"><X size={18} /></button></header><dl>{[['V / H', '切换选择 / 平移工具'], ['空格 + 拖动', '随时平移画布'], ['鼠标滚轮 / 触控板捏合', '以指针位置为中心缩放'], ['触控板双指滑动', '平移画布'], ['Shift + 单击', '多选素材'], ['拖动空白处', '框选素材'], ['Ctrl / ⌘ Z', '撤销上一步'], ['Ctrl / ⌘ Shift Z', '重做'], ['Ctrl / ⌘ D', '复制所选素材'], ['Ctrl / ⌘ G', '组合所选素材'], ['F', '一键查看全部'], ['双击节点', '打开创作面板'], ['T / 添加文字', '创建文字节点']].map(([keys, label]) => <div key={keys}><dt>{label}</dt><dd>{keys}</dd></div>)}</dl><p>按住卡片右侧连接点，拖到另一张卡片左侧，松手完成关联；也可反向拖拽或逐点点击。拖动时按 Esc 取消。选中素材后，可以在顶部工具条排列、复制和下载。</p></section></div>}
    {compare && <div className="studio-overlay" onClick={() => setCompare(null)}><section className="studio-compare" role="dialog" aria-modal="true" aria-label="版本对比" onClick={e => e.stopPropagation()}><header><h2>并排对比 · 保留每次探索</h2><button onClick={() => setCompare(null)} aria-label="关闭对比"><X size={20} /></button></header><div>{compare.map(n => <figure key={n.id}><img src={n.src} alt={n.title} /><figcaption><strong>{n.title}</strong><small>{[n.model, n.ratio, n.settings?.resolution].filter(Boolean).join(' · ') || '原始素材'}</small><p>{n.text || '未填写提示词'}</p><button onClick={() => { focusNode(n); setCompare(null); setPanel(true); }}>使用这个版本继续创作</button></figcaption></figure>)}</div></section></div>}
    {preview && <div className="studio-overlay studio-preview" onClick={() => setPreview(null)} role="dialog" aria-modal="true" aria-label="素材预览"><button className="studio-preview-close" onClick={() => setPreview(null)} aria-label="关闭预览"><X size={24} /></button>{preview.kind === 'image' ? <img src={preview.src} alt={preview.title} onClick={e => e.stopPropagation()} /> : preview.kind === 'audio' ? <audio src={preview.src} controls autoPlay onClick={e => e.stopPropagation()} /> : <video src={playable(preview.src!)} controls autoPlay onClick={e => e.stopPropagation()} />}<span>{preview.title}</span></div>}
  </main>;
}

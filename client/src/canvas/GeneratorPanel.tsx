import type { CSSProperties } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUpRight, Video, Sparkles, X, RefreshCw, Paperclip } from 'lucide-react';
import { Link } from 'react-router-dom';
import { fetchImageModels, type ImageModel } from '../api/imageGen';
import { fetchVideoModels, type VideoModel } from '../api/video';
import { snumomSdMiniSecondsForResolution } from '../utils/videoModelCapabilities';
import { useAuthStore } from '../stores/authStore';
import { analysisApi } from '../api/analysis';
import { canvasVideoReferenceLimits } from '../../../shared/canvasVideoReferences';
import { VIDEO_EDIT_MODEL, videoInputError } from './videoInputs';
import type { CanvasNode, GenerationDraft } from './model';

export type GenerateOptions = GenerationDraft & { inputPrompt?: string };
type Props = { onPickReferences?: (kind: GenerationDraft['kind']) => void; onFocus?: () => void; onReorderReference?: (id: string, direction: number) => void; onUploadReferences?: (kind: GenerationDraft['kind']) => void; onDropReferences?: (kind: GenerationDraft['kind'], files: File[]) => void; importing?: boolean; key?: string; draft?: GenerationDraft; onDraft?: (draft: GenerationDraft) => void; references: CanvasNode[]; selected?: CanvasNode; busy: boolean; onClose: () => void; onGenerate: (options: GenerateOptions) => void; onConnect: () => void; onRemoveReference?: (id: string) => void };
export default function GeneratorPanel({ onPickReferences, onFocus, onReorderReference, draft, onDraft, references, selected, busy, onClose, onGenerate, onRemoveReference, onUploadReferences, onDropReferences, importing }: Props) {
  const [menu, setMenu] = useState<'models' | 'params' | null>(null);
  const [search, setSearch] = useState('');
  const modelTrigger = useRef<HTMLButtonElement>(null);
  const paramsTrigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [popupStyle, setPopupStyle] = useState<CSSProperties>({});
  useLayoutEffect(() => {
    if (!menu) return;
    const position = () => {
      const rect = (menu === 'models' ? modelTrigger : paramsTrigger).current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(menu === 'models' ? 300 : 250, window.innerWidth - 24);
      const above = rect.top - 20, below = window.innerHeight - rect.bottom - 20;
      const up = above >= Math.min(320, below);
      setPopupStyle({position:'fixed', width, left:Math.max(12,Math.min(rect.left,window.innerWidth-width-12)),
        top:up ? undefined : rect.bottom+8, bottom:up ? window.innerHeight-rect.top+8 : undefined,
        maxHeight:Math.max(80,Math.min(360,up ? above : below))});
    };
    position(); window.addEventListener('resize',position); window.addEventListener('scroll',position,true);
    const dismiss = (e: PointerEvent) => { const target=e.target as Node; if (!popup.current?.contains(target) && !modelTrigger.current?.contains(target) && !paramsTrigger.current?.contains(target)) setMenu(null); };
    const escape = (e: KeyboardEvent) => { if(e.key === 'Escape') {e.preventDefault();e.stopPropagation();setMenu(null);(menu === 'models' ? modelTrigger : paramsTrigger).current?.focus();} };
    document.addEventListener('pointerdown',dismiss); document.addEventListener('keydown',escape,true);
    return () => { window.removeEventListener('resize',position);window.removeEventListener('scroll',position,true);document.removeEventListener('pointerdown',dismiss);document.removeEventListener('keydown',escape,true); };
  }, [menu]);
  const user = useAuthStore(s => s.user);
  const [kind, setKind] = useState<GenerationDraft['kind']>(draft?.kind ?? (selected?.kind === 'video' ? 'video' : selected?.kind === 'audio' ? 'audio' : 'image'));
  const [prompt, setPrompt] = useState(draft?.prompt ?? selected?.text ?? '');
  const [model, setModel] = useState(draft?.model ?? selected?.model ?? '');
  const [images, setImages] = useState<ImageModel[]>([]);
  const [videos, setVideos] = useState<VideoModel[]>([]);
  const [audios, setAudios] = useState<ImageModel[]>([]);
  const [count, setCount] = useState(draft?.count || 1);
  const [videoMode, setVideoMode] = useState<NonNullable<GenerationDraft['videoMode']>>(draft?.videoMode || (selected?.kind === 'video' && selected.src && !selected.generator ? 'edit' : 'reference'));
  const referenceSignature = references.map(n => n.id + ':' + n.kind).join('|');
  const previousReferences = useRef<string | undefined>(undefined);
  useEffect(() => {
    const signature = kind + ':' + referenceSignature;
    if (previousReferences.current === signature) return;
    previousReferences.current = signature;
    if (kind !== 'video') return;
    if (references.some(n => n.kind === 'video' || n.kind === 'audio')) {
      if (videoMode !== 'edit' || references.some(n => n.kind === 'audio')) setVideoMode('multimodal');
    } else if (references.some(n => n.kind === 'image') && videoMode === 'text') setVideoMode('reference');
  }, [kind, referenceSignature, videoMode]);
  const [firstFrameId, setFirstFrame] = useState(draft?.firstFrameId || '');
  const [lastFrameId, setLastFrame] = useState(draft?.lastFrameId || '');
  const [voice, setVoice] = useState(draft?.voice || 'Zephyr');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [ratio, setRatio] = useState(draft?.ratio ?? selected?.ratio ?? '16:9');
  const [resolution, setResolution] = useState(draft?.resolution ?? selected?.settings?.resolution ?? (selected?.kind === 'video' ? '720p' : '1K'));
  const [seconds, setSeconds] = useState(draft?.seconds ?? selected?.settings?.seconds ?? 5);
  useEffect(() => { onDraft?.({ kind, prompt, model, ratio, resolution, seconds, count, videoMode, firstFrameId, lastFrameId, voice }); }, [kind, prompt, model, ratio, resolution, seconds, count, videoMode, firstFrameId, lastFrameId, voice]);
  useEffect(() => {
    if (kind !== 'audio') return;
    let cancelled = false;
    analysisApi.getTtsModels().then(data => { if (!cancelled) setAudios(data.map(m => ({ id: m.modelId, name: m.displayName, description: '', available: true, rate: m.rate }))); }).catch(() => { if (!cancelled) setError('音频模型加载失败，请登录或重试。'); });
    return () => { cancelled = true; };
  }, [kind, user?.id, retry]);
  useEffect(() => {
    let cancelled = false; setLoading(true); setError('');
    Promise.allSettled([fetchImageModels(), fetchVideoModels()]).then(([a, b]) => {
      if (cancelled) return;
      if (a.status === 'fulfilled') setImages(a.value.filter(m => m.available));
      if (b.status === 'fulfilled') setVideos(b.value.filter(m => m.available));
      if (a.status === 'rejected' || b.status === 'rejected') setError('部分模型暂时无法加载，请重试。');
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [retry, user?.id]);
  const models = kind === 'image' ? images : kind === 'audio' ? audios : videos.filter(m => videoMode === 'edit' ? m.id === VIDEO_EDIT_MODEL : videoMode === 'multimodal' ? Boolean(canvasVideoReferenceLimits(m.id)) : m.id !== VIDEO_EDIT_MODEL);
  const activeModel = models.find(m => m.id === model);
  const video = kind === 'video' ? videos.find(m => m.id === model) : undefined;
  const resolutions = kind === 'image' ? (model === 'gpt-image-2' ? ['1K', '4K'] : ['1K', '2K', '4K']) : Object.keys(video?.rates ?? { '720p': 0 });
  const durations = kind === 'video' && videoMode === 'edit' ? [10] : model === 'sd-mini' ? [snumomSdMiniSecondsForResolution(resolution)]
    : video?.allowedSeconds?.length ? video.allowedSeconds : [5, 10, 15].filter(n => !video?.maxSeconds || n <= video.maxSeconds);
  useEffect(() => { if (!loading && !error && !models.some(m => m.id === model)) setModel(models.find(m => m.id === selected?.model)?.id || models[0]?.id || ''); }, [kind, videoMode, images, videos, audios, model, loading, error]);
  useEffect(() => { if (!loading && !resolutions.includes(resolution)) setResolution(resolutions[0] || (kind === 'image' ? '1K' : '720p')); }, [kind, model, resolutions.join(','), loading]);
  useEffect(() => { if (!loading && !durations.includes(seconds)) setSeconds(durations[0] || 5); }, [model, resolution, durations.join(','), loading]);
  const ratios = kind === 'video' && videoMode === 'edit' ? ['16:9', '9:16'] : ['16:9', '9:16', '1:1', '4:3', '3:4'];
  useEffect(() => { if (!ratios.includes(ratio)) setRatio(ratios[0]); }, [kind, videoMode, ratio]);
  const inputError = videoInputError({ kind, videoMode, model, ratio, seconds }, references);
  const referenceLimits = kind === 'video' && videoMode === 'multimodal' ? canvasVideoReferenceLimits(model) : undefined;
  const imageRefs = references.filter(n => n.kind === 'image' && n.src);
  const textRefs = references.filter(n => n.kind === 'text' && n.text.trim());
  const combined = [...textRefs.map(n => n.text), prompt.trim()].filter(Boolean).join('\n\n');
  const hasPrompt = Boolean(combined);
  const missingRef = Boolean(video?.requireRef && !imageRefs.length);
  const supportsFrames = /^(veo|wan3\.0)/i.test(model);
  const frameInvalid = kind === 'video' && videoMode === 'frames' && (!supportsFrames || !imageRefs.some(n => n.id === (firstFrameId || imageRefs[0]?.id)) || Boolean(lastFrameId && !imageRefs.some(n => n.id === lastFrameId)));
  const imagePrice = kind === 'image' ? (activeModel as ImageModel | undefined)?.resolutionPrices?.[resolution] ?? (activeModel as ImageModel | undefined)?.rate : undefined;
  const videoRate = video?.rates?.[resolution as keyof NonNullable<VideoModel['rates']>];
  const videoPrice = videoRate != null && video?.billingType === 'per_second' ? videoRate * seconds : video?.billingType === 'per_call' ? videoRate : undefined;
  const estimatedCost = kind === 'image' && imagePrice != null ? imagePrice * count : kind === 'audio' && activeModel?.rate != null ? activeModel.rate * combined.length : videoPrice;
  return <aside className="studio-inspector" aria-label="创作面板">
    <header className="studio-compact-header">{onFocus && <button className="studio-focus-node" onClick={onFocus}>聚焦节点</button>}<button className="studio-icon" onClick={onClose} aria-label="收起创作面板"><X size={16}/></button></header><div className="studio-inspector-scroll">
      {kind === 'video' && <div className="studio-video-modes">{([['text', '文生视频'], ['reference', '图片参考'], ['multimodal', '多模态参考'], ['frames', '首尾帧'], ['edit', '视频编辑']] as const).map(([id, label]) => <button key={id} className={videoMode === id ? 'active' : ''} onClick={() => setVideoMode(id)}>{label}</button>)}</div>}
      <div className="studio-prompt-label"><label htmlFor="canvas-prompt">你想创作什么？</label><span>{prompt.length}/5000</span></div>
      <textarea id="canvas-prompt" className="studio-prompt" value={prompt} maxLength={5000} onChange={e => setPrompt(e.target.value)} placeholder={kind === 'image' ? '描述主体、场景、光线和你想要的感觉…' : kind === 'audio' ? '输入希望朗读的文字…' : videoMode === 'edit' ? '描述想修改的部分，以及需要保留的主体与动作…' : '描述主体动作、镜头运动和画面变化…'} />
      {selected?.job && <p className="studio-job-detail">{selected.job.message}{selected.job.status !== 'done' && <Link to="/app/history">查看生成记录 <ArrowUpRight size={12} /></Link>}</p>}
      {selected?.origin && <p className="studio-hint">来源：{selected.origin.title} · 原始素材已保留</p>}
      <section className="studio-attachments" onDragOver={e => { e.preventDefault(); e.stopPropagation(); }} onDrop={e => { e.preventDefault(); e.stopPropagation(); onDropReferences?.(kind, Array.from(e.dataTransfer.files)); }}>
{onPickReferences && <button className="studio-attach-button" disabled={busy} onClick={()=>onPickReferences(kind)}>从素材库引用</button>}
{onUploadReferences && <button className="studio-attach-button" aria-label="上传参考图片 / 视频 / 音频" title="上传或拖入参考素材" disabled={importing} onClick={() => onUploadReferences(kind)}><Paperclip size={14}/>{importing ? '导入中…' : '添加参考'}</button>}
{references.length > 0 && <span className="studio-linked-label">已连接 {references.length} 项</span>}
{references.map((n, index) => <div className="studio-attachment" key={n.id}><details><summary title={n.title}>{n.kind === 'image' && n.src ? <img src={n.src} alt=""/> : n.kind === 'video' ? <Video size={14}/> : <span>{n.kind === 'audio' ? '♫' : '文'}</span>}<span>{n.title}{(n.kind === 'text' ? !n.text.trim() : !n.src) ? ' · 待添加内容' : n.job?.status === 'running' ? ' · 生成中' : ''}</span></summary><div className="studio-attachment-preview">{n.kind === 'image' && n.src ? <img src={n.src} alt={n.title}/> : n.kind === 'audio' && n.src ? <audio controls preload="metadata" src={n.src} aria-label={'试听 '+n.title}/> : n.kind === 'video' && n.src ? <video controls preload="metadata" src={n.src.startsWith('data:') ? n.src : '/api/video/play?url='+encodeURIComponent(n.src)} aria-label={'预览 '+n.title}/> : <p>{n.text}</p>}</div></details>{onReorderReference && references.length > 1 && <><button disabled={busy || index === 0} aria-label={'前移参考 '+n.title} onClick={() => onReorderReference(n.id,-1)}>‹</button><button disabled={busy || index === references.length-1} aria-label={'后移参考 '+n.title} onClick={() => onReorderReference(n.id,1)}>›</button></>}{kind === 'video' && n.kind === 'image' && n.src && supportsFrames && <select aria-label={'参考用途 '+n.title} value={videoMode === 'frames' ? (firstFrameId || imageRefs[0]?.id) === n.id ? 'first' : lastFrameId === n.id ? 'last' : 'unused' : 'reference'} disabled={busy} onChange={e => { if (e.target.value === 'reference') setVideoMode('reference'); else { setVideoMode('frames'); if(e.target.value === 'first') {setFirstFrame(n.id); if(lastFrameId === n.id) setLastFrame('');} else {setLastFrame(n.id); if((firstFrameId || imageRefs[0]?.id) === n.id) setFirstFrame(imageRefs.find(r => r.id !== n.id)?.id || n.id);} } }}><option value="reference">普通参考</option><option value="first">首帧</option><option value="last">尾帧</option><option value="unused" disabled>本次不使用</option></select>}{onRemoveReference && <button disabled={busy} onClick={() => onRemoveReference(n.id)} aria-label={'移除参考 '+n.title}><X size={12}/></button>}</div>)}
</section>
      {!references.length && <p className="studio-hint studio-link-hint">从素材节点右侧拖线到此节点左侧，即可用作参考。</p>}
      {kind === 'video' && videoMode === 'edit' && <p className="studio-hint">连接一个不超过 15 秒的原视频，可附加图片。输出固定 10 秒，原片保留。{!loading && !models.length && ' 视频编辑模型暂不可用，请检查登录状态或重试加载。'}</p>}
      {inputError && (model || !inputError.includes('请选择可用')) && <p className="studio-inline-error" role="alert">{inputError}</p>}
      {kind === 'video' && videoMode === 'frames' && <div className="studio-frame-slots"><label>首帧<select value={firstFrameId || imageRefs[0]?.id || ''} onChange={e => setFirstFrame(e.target.value)}><option value="">选择参考图</option>{imageRefs.map(n => <option key={n.id} value={n.id}>{n.title}</option>)}</select></label><label>尾帧（选填）<select value={lastFrameId} onChange={e => setLastFrame(e.target.value)}><option value="">不指定</option>{imageRefs.map(n => <option key={n.id} value={n.id}>{n.title}</option>)}</select></label>{!supportsFrames && <small>首尾帧模式请选择 Veo 或 Wan 3.0 模型。</small>}</div>}
      {error && <div className="studio-inline-error">{error}<button onClick={() => setRetry(n => n + 1)}><RefreshCw size={13} /> 重试</button></div>}
      {missingRef && <p className="studio-inline-error">此模型需要参考图，请先选中或连接一张图片。</p>}
    </div><div className="studio-composer-tools"><select onPointerDown={() => setMenu(null)} aria-label="创作类型" value={kind} onChange={e => setKind(e.target.value as GenerationDraft['kind'])}><option value="image">图像生成</option><option value="video">视频生成</option><option value="audio">音频生成</option></select><button ref={modelTrigger} className="studio-model-trigger" aria-label="生成模型" aria-haspopup="listbox" aria-expanded={menu === 'models'} title={activeModel?.name || '选择模型'} disabled={loading || !models.length} onClick={() => {setSearch('');setMenu(menu === 'models' ? null : 'models');}}><span>{loading ? '加载模型…' : activeModel?.name || '暂无可用模型'}</span><span aria-hidden="true">⌄</span></button><button ref={paramsTrigger} className="studio-params-trigger" aria-label="生成参数" aria-expanded={menu === 'params'} onClick={() => setMenu(menu === 'params' ? null : 'params')}>{kind === 'audio' ? voice : ratio+' · '+resolution+' · '+(kind === 'video' ? seconds+' 秒' : count+' 张')} ⌄</button>
      {menu === 'models' && <div ref={popup} className="studio-floating-menu studio-model-menu" style={popupStyle} data-canvas-ui onKeyDown={e => {if(e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return; e.preventDefault(); const options: HTMLButtonElement[]=Array.from(popup.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') || []);const index=options.indexOf(document.activeElement as HTMLButtonElement);options[(index+(e.key === 'ArrowDown' ? 1 : -1)+options.length)%options.length]?.focus();}}><input autoFocus aria-label="搜索模型" placeholder="搜索模型…" value={search} onChange={e => setSearch(e.target.value)}/><div role="listbox" aria-label="可用生成模型">{models.filter(m => (m.name+' '+m.id).toLowerCase().includes(search.toLowerCase())).map(m => <button role="option" aria-selected={model === m.id} key={m.id} onClick={() => {setModel(m.id);setMenu(null);modelTrigger.current?.focus();}}><span>{m.name}</span>{model === m.id && <span aria-hidden="true">✓</span>}</button>)}</div>{!models.some(m => (m.name+' '+m.id).toLowerCase().includes(search.toLowerCase())) && <p>未找到匹配模型</p>}</div>}
      <div ref={menu === 'params' ? popup : undefined} hidden={menu !== 'params'} role="dialog" aria-label="生成参数设置" className="studio-floating-menu studio-parameter-popover" style={menu === 'params' ? popupStyle : undefined} data-canvas-ui>
      {kind !== 'audio' && <div className="studio-field-grid"><label className="studio-field">画面比例<select value={ratio} onChange={e => setRatio(e.target.value)}>{ratios.map(r => <option key={r}>{r}</option>)}</select></label><label className="studio-field">清晰度<select value={resolution} onChange={e => setResolution(e.target.value)}>{resolutions.map(r => <option key={r}>{r}</option>)}</select></label></div>}
      {kind === 'audio' && <label className="studio-field">音色<select value={voice} onChange={e => setVoice(e.target.value)}>{['Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Aoede', 'Despina'].map(v => <option key={v}>{v}</option>)}</select></label>}
      {kind === 'image' && <label className="studio-field">生成数量<select value={count} onChange={e => setCount(Number(e.target.value))}>{[1, 2, 4].map(n => <option key={n} value={n}>{n} 张</option>)}</select></label>}
      {kind === 'video' && <label className="studio-field">视频时长<select value={seconds} onChange={e => setSeconds(Number(e.target.value))}>{durations.map(s => <option key={s} value={s}>{s} 秒</option>)}</select></label>}
{referenceLimits && <small>参考上限：{referenceLimits.images} 图 / {referenceLimits.videos} 视频 / {referenceLimits.audios} 音频{referenceLimits.wavOnly ? '（仅 WAV）' : ''}</small>}<small>图片 ≤20 MB · 视频 / 音频 ≤40 MB</small></div></div>
    <footer className="studio-generate-footer"><button aria-label={busy ? '节点正在生成' : user ? `生成${kind === 'image' ? '图像' : kind === 'audio' ? '音频' : '视频'}` : '登录后生成'} title={user ? '生成' : '登录后生成'} className="studio-generate" disabled={busy || (Boolean(user) && (!activeModel || loading || !hasPrompt || Boolean(inputError) || missingRef || frameInvalid || kind === 'video' && videoMode === 'text' && video?.requireRef))} onClick={() => onGenerate({ kind, prompt: combined, inputPrompt: prompt, model, ratio, resolution, seconds, count, videoMode, firstFrameId: firstFrameId || imageRefs[0]?.id, lastFrameId, voice })}><Sparkles size={17} />{busy ? '节点正在生成' : user ? `生成${kind === 'image' ? '图像' : kind === 'audio' ? '音频' : '视频'}` : '登录后生成'}<ArrowUpRight size={17} /></button>
      <small>{estimatedCost != null ? '将预扣 ¥'+Number(estimatedCost.toFixed(kind === 'audio' ? 6 : kind === 'image' ? 2 : 4))+' · 失败退回' : '价格待确认，以提交时服务端报价为准'}{kind === 'image' && count > 1 ? ' · 按成功张数结算' : ''}</small></footer>
  </aside>;
}

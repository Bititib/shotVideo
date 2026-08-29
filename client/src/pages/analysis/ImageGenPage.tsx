import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Image as ImageIcon, Play, Square, Download, RotateCcw, Loader2, Check, AlertCircle, Sparkles, Monitor, Smartphone, RectangleHorizontal, Upload, X, Grid2x2, Maximize2, Trash2 } from 'lucide-react';
import { fetchImageModels, generateImage, type ImageModel, type ImageSSEEvent } from '../../api/imageGen';
import { contentApi } from '../../api/content';
import { useImageDropPaste } from '../../hooks/useImageDropPaste';
import { useAuthGuard } from '../../hooks/useAuthGuard';

interface GeneratedImage {
  id: string;
  prompt: string;
  imageUrl: string;
  model: string;
  createdAt: Date;
  aspectRatio: string;
}

const ASPECT_RATIOS = [
  { value: '16:9', label: '16:9', icon: RectangleHorizontal },
  { value: '9:16', label: '9:16', icon: Smartphone },
  { value: '1:1', label: '1:1', icon: Monitor },
  { value: '4:3', label: '4:3', icon: RectangleHorizontal },
  { value: '3:4', label: '3:4', icon: Smartphone },
  { value: '3:2', label: '3:2', icon: RectangleHorizontal },
  { value: '2:3', label: '2:3', icon: Smartphone },
  { value: '21:9', label: '21:9', icon: RectangleHorizontal },
];

const COUNT_OPTIONS = [
  { value: 1, label: '1张' },
  { value: 2, label: '2张' },
  { value: 4, label: '4张' },
];

function CustomSelect({ value, options, onChange, icon: Icon, prefix }: any) {
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setIsOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  const selected = options.find((o: any) => o.value === value);
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setIsOpen(!isOpen)} className={`flex items-center gap-2 bg-white/[0.03] hover:bg-white/[0.05] rounded-lg px-3 py-2 text-[11px] text-zinc-300 transition-colors border ${isOpen ? 'border-pink-500/30' : 'border-transparent'}`}>
        {selected?.icon ? <selected.icon className="w-3.5 h-3.5 text-pink-400" /> : Icon && <Icon className="w-3.5 h-3.5 text-pink-400" />}
        {prefix}{selected?.label || value}
      </button>
      {isOpen && (
        <div className="absolute bottom-full left-0 mb-2 min-w-full w-max bg-[#1a1a1a] border border-white/10 rounded-xl shadow-2xl p-1 z-50 flex flex-col max-h-[240px] overflow-y-auto [&::-webkit-scrollbar]:hidden" style={{ scrollbarWidth: 'none' }}>
          {options.map((o: any) => (
            <button key={o.value} onClick={() => { onChange(o.value); setIsOpen(false); }}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-left text-[11px] transition-colors ${value === o.value ? 'bg-pink-500/20 text-pink-300' : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/5'}`}>
              {o.icon && <o.icon className="w-3.5 h-3.5" />}
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** 瀑布流图片卡片 */
function ImageCard({ url, index, onPreview }: { url: string; index: number; onPreview: () => void }) {
  return (
    <div className="group relative rounded-xl overflow-hidden border border-white/5 hover:border-pink-500/30 transition-all cursor-pointer bg-black/20" onClick={onPreview}>
      <img src={url} alt={`生成图片 ${index + 1}`} className="w-full block max-h-[60vh] object-contain" loading="lazy" />
      <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
        <div className="absolute bottom-2 right-2 flex gap-1.5">
          <button onClick={(e) => { e.stopPropagation(); onPreview(); }} className="p-1.5 bg-black/50 backdrop-blur rounded-lg text-white/80 hover:text-white"><Maximize2 className="w-3.5 h-3.5" /></button>
          <a href={url} target="_blank" rel="noopener noreferrer" download onClick={(e) => e.stopPropagation()} className="p-1.5 bg-black/50 backdrop-blur rounded-lg text-white/80 hover:text-white"><Download className="w-3.5 h-3.5" /></a>
        </div>
      </div>
    </div>
  );
}

/** 生成中的占位卡片 - 骨架屏风格 */
function PlaceholderCard({ index, progress }: { index: number; progress: number; key?: any }) {
  return (
    <div className="relative h-[180px] w-[160px] rounded-xl border border-white/[0.06] bg-[#111] overflow-hidden flex flex-col items-center justify-center gap-2">
      {/* 闪光扫描动画 */}
      <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/[0.03] to-transparent animate-[shimmer_2s_infinite]" style={{ backgroundSize: '200% 100%' }} />
      {/* 进度环 */}
      <div className="relative w-12 h-12">
        <svg className="w-12 h-12 -rotate-90" viewBox="0 0 48 48">
          <circle cx="24" cy="24" r="20" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="3" />
          <circle cx="24" cy="24" r="20" fill="none" stroke="url(#ipg)" strokeWidth="3" strokeLinecap="round"
            strokeDasharray={`${2 * Math.PI * 20}`}
            strokeDashoffset={`${2 * Math.PI * 20 * (1 - (progress || 0) / 100)}`}
            className="transition-all duration-700 ease-out" />
          <defs><linearGradient id="ipg" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stopColor="#ec4899" /><stop offset="100%" stopColor="#f43f5e" /></linearGradient></defs>
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          {progress > 0 ? (
            <span className="text-[11px] font-bold text-white tabular-nums">{progress}%</span>
          ) : (
            <Loader2 className="w-4 h-4 text-pink-400/60 animate-spin" />
          )}
        </div>
      </div>
      <span className="text-[10px] text-zinc-500 font-medium">#{index + 1} {progress > 0 ? '生成中' : '排队中'}</span>
      {/* 底部进度条 */}
      <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-white/[0.04]">
        <div className="h-full bg-gradient-to-r from-pink-500 to-rose-500 transition-all duration-700 ease-out" style={{ width: `${progress || 0}%` }} />
      </div>
    </div>
  );
}

/** 全屏预览浮层 */
function Lightbox({ url, onClose }: { url: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[100] bg-black/90 backdrop-blur-sm flex items-center justify-center p-8" onClick={onClose}>
      <button onClick={onClose} className="absolute top-4 right-4 p-2 text-zinc-400 hover:text-white"><X className="w-6 h-6" /></button>
      <img src={url} alt="预览" className="max-w-full max-h-full object-contain rounded-2xl shadow-2xl" onClick={(e) => e.stopPropagation()} />
      <a href={url} target="_blank" rel="noopener noreferrer" download onClick={(e) => e.stopPropagation()}
        className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-2 px-5 py-2.5 bg-white/10 hover:bg-white/20 backdrop-blur rounded-xl text-sm text-white transition-colors">
        <Download className="w-4 h-4" /> 下载原图
      </a>
    </div>
  );
}

export default function ImageGenPage() {
  const guard = useAuthGuard();
  const [models, setModels] = useState<ImageModel[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [aspectRatio, setAspectRatio] = useState('1:1');
  const [imageCount, setImageCount] = useState(1);
  const [isGenerating, setIsGenerating] = useState(false);
  const [progresses, setProgresses] = useState<number[]>([]);
  const [statusMessage, setStatusMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [generatedImages, setGeneratedImages] = useState<string[]>([]);
  const [history, setHistory] = useState<GeneratedImage[]>([]);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [referenceImages, setReferenceImages] = useState<string[]>([]);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchImageModels().then((m) => { setModels(m); if (m.length > 0 && !selectedModel) setSelectedModel(m[0].id); }).catch(() => {});
    // 加载历史生成记录
    contentApi.getMyContents({ type: 'image', page: 1, pageSize: 12 })
      .then((res: any) => {
        const items = res?.items || res?.data || [];
        const loadedHistory: GeneratedImage[] = [];
        const existingUrls = new Set<string>();
        
        for (const item of items) {
          const promptText = item.inputText || item.title || '';
          const model = item.model || '';
          const createdAt = new Date(item.createdAt);
          const aspectRatio = item.metadata?.aspectRatio || '';
          
          if (item.resultUrl && !existingUrls.has(item.resultUrl)) {
            existingUrls.add(item.resultUrl);
            loadedHistory.push({
              id: item.id + '_main',
              prompt: promptText,
              imageUrl: item.resultUrl,
              model,
              createdAt,
              aspectRatio,
            });
          }
          if (item.metadata?.imageUrls) {
            item.metadata.imageUrls.forEach((url: string, idx: number) => {
              if (url && !existingUrls.has(url)) {
                existingUrls.add(url);
                loadedHistory.push({
                  id: `${item.id}_${idx}`,
                  prompt: promptText,
                  imageUrl: url,
                  model,
                  createdAt,
                  aspectRatio,
                });
              }
            });
          }
        }
        if (loadedHistory.length > 0) {
          setHistory(loadedHistory);
        }
        setHistoryTotal(Number(res?.total) || 0);
      })
      .catch(() => {});
  }, []);

  const loadMoreHistory = async () => {
    const nextPage = historyPage + 1;
    setHistoryLoading(true);
    try {
      const res: any = await contentApi.getMyContents({ type: 'image', page: nextPage, pageSize: 12 });
      const items = res?.items || res?.data || [];
      const loaded: GeneratedImage[] = [];
      const urls = new Set(history.map(item => item.imageUrl));
      for (const item of items) {
        const metadata = typeof item.metadata === 'string' ? (() => { try { return JSON.parse(item.metadata); } catch { return {}; } })() : (item.metadata || {});
        const add = (url: string, suffix: string) => {
          if (!url || urls.has(url)) return;
          urls.add(url);
          loaded.push({ id: `${item.id}_${suffix}`, prompt: item.inputText || item.title || '', imageUrl: url, model: item.model || item.modelId || '', createdAt: new Date(item.createdAt), aspectRatio: metadata.aspectRatio || '' });
        };
        add(item.resultUrl, 'main');
        if (Array.isArray(metadata.imageUrls)) metadata.imageUrls.forEach((url: string, index: number) => add(url, String(index)));
      }
      setHistory(prev => [...prev, ...loaded]);
      setHistoryPage(nextPage);
      setHistoryTotal(Number(res?.total) || 0);
    } finally {
      setHistoryLoading(false);
    }
  };

  const readFileAsDataURL = (file: File): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result as string); reader.onerror = reject; reader.readAsDataURL(file);
  });

  const handleFileSelect = async (files: FileList | null) => {
    if (!files) return;
    const remaining = 10 - referenceImages.length;
    if (remaining <= 0) { setError('最多上传 10 张参考图'); return; }
    const validFiles = Array.from(files).filter(f => f.type.startsWith('image/')).slice(0, remaining);
    if (validFiles.length === 0) return;
    const oversized = validFiles.find(f => f.size > 20 * 1024 * 1024);
    if (oversized) { setError(`参考图 "${oversized.name}" 超过 20MB 上限`); return; }
    try { const urls = await Promise.all(validFiles.map(readFileAsDataURL)); setReferenceImages(prev => [...prev, ...urls]); }
    catch { setError('图片读取失败'); }
  };

  const removeRefImage = (index: number) => setReferenceImages(prev => prev.filter((_, i) => i !== index));

  // 全局拖拽 + Ctrl+V 粘贴上传参考图
  useImageDropPaste(handleFileSelect);

  // 记录本轮生成前已有的图片数量，用于追加偏移
  const baseIndexRef = useRef(0);

  const handleGenerate = useCallback(() => {
    if (!prompt.trim() || isGenerating) return;
    if (!guard()) return;
    const base = generatedImages.length;
    baseIndexRef.current = base;
    // 预分配 imageCount 个空槽位，确保 image_ready 可以按 index 精确填入
    setGeneratedImages(prev => [...prev, ...new Array(imageCount).fill('')]);
    setIsGenerating(true);
    setProgresses(new Array(imageCount).fill(0));
    setError(null);
    setStatusMessage(`正在生成 ${imageCount} 张图片...`);

    const ctrl = generateImage(
      { prompt: prompt.trim(), model: selectedModel, aspect_ratio: aspectRatio, n: imageCount, reference_images: referenceImages.length > 0 ? referenceImages : undefined },
      (event: ImageSSEEvent) => {
        switch (event.type) {
          case 'queue':
            setStatusMessage(`HM Studio 排队中：前方 ${Math.max(0, (event.position || 1) - 1)} 项，当前运行 ${event.running || 0}/${event.concurrencyLimit || 10}`);
            break;
          case 'status':
            setStatusMessage(event.message || '');
            break;
          case 'progress': {
            const idx = event.index ?? -1;
            if (idx >= 0) {
              setProgresses(prev => { const next = [...prev]; next[idx] = event.progress || 0; return next; });
            }
            break;
          }
          case 'image_ready':
            if (event.imageUrl) {
              const slotIdx = baseIndexRef.current + (event.index ?? 0);
              setGeneratedImages(prev => {
                const next = [...prev];
                next[slotIdx] = event.imageUrl!;
                return next;
              });
              setProgresses(prev => { const next = [...prev]; if (event.index !== undefined) next[event.index] = 100; return next; });
            }
            break;
          case 'image_error':
            setError(event.message || `图片 #${(event.index ?? 0) + 1} 生成失败`);
            // 移除失败的空槽位
            if (event.index !== undefined) {
              const failIdx = baseIndexRef.current + event.index;
              setGeneratedImages(prev => prev.filter((_, i) => i !== failIdx));
            }
            break;
          case 'complete':
            setIsGenerating(false);
            setStatusMessage('');
            // 清理剩余空槽位，追加历史
            setGeneratedImages(prev => prev.filter(Boolean));
            if (event.imageUrls && event.imageUrls.length > 0) {
              event.imageUrls.forEach(url => {
                setHistory(prev => [{ id: Date.now().toString() + Math.random(), prompt: prompt.trim(), imageUrl: url, model: selectedModel, createdAt: new Date(), aspectRatio }, ...prev]);
              });
            }
            break;
          case 'error':
            setError(event.message || '生成失败');
            setIsGenerating(false);
            setStatusMessage('');
            // 清理空槽位
            setGeneratedImages(prev => prev.filter(Boolean));
            break;
        }
      },
    );
    abortRef.current = ctrl;
  }, [prompt, selectedModel, aspectRatio, imageCount, isGenerating, referenceImages, generatedImages.length, guard]);

  const handleCancel = () => { abortRef.current?.abort(); setIsGenerating(false); setStatusMessage(''); };
  const handleKeyDown = (e: React.KeyboardEvent) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleGenerate(); } };

  // 当前本轮有多少空槽位（即尚未拿到图片的占位）
  // generatedImages 中从 baseIndexRef 开始的空字符串就是待填充的占位
  const currentBatchEmpty = isGenerating
    ? generatedImages.slice(baseIndexRef.current).filter(v => !v).length
    : 0;

  return (
    <div className="imagegen-page flex flex-col lg:flex-row min-h-full lg:h-full">
      {/* ===== 左栏 ===== */}
      <div className="w-full lg:w-[320px] shrink-0 h-fit lg:h-full lg:overflow-y-auto border-r border-white/5 bg-black [&::-webkit-scrollbar]:hidden" style={{ scrollbarWidth: 'none' }}>
        <div className="p-6 flex flex-col min-h-full">
          <h2 className="text-xl font-semibold text-white mb-6 flex items-center gap-3"><ImageIcon className="w-6 h-6 text-pink-400" /> 图片生成</h2>
          <div className="mb-6">
            <label className="block text-xs font-semibold text-zinc-400 mb-3 uppercase tracking-wider">选择模型</label>
            <div className="space-y-3">
              {models.map((model) => (
                <button key={model.id} onClick={() => setSelectedModel(model.id)}
                  className={`earth-image-model-card w-full text-left px-4 py-3 rounded-xl border transition-all ${selectedModel === model.id ? 'is-selected border-pink-500/50 bg-pink-500/10 shadow-lg shadow-pink-500/5' : 'border-white/5 bg-white/[0.02] hover:border-white/10 hover:bg-white/[0.04]'}`}>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium text-white">{model.name}</p>
                    <div className="flex items-center gap-2">
                      {model.rate !== undefined && (
                        <span className="text-[10px] bg-pink-500/10 text-pink-400 px-1.5 py-0.5 rounded border border-pink-500/20 font-medium">
                          ¥{model.rate.toFixed(2)}/张
                        </span>
                      )}
                      {selectedModel === model.id && <div className="w-5 h-5 rounded-full bg-pink-500 flex items-center justify-center shrink-0"><Check className="w-3 h-3 text-white" /></div>}
                    </div>
                  </div>
                  <p className="text-xs text-zinc-500 mt-1 leading-relaxed">{model.description}</p>
                  {model.rate !== undefined && (
                    <div className="mt-2 flex items-center gap-2 text-[10px] text-zinc-600 border-t border-white/5 pt-1.5">
                      <span>单价: <span className="text-zinc-400">¥{model.rate.toFixed(2)} / 张</span></span>
                    </div>
                  )}
                  {!model.available && <div className="mt-2 text-xs text-amber-500/80 flex items-center gap-1.5"><AlertCircle className="w-3.5 h-3.5" /> 未配置渠道</div>}
                </button>
              ))}
              <div className="p-4 rounded-xl border border-dashed border-white/5 opacity-40 mt-4">
                <p className="text-sm text-zinc-600 mb-1">更多模型</p><p className="text-xs text-zinc-700">即将支持...</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ===== 右栏 ===== */}
      <div className="flex-1 flex flex-col min-w-0 relative">
        {/* 图片预览区 - 保持原始比例 */}
        <div className="flex-1 overflow-y-auto p-6 pb-40 [&::-webkit-scrollbar]:hidden" style={{ scrollbarWidth: 'none' }}>
          {(generatedImages.length > 0 || isGenerating) ? (
            <>
              {/* 当前生成的图片 */}
              <div className="flex flex-wrap gap-3 items-start">
                {generatedImages.map((url, i) => url ? (
                  <div key={i} className="group relative rounded-xl overflow-hidden border border-white/5 hover:border-pink-500/40 transition-all cursor-pointer bg-black/30" onClick={() => setLightboxUrl(url)}>
                    <img src={url} alt={`生成图片 ${i + 1}`} className="block h-[180px] w-auto object-contain" loading="lazy" />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
                      <div className="absolute bottom-1.5 right-1.5 flex gap-1">
                        <button onClick={(e) => { e.stopPropagation(); setLightboxUrl(url); }} className="p-1 bg-black/50 backdrop-blur rounded-md text-white/80 hover:text-white"><Maximize2 className="w-3 h-3" /></button>
                        <a href={url} target="_blank" rel="noopener noreferrer" download onClick={(e) => e.stopPropagation()} className="p-1 bg-black/50 backdrop-blur rounded-md text-white/80 hover:text-white"><Download className="w-3 h-3" /></a>
                      </div>
                    </div>
                  </div>
                ) : null)}
                {/* 占位卡片 - 按后端 index 映射独立进度 */}
                {isGenerating && generatedImages.slice(baseIndexRef.current).map((url, i) => {
                  if (url) return null; // 已有图片，不显示占位
                  const backendIdx = i; // 和后端 event.index 一致
                  return <PlaceholderCard key={`p-${backendIdx}`} index={backendIdx} progress={progresses[backendIdx] || 0} />;
                })}
              </div>
              {/* 操作栏 */}
              {!isGenerating && generatedImages.length > 0 && (
                <div className="flex items-center justify-center gap-3 mt-4">
                  <button onClick={() => { setGeneratedImages([]); setPrompt(''); }} className="flex items-center gap-2 px-4 py-2 bg-white/5 hover:bg-white/10 rounded-xl text-xs text-zinc-300 transition-colors">
                    <RotateCcw className="w-3.5 h-3.5" /> 新建生成
                  </button>
                  <span className="text-[11px] text-zinc-600">共 {generatedImages.length} 张 · 点击放大</span>
                </div>
              )}
            </>
          ) : history.length > 0 ? (
            <>
              <p className="text-xs text-zinc-500 mb-3">历史生成记录 ({history.length})</p>
              <div className="flex flex-wrap gap-3 items-start">
                {history.map((h) => (
                  <div key={h.id} className="group relative rounded-xl overflow-hidden border border-white/5 hover:border-pink-500/40 transition-all cursor-pointer bg-black/30" onClick={() => setLightboxUrl(h.imageUrl)}>
                    <img src={h.imageUrl} alt="历史图片" className="block h-[180px] w-auto object-contain" loading="lazy" />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
                      <div className="absolute bottom-1.5 right-1.5 flex gap-1">
                        {h.prompt && (
                          <button onClick={(e) => { e.stopPropagation(); setPrompt(h.prompt); textareaRef.current?.focus(); }} className="p-1 bg-black/50 backdrop-blur rounded-md text-white/80 hover:text-white" title={`套用提示词: ${h.prompt}`}>
                            <RotateCcw className="w-3 h-3" />
                          </button>
                        )}
                        <button onClick={(e) => { e.stopPropagation(); setLightboxUrl(h.imageUrl); }} className="p-1 bg-black/50 backdrop-blur rounded-md text-white/80 hover:text-white"><Maximize2 className="w-3 h-3" /></button>
                        <button onClick={async (e) => {
                          e.stopPropagation();
                          if (window.confirm('确定要删除这条图片生成记录吗？')) {
                            try {
                              await contentApi.delete(h.id);
                              setHistory(prev => prev.filter(item => item.id !== h.id));
                            } catch (err) {
                              console.error('Failed to delete image history:', err);
                              alert('删除失败');
                            }
                          }
                        }} className="p-1 bg-black/50 backdrop-blur rounded-md text-white/80 hover:text-red-400" title="删除记录">
                          <Trash2 className="w-3 h-3" />
                        </button>
                        <a href={h.imageUrl} target="_blank" rel="noopener noreferrer" download onClick={(e) => e.stopPropagation()} className="p-1 bg-black/50 backdrop-blur rounded-md text-white/80 hover:text-white"><Download className="w-3 h-3" /></a>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              {historyPage * 12 < historyTotal && (
                <div className="mt-5 flex justify-center">
                  <button type="button" disabled={historyLoading} onClick={loadMoreHistory} className="rounded-xl border border-white/10 bg-white/5 px-5 py-2 text-xs text-zinc-300 transition-colors hover:bg-white/10 disabled:cursor-wait disabled:opacity-50">
                    {historyLoading ? '加载中…' : '加载更多'}
                  </button>
                </div>
              )}
            </>
          ) : (
            <div className="h-full flex items-center justify-center">
              <div className="text-center">
                <div className="w-20 h-20 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-pink-500/10 to-rose-500/10 border border-white/5 flex items-center justify-center">
                  <Sparkles className="w-8 h-8 text-pink-400/60" />
                </div>
                <p className="text-sm text-zinc-500 mb-1">输入描述，生成AI图片</p>
                <p className="text-[11px] text-zinc-700">支持多图生成 · 点击放大查看</p>
              </div>
            </div>
          )}

          {/* 生成中状态 */}
          {isGenerating && (
            <div className="text-center mt-4">
              <p className="text-sm text-zinc-400 mb-2">
                {statusMessage || `已完成 ${generatedImages.slice(baseIndexRef.current).filter(Boolean).length} / ${imageCount} 张`}
              </p>
              <button onClick={handleCancel} className="text-xs text-zinc-500 hover:text-red-400 transition-colors flex items-center gap-1.5 mx-auto">
                <Square className="w-3 h-3" /> 取消生成
              </button>
            </div>
          )}
        </div>

        {/* 错误提示 */}
        {error && (
          <div className="absolute bottom-[180px] left-4 right-4 z-10 px-4 py-2.5 bg-red-500/10 border border-red-500/20 rounded-xl text-sm text-red-400 flex items-center gap-2 backdrop-blur-sm">
            <AlertCircle className="w-4 h-4 shrink-0" /><span className="flex-1">{error}</span>
            <button onClick={() => setError(null)} className="text-red-500/60 hover:text-red-400 text-xs">✕</button>
          </div>
        )}

        {/* 悬浮输入区 */}
        <div className="absolute bottom-0 left-0 right-0 z-10">
          <div className="imagegen-composer bg-gradient-to-t from-[#0c0c0c] via-[#0c0c0c]/95 to-transparent pt-8 px-6 pb-5">
            <div className="max-w-5xl mx-auto">
              {/* 工具栏 */}
              <div className="flex items-center gap-2 mb-3 flex-wrap">
                <CustomSelect value={aspectRatio} onChange={setAspectRatio} options={ASPECT_RATIOS} prefix="比例: " />
                <CustomSelect value={imageCount} onChange={setImageCount} options={COUNT_OPTIONS} icon={Grid2x2} prefix="数量: " />
                <button onClick={() => fileInputRef.current?.click()} className="flex items-center gap-1.5 bg-white/[0.04] hover:bg-white/[0.08] rounded-lg px-2.5 py-1.5 text-[11px] text-zinc-300 transition-colors border border-white/5 hover:border-white/10">
                  <Upload className="w-3 h-3 text-pink-400" /> 参考图 ({referenceImages.length}/10)
                </button>
                <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => { handleFileSelect(e.target.files); e.target.value = ''; }} />
              </div>
              {/* 输入容器 */}
              <div className="relative bg-white/[0.04] border border-white/[0.08] focus-within:border-pink-500/30 rounded-2xl transition-all shadow-2xl shadow-black/30">
                {referenceImages.length > 0 && (
                  <>
                    <div className="flex items-center gap-2 px-4 pt-3 pb-1 overflow-x-auto [&::-webkit-scrollbar]:hidden" style={{ scrollbarWidth: 'none' }}>
                      {referenceImages.map((img, i) => (
                        <div key={i} className="relative w-12 h-12 rounded-lg overflow-hidden border border-white/10 group cursor-pointer shrink-0 hover:border-pink-500/30 transition-colors">
                          <img src={img} alt="" className="w-full h-full object-cover" />
                          {/* 序号标签 */}
                          <div className="absolute top-0 left-0 bg-pink-500/80 text-white text-[8px] font-bold px-1 py-0.5 rounded-br-md leading-none">图{i + 1}</div>
                          <button onClick={() => removeRefImage(i)}
                            className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"><X className="w-3.5 h-3.5 text-white" /></button>
                        </div>
                      ))}
                      {referenceImages.length < 10 && (
                        <button onClick={() => fileInputRef.current?.click()}
                          className="w-12 h-12 rounded-lg border border-dashed border-white/10 hover:border-pink-500/30 flex items-center justify-center text-zinc-600 hover:text-pink-400 transition-colors shrink-0">
                          <Upload className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                    {/* 使用提示 */}
                    <p className="px-4 pt-1 text-[10px] text-zinc-600">
                      💡 在提示词中用「图1」「图2」引用对应参考图，如：<span className="text-zinc-500">参考图1中的人物，穿上图2中的衣服</span>
                    </p>
                  </>
                )}
                <textarea ref={textareaRef} value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={handleKeyDown}
                  placeholder={referenceImages.length > 0
                    ? `在提示词中引用参考图，例如：\n• 参考图1中的人物站在海边，电影级画质\n• 把图1的人物放到图2的场景中`
                    : '描述你想生成的图片内容，例如：一只在太空漂浮的猫...'}
                  rows={3}
                  className="w-full bg-transparent px-4 py-3 pr-16 text-sm text-white focus:outline-none placeholder:text-zinc-600 resize-none [&::-webkit-scrollbar]:hidden" style={{ msOverflowStyle: 'none', scrollbarWidth: 'none' } as React.CSSProperties} />
                {/* 圆形发送按钮 */}
                <button onClick={isGenerating ? handleCancel : handleGenerate} disabled={!prompt.trim() && !isGenerating}
                  className={`absolute right-3 bottom-3 w-11 h-11 rounded-full flex items-center justify-center transition-all ${isGenerating ? 'bg-red-500/20 text-red-300 hover:bg-red-500/30 border border-red-500/20' : 'bg-gradient-to-r from-pink-600 to-rose-600 hover:from-pink-500 hover:to-rose-500 text-white shadow-lg shadow-pink-500/20 disabled:opacity-30 disabled:cursor-not-allowed'}`} aria-label={isGenerating ? '停止生成图片' : '开始生成图片'}>
                  {isGenerating ? <Square className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 全屏预览浮层 */}
      {lightboxUrl && <Lightbox url={lightboxUrl} onClose={() => setLightboxUrl(null)} />}
    </div>
  );
}

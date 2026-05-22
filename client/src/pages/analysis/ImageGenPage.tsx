import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Image as ImageIcon, Play, Square, Download, RotateCcw, Loader2, Check, AlertCircle, Sparkles, Monitor, Smartphone, RectangleHorizontal, Upload, X, Grid2x2, Maximize2 } from 'lucide-react';
import { fetchImageModels, generateImage, type ImageModel, type ImageSSEEvent } from '../../api/imageGen';
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
      <img src={url} alt={`生成图片 ${index + 1}`} className="w-full block" loading="lazy" />
      <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
        <div className="absolute bottom-2 right-2 flex gap-1.5">
          <button onClick={(e) => { e.stopPropagation(); onPreview(); }} className="p-1.5 bg-black/50 backdrop-blur rounded-lg text-white/80 hover:text-white"><Maximize2 className="w-3.5 h-3.5" /></button>
          <a href={url} target="_blank" rel="noopener noreferrer" download onClick={(e) => e.stopPropagation()} className="p-1.5 bg-black/50 backdrop-blur rounded-lg text-white/80 hover:text-white"><Download className="w-3.5 h-3.5" /></a>
        </div>
      </div>
    </div>
  );
}

/** 生成中的占位卡片 */
function PlaceholderCard({ index, progress }: { index: number; progress: number }) {
  return (
    <div className="rounded-xl border border-white/5 bg-white/[0.02] aspect-square flex flex-col items-center justify-center gap-2">
      <Loader2 className="w-6 h-6 text-pink-400/60 animate-spin" />
      <span className="text-[11px] text-zinc-500">#{index + 1} {progress > 0 ? `${progress}%` : '等待中...'}</span>
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
  const [referenceImages, setReferenceImages] = useState<string[]>([]);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchImageModels().then((m) => { setModels(m); if (m.length > 0 && !selectedModel) setSelectedModel(m[0].id); }).catch(() => {});
  }, []);

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

  const handleGenerate = useCallback(() => {
    if (!prompt.trim() || isGenerating) return;
    if (!guard()) return;
    setIsGenerating(true);
    setProgresses(new Array(imageCount).fill(0));
    setError(null);
    setGeneratedImages([]);
    setStatusMessage(`正在生成 ${imageCount} 张图片...`);

    const ctrl = generateImage(
      { prompt: prompt.trim(), model: selectedModel, aspect_ratio: aspectRatio, n: imageCount, reference_images: referenceImages.length > 0 ? referenceImages : undefined },
      (event: ImageSSEEvent) => {
        switch (event.type) {
          case 'status':
            setStatusMessage(event.message || '');
            break;
          case 'progress': {
            const idx = event.index ?? -1;
            if (idx >= 0) {
              setProgresses(prev => { const next = [...prev]; next[idx] = event.progress || 0; return next; });
            }
            setStatusMessage(`生成中... ${event.progress || 0}%`);
            break;
          }
          case 'image_ready':
            if (event.imageUrl) {
              setGeneratedImages(prev => {
                const next = [...prev];
                const idx = event.index ?? next.length;
                next[idx] = event.imageUrl!;
                return next;
              });
              setProgresses(prev => { const next = [...prev]; if (event.index !== undefined) next[event.index] = 100; return next; });
            }
            break;
          case 'image_error':
            setError(event.message || `图片 #${(event.index ?? 0) + 1} 生成失败`);
            break;
          case 'complete':
            setIsGenerating(false);
            setStatusMessage('');
            if (event.imageUrls && event.imageUrls.length > 0) {
              setGeneratedImages(event.imageUrls);
              event.imageUrls.forEach(url => {
                setHistory(prev => [{ id: Date.now().toString() + Math.random(), prompt: prompt.trim(), imageUrl: url, model: selectedModel, createdAt: new Date(), aspectRatio }, ...prev]);
              });
            }
            break;
          case 'error':
            setError(event.message || '生成失败');
            setIsGenerating(false);
            setStatusMessage('');
            break;
        }
      },
    );
    abortRef.current = ctrl;
  }, [prompt, selectedModel, aspectRatio, imageCount, isGenerating, referenceImages]);

  const handleCancel = () => { abortRef.current?.abort(); setIsGenerating(false); setStatusMessage(''); };
  const handleKeyDown = (e: React.KeyboardEvent) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleGenerate(); } };

  // 计算瀑布流列数
  const colCount = generatedImages.length >= 4 ? 2 : generatedImages.length >= 2 ? 2 : 1;
  const pendingSlots = isGenerating ? imageCount - generatedImages.filter(Boolean).length : 0;

  return (
    <div className="flex h-full">
      {/* ===== 左栏 ===== */}
      <div className="w-full lg:w-[320px] shrink-0 h-fit lg:h-full lg:overflow-y-auto border-r border-white/5 bg-black [&::-webkit-scrollbar]:hidden" style={{ scrollbarWidth: 'none' }}>
        <div className="p-6 flex flex-col min-h-full">
          <h2 className="text-xl font-semibold text-white mb-6 flex items-center gap-3"><ImageIcon className="w-6 h-6 text-pink-400" /> 图片生成</h2>
          <div className="mb-6">
            <label className="block text-xs font-semibold text-zinc-400 mb-3 uppercase tracking-wider">选择模型</label>
            <div className="space-y-3">
              {models.map((model) => (
                <button key={model.id} onClick={() => setSelectedModel(model.id)}
                  className={`w-full text-left px-4 py-3 rounded-xl border transition-all ${selectedModel === model.id ? 'border-pink-500/50 bg-pink-500/10 shadow-lg shadow-pink-500/5' : 'border-white/5 bg-white/[0.02] hover:border-white/10 hover:bg-white/[0.04]'}`}>
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium text-white">{model.name}</p>
                    {selectedModel === model.id && <div className="w-5 h-5 rounded-full bg-pink-500 flex items-center justify-center shrink-0 ml-2"><Check className="w-3 h-3 text-white" /></div>}
                  </div>
                  <p className="text-xs text-zinc-500 mt-1 leading-relaxed">{model.description}</p>
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
      <div className="flex-1 flex flex-col min-w-0">
        {/* 瀑布流预览区 */}
        <div className="flex-1 overflow-y-auto p-6">
          {(generatedImages.length > 0 || isGenerating) ? (
            <div className={`columns-${colCount} gap-4 max-w-3xl mx-auto`} style={{ columnCount: colCount }}>
              {generatedImages.map((url, i) => url ? (
                <div key={i} className="mb-4 break-inside-avoid"><ImageCard url={url} index={i} onPreview={() => setLightboxUrl(url)} /></div>
              ) : null)}
              {/* 占位卡片 */}
              {Array.from({ length: pendingSlots }).map((_, i) => (
                <div key={`p-${i}`} className="mb-4 break-inside-avoid"><PlaceholderCard index={generatedImages.filter(Boolean).length + i} progress={progresses[generatedImages.filter(Boolean).length + i] || 0} /></div>
              ))}
            </div>
          ) : (
            <div className="h-full flex items-center justify-center">
              <div className="text-center">
                <div className="w-20 h-20 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-pink-500/10 to-rose-500/10 border border-white/5 flex items-center justify-center">
                  <Sparkles className="w-8 h-8 text-pink-400/60" />
                </div>
                <p className="text-sm text-zinc-500 mb-1">输入描述，生成AI图片</p>
                <p className="text-[11px] text-zinc-700">支持多图生成 · 瀑布流展示</p>
              </div>
            </div>
          )}

          {/* 生成完成后的操作栏 */}
          {!isGenerating && generatedImages.length > 0 && (
            <div className="flex items-center justify-center gap-3 mt-4 max-w-3xl mx-auto">
              <button onClick={() => { setGeneratedImages([]); setPrompt(''); }} className="flex items-center gap-2 px-4 py-2 bg-white/5 hover:bg-white/10 rounded-xl text-xs text-zinc-300 transition-colors">
                <RotateCcw className="w-3.5 h-3.5" /> 新建生成
              </button>
              {generatedImages.length > 1 && (
                <span className="text-[11px] text-zinc-600">共 {generatedImages.length} 张 · 点击图片放大</span>
              )}
            </div>
          )}

          {/* 生成中状态 */}
          {isGenerating && (
            <div className="text-center mt-4">
              <p className="text-sm text-zinc-400 mb-2">{statusMessage}</p>
              <button onClick={handleCancel} className="text-xs text-zinc-500 hover:text-red-400 transition-colors flex items-center gap-1.5 mx-auto">
                <Square className="w-3 h-3" /> 取消生成
              </button>
            </div>
          )}
        </div>

        {/* 错误提示 */}
        {error && (
          <div className="mx-4 mb-2 px-4 py-2.5 bg-red-500/10 border border-red-500/20 rounded-xl text-sm text-red-400 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" /><span className="flex-1">{error}</span>
            <button onClick={() => setError(null)} className="text-red-500/60 hover:text-red-400 text-xs">✕</button>
          </div>
        )}

        {/* 底部输入区 */}
        <div className="shrink-0 border-t border-white/5 bg-black/40 backdrop-blur-sm p-4">
          <div className="mb-3">
            <div className="flex items-center gap-3 mb-2 flex-wrap">
              <CustomSelect value={aspectRatio} onChange={setAspectRatio} options={ASPECT_RATIOS} prefix="比例: " />
              <CustomSelect value={imageCount} onChange={setImageCount} options={COUNT_OPTIONS} icon={Grid2x2} prefix="数量: " />
              {referenceImages.length < 10 && (
                <button onClick={() => fileInputRef.current?.click()} className="flex items-center gap-1.5 bg-white/[0.03] hover:bg-white/[0.06] rounded-lg px-3 py-2 text-[11px] text-zinc-300 transition-colors border border-transparent hover:border-pink-500/20">
                  <Upload className="w-3.5 h-3.5 text-pink-400" /> 参考图 ({referenceImages.length}/10)
                </button>
              )}
              <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => { handleFileSelect(e.target.files); e.target.value = ''; }} />
            </div>

            {referenceImages.length > 0 && (
              <div className="flex gap-2 mb-2 flex-wrap">
                {referenceImages.map((img, i) => (
                  <div key={i} className="relative group w-14 h-14 rounded-lg overflow-hidden border border-white/10 hover:border-pink-500/30 transition-colors">
                    <img src={img} alt={`ref-${i}`} className="w-full h-full object-cover" />
                    <button onClick={() => removeRefImage(i)} className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity"><X className="w-4 h-4 text-red-400" /></button>
                  </div>
                ))}
                {referenceImages.length < 10 && (
                  <button onClick={() => fileInputRef.current?.click()}
                    className="w-14 h-14 rounded-lg border border-dashed border-white/10 hover:border-pink-500/30 flex items-center justify-center text-zinc-600 hover:text-pink-400 transition-colors">
                    <Upload className="w-4 h-4" />
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="flex gap-3 items-end">
            <div className="flex-1 relative">
              <textarea ref={textareaRef} value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={handleKeyDown}
                placeholder={referenceImages.length > 0 ? '描述你想基于参考图生成的内容...' : '描述你想生成的图片内容，例如：一只在太空漂浮的猫...'}
                rows={2} className="w-full bg-white/[0.03] border border-white/5 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:ring-1 focus:ring-pink-500/30 focus:border-pink-500/30 placeholder:text-zinc-600 resize-none" />
            </div>
            <button onClick={isGenerating ? handleCancel : handleGenerate} disabled={!prompt.trim() && !isGenerating}
              className={`shrink-0 h-[52px] px-6 rounded-xl font-medium text-sm flex items-center gap-2 transition-all ${isGenerating ? 'bg-red-500/20 text-red-300 hover:bg-red-500/30' : 'bg-gradient-to-r from-pink-600 to-rose-600 hover:from-pink-500 hover:to-rose-500 text-white disabled:opacity-40 disabled:cursor-not-allowed'}`}>
              {isGenerating ? <><Loader2 className="w-4 h-4 animate-spin" /> 停止</> : <><Play className="w-4 h-4" /> 生成</>}
            </button>
          </div>
        </div>
      </div>

      {/* 全屏预览浮层 */}
      {lightboxUrl && <Lightbox url={lightboxUrl} onClose={() => setLightboxUrl(null)} />}
    </div>
  );
}

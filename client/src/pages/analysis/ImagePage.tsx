import { generationProblemSummary } from '../../../../shared/generationMessages';
import React, { useState, useRef, useEffect } from 'react';
import type { ImageAnalysisJob } from '../../../../shared/imageAnalysis';
import { useAuthStore } from '../../stores/authStore';
import { api } from '../../api/client';
import { Image as ImageIcon, UploadCloud, RefreshCw, Wand2, X, Tag, Palette } from 'lucide-react';
import { analysisApi } from '../../api/analysis';
import { PromptDisplay, ResultSection, TagList, LoadingOverlay } from '../../components/UIComponents';
import ModelSelector from '../../components/ModelSelector';
import { useAuthGuard } from '../../hooks/useAuthGuard';
import { isSupportedImageFile, MOBILE_IMAGE_ACCEPT, normalizeImageFile } from '../../utils/imageNormalization';

type ImageImport = { images: string[]; audioUrl?: string; audioTitle?: string };

export default function ImagePage() {
  const guard = useAuthGuard();
  const userId = useAuthStore(state => state.user?.id);
  const [urlInput, setUrlInput] = useState('');
  const [requiresText, setRequiresText] = useState(false);
  const [selectedModel, setSelectedModel] = useState('');
  const [sources, setSources] = useState<{ url: string; file?: File }[]>([]);
  const [selectedImage, setSelectedImage] = useState(0);
  const [job, setJob] = useState<ImageAnalysisJob | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [isFetchingUrl, setIsFetchingUrl] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState('');
  const [audioTitle, setAudioTitle] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const operation = useRef(0);
  const submittingRef = useRef(false);
  const ownedUrls = useRef<string[]>([]);
  const selectedItem = job?.items[selectedImage];
  const result = selectedItem?.result;
  const isAnalyzing = submitting || (!!jobId && !job) || !!job?.items.some(item => item.status === 'queued' || item.status === 'running');
  const previewUrl = sources[0]?.url;
  const statusLabels = { queued: '等待中', running: '分析中', completed: '已完成', error: '失败', interrupted: '结果待核实' };
  const storageKey = userId ? 'image-analysis-job:' + userId : null;
  const clearUrls = () => { ownedUrls.current.forEach(url => URL.revokeObjectURL(url)); ownedUrls.current = []; };
  const blobUrl = (blob: Blob) => { const url = URL.createObjectURL(blob); ownedUrls.current.push(url); return url; };

  useEffect(() => {
    operation.current++; clearUrls(); setSources([]); setJob(null); setSelectedImage(0); setError(null);
    setAudioUrl(''); setAudioTitle('');
    setJobId(storageKey ? localStorage.getItem(storageKey) : null);
    return () => { operation.current++; clearUrls(); };
  }, [storageKey]);

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api.get<ImageAnalysisJob>('/analysis/image-jobs/' + jobId);
        if (cancelled) return;
        setJob(next); setError(null);
        if (next.items.some(item => item.status === 'queued' || item.status === 'running')) timer = setTimeout(poll, 1500);
      } catch (e: any) {
        if (cancelled) return;
        setError(e.message);
        // Submission may have reached the server even if its response was lost. Only query it.
        timer = setTimeout(poll, 3000);
      }
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [jobId]);

  useEffect(() => {
    if (!job || sources.length) return;
    let cancelled = false;
    void Promise.all(job.items.map(async item => {
      try {
        const blob = await api.get<Blob>('/analysis/image-jobs/' + job.id + '/images/' + item.index, { responseType: 'blob' });
        return cancelled ? { url: '' } : { url: blobUrl(blob) };
      } catch { return { url: '' }; }
    })).then(items => { if (!cancelled) setSources(items); });
    return () => { cancelled = true; };
  }, [job?.id, sources.length]);

  const reset = () => {
    operation.current++; clearUrls(); setSources([]); setJob(null); setJobId(null); setSelectedImage(0);
    setIsFetchingUrl(false); setError(null); setAudioUrl(''); setAudioTitle('');
    if (storageKey) localStorage.removeItem(storageKey);
  };
  const handleFile = async (file: File) => {
    reset(); const current = operation.current; setIsFetchingUrl(true);
    try {
      const normalized = await normalizeImageFile(file, { maxDimension: 2048, quality: 0.9, outputType: 'image/jpeg', maxInputBytes: 10 * 1024 * 1024 });
      if (current === operation.current) setSources([{ url: blobUrl(normalized.blob), file: normalized.file }]);
    } catch (e: any) { if (current === operation.current) setError(e.message); }
    finally { if (current === operation.current) setIsFetchingUrl(false); }
  };
  const handleUrlImport = async () => {
    if (!urlInput.trim() || isFetchingUrl || isAnalyzing || !guard()) return;
    reset(); const current = operation.current; setIsFetchingUrl(true);
    try {
      const imported = await api.post<ImageImport>('/proxy/image', { url: urlInput.trim(), mode: 'list' }, { timeoutMs: 30000 });
      if (current !== operation.current) return;
      if (!Array.isArray(imported.images) || !imported.images.length) throw new Error('链接没有返回图片');
      setSources(imported.images.map(url => ({ url })));
      setAudioUrl(imported.audioUrl || ''); setAudioTitle(imported.audioTitle || '');
    } catch (e: any) { if (current === operation.current) setError(e.message); }
    finally { if (current === operation.current) setIsFetchingUrl(false); }
  };
  const handleAnalyze = async () => {
    if (!sources.length || isFetchingUrl || submittingRef.current || jobId || !guard()) return;
    if (!selectedModel) { setError('请先选择可用的分析模型'); return; }
    if (sources.length > 100) { setError('一次最多分析 100 张图片，请先移除多余图片'); return; }
    submittingRef.current = true; setSubmitting(true); setError(null);
    const current = operation.current;
    let id: string | null = null;
    try {
      const form = new FormData();
      for (let index = 0; index < sources.length; index++) {
        let file = sources[index].file;
        if (!file) {
          const blob = await api.post<Blob>('/proxy/image', { url: sources[index].url }, { responseType: 'blob', timeoutMs: 30000 });
          file = (await normalizeImageFile(new File([blob], 'image-' + (index + 1) + '.jpg', { type: blob.type }), {
            maxDimension: 2048, quality: 0.9, outputType: 'image/jpeg', maxInputBytes: 10 * 1024 * 1024,
          })).file;
        }
        if (current !== operation.current) return;
        form.append('files', file);
      }
      id = crypto.randomUUID();
      form.append('requestId', id); form.append('modelId', selectedModel); form.append('imageRequiresText', String(requiresText));
      if (storageKey) localStorage.setItem(storageKey, id);
      const next = await api.post<ImageAnalysisJob>('/analysis/image-jobs', form);
      if (current !== operation.current) return;
      setJob(next); setJobId(id);
    } catch (e: any) {
      if (current !== operation.current) return;
      setError(e.message);
      if (id && (!e.status || e.status >= 500)) setJobId(id);
      else if (storageKey) localStorage.removeItem(storageKey);
    } finally { submittingRef.current = false; if (current === operation.current) setSubmitting(false); }
  };

  return (
    <div className="flex flex-col lg:flex-row h-full">
      <div className="w-full lg:w-[380px] shrink-0 h-fit lg:h-full lg:overflow-y-auto border-r border-white/5 bg-black [&::-webkit-scrollbar]:hidden" style={{ scrollbarWidth: 'none' }}>
        <div className="p-6 flex flex-col min-h-full">
          <h2 className="text-xl font-semibold text-white mb-6 flex items-center gap-3">
            <ImageIcon className="w-6 h-6 text-zinc-300" /> 开始图片逆向分析
          </h2>

          <div className="mb-4">
            <label className="block text-xs font-semibold text-zinc-400 mb-2 uppercase tracking-wider">图片链接导入</label>
            <div className="flex gap-2">
              <input type="text" value={urlInput} onChange={e => setUrlInput(e.target.value)} placeholder="粘贴 TikTok 图文链接或图片直链" className="flex-1 bg-white/[0.03] border-none rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:ring-1 focus:ring-white/20 placeholder:text-zinc-600" />
              <button onClick={handleUrlImport} disabled={isFetchingUrl || isAnalyzing || !urlInput.trim()} className="px-4 py-2 bg-white/5 hover:bg-white/10 rounded-xl text-xs font-medium transition-colors disabled:opacity-50">
                {isFetchingUrl ? <RefreshCw className="w-4 h-4 animate-spin" /> : '导入'}
              </button>
            </div>
          </div>

          {sources.length > 0 && <p className="text-xs text-zinc-400 mb-3">共 {sources.length} 张图片，开始后逐张分析 · 每张占用 1 次分析额度</p>}
          {isFetchingUrl && <p role="status" className="text-xs text-zinc-400 mb-3">正在加载图片…</p>}
          <input disabled={isAnalyzing || isFetchingUrl} ref={fileRef} type="file" accept={MOBILE_IMAGE_ACCEPT} className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) void handleFile(f); e.target.value = ''; }} />
          <div className="mb-4 border border-dashed border-white/10 rounded-2xl overflow-hidden h-[220px] hover:border-pink-500/30 cursor-pointer flex items-center justify-center"
            onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (!isAnalyzing && !isFetchingUrl && f && isSupportedImageFile(f)) void handleFile(f); }}
            onClick={() => !isAnalyzing && !isFetchingUrl && !previewUrl && fileRef.current?.click()}>
            {previewUrl ? (
              <div className="relative w-full h-full">
                <img src={previewUrl} className="w-full h-full object-contain bg-black" />
                <button disabled={isAnalyzing} onClick={e => { e.stopPropagation(); reset(); }} className="absolute top-2 right-2 bg-red-500/80 p-1.5 rounded-full"><X className="w-3 h-3" /></button>
              </div>
            ) : (
              <div className="text-center"><UploadCloud className="w-8 h-8 text-zinc-600 mx-auto mb-2" /><p className="text-xs text-zinc-500">拖拽或点击上传图片</p><p className="text-[10px] text-zinc-600 mt-1">支持 JPG/PNG/WebP/HEIC/HEIF，最大10MB</p></div>
            )}
          </div>

          {audioUrl && (
            <div className="mb-4 bg-white/[0.02] rounded-xl p-3">
              <p className="text-xs text-zinc-400 mb-2">{audioTitle || '提取的原始音频'}</p>
              <audio src={audioUrl} controls className="w-full h-8" />
            </div>
          )}

          <div className="mb-6 flex items-center gap-3">
            <button disabled={isAnalyzing} onClick={() => setRequiresText(!requiresText)} className="relative w-11 h-11 rounded-full transition-colors" role="switch" aria-checked={requiresText} aria-label="分析画面文字">
              <span className={`absolute inset-x-0 top-2.5 h-6 rounded-full transition-colors ${requiresText ? 'bg-pink-500' : 'bg-white/10'}`} aria-hidden="true" />
              <div className={`absolute top-3 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${requiresText ? 'translate-x-5' : ''}`} />
            </button>
            <span className="text-xs text-zinc-400">保留文字排版</span>
          </div>

          <fieldset disabled={isAnalyzing}><ModelSelector value={selectedModel} onChange={setSelectedModel} /></fieldset>

          {error && <div className="mb-4 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 text-sm text-red-400">{generationProblemSummary(error)}</div>}

          <div className="flex gap-3 mt-auto">
            <button onClick={handleAnalyze} disabled={!sources.length || !!jobId || isAnalyzing || isFetchingUrl} className="flex-1 bg-gradient-to-r from-pink-600 to-rose-600 hover:from-pink-500 hover:to-rose-500 text-white font-medium py-3 rounded-xl transition-all disabled:opacity-50 flex items-center justify-center gap-2">
              {isAnalyzing ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
              {submitting ? '正在准备图片…' : isAnalyzing ? 'AI 分析中...' : jobId ? '本次分析已提交' : '开始逆向'}
            </button>
            <button disabled={isAnalyzing} onClick={reset} className="px-4 py-3 bg-white/5 hover:bg-white/10 rounded-xl text-sm transition-colors">重置</button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6 [&::-webkit-scrollbar]:hidden" style={{ scrollbarWidth: 'none' }}>
        {sources.length > 0 && (
          <div className="max-w-4xl mx-auto mb-6">
            <p className="text-sm text-zinc-400 mb-3" aria-live="polite">共 {sources.length} 张 · 已完成 {job?.items.filter(item => item.status === 'completed').length || 0} 张</p>
            <div className="flex gap-3 overflow-x-auto pb-3" aria-label="图片分析结果切换">
              {sources.map((source, index) => (
                <button type="button" key={index} aria-label={`查看第 ${index + 1} 张结果`} aria-pressed={selectedImage === index}
                  onClick={() => setSelectedImage(index)} className={`shrink-0 w-24 rounded-xl overflow-hidden border-2 ${selectedImage === index ? 'border-pink-500' : 'border-white/10'}`}>
                  <img src={source.url || undefined} alt={`第 ${index + 1} 张预览`} referrerPolicy="no-referrer" className="w-full h-20 object-cover" />
                  <span className="block text-xs py-2">图 {index + 1} · {job?.items[index] ? statusLabels[job.items[index].status] : '待分析'}</span>
                </button>
              ))}
            </div>
            <img src={sources[selectedImage]?.url || undefined} alt={`第 ${selectedImage + 1} 张原图`} referrerPolicy="no-referrer" className="max-h-72 max-w-full mx-auto object-contain rounded-xl mt-3" />
            {!jobId && !isAnalyzing && <button type="button" className="block mx-auto mt-3 text-xs text-zinc-400 hover:text-red-400"
              onClick={() => { setSources(items => items.filter((_, index) => index !== selectedImage)); setSelectedImage(index => Math.max(0, Math.min(index, sources.length - 2))); }}>移除这张图片</button>}
          </div>
        )}
        {selectedItem?.error && <p role="alert" className="max-w-4xl mx-auto text-sm text-red-400 mb-4">{selectedItem.error}</p>}
        {selectedItem?.status === 'running' ? <LoadingOverlay /> : result ? (
          <div className="max-w-4xl mx-auto space-y-6">
            <ResultSection icon={<ImageIcon className="w-5 h-5 text-pink-400" />} title="画面精准解析">
              <p className="text-sm text-zinc-300 whitespace-pre-wrap leading-relaxed">{result.overallConcept}</p>
              {result.aspectRatio && (
                <div className="mt-3 flex items-center gap-2">
                  <span className="text-[10px] uppercase tracking-wider text-zinc-500">建议宽高比</span>
                  <span className="px-2.5 py-1 bg-pink-500/10 border border-pink-500/20 rounded-lg text-xs font-mono text-pink-300">{result.aspectRatio}</span>
                </div>
              )}
            </ResultSection>
            <PromptDisplay title="逆向图片生成提示词（通用）" english={result.reversePrompt} chinese={result.reversePromptTranslation} />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <ResultSection icon={<Tag className="w-4 h-4 text-blue-400" />} title="核心元素"><TagList items={result.keywords} /></ResultSection>
              <ResultSection icon={<Palette className="w-4 h-4 text-purple-400" />} title="风格标签"><TagList items={result.styleTags} /></ResultSection>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center h-full"><p className="text-zinc-600 text-sm">{selectedItem?.status === 'queued' ? '这张图片正在等待分析' : selectedItem?.status === 'error' || selectedItem?.status === 'interrupted' ? '这张图片暂无可展示的分析结果，其他图片不受影响' : '导入或上传图片后点击“开始逆向”'}</p></div>
        )}
      </div>
    </div>
  );
}

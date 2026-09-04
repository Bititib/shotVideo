import React, { useState, useRef } from 'react';
import { Image as ImageIcon, UploadCloud, RefreshCw, Wand2, X, Tag, Palette } from 'lucide-react';
import { analysisApi } from '../../api/analysis';
import { PromptDisplay, ResultSection, TagList, LoadingOverlay } from '../../components/UIComponents';
import ModelSelector from '../../components/ModelSelector';
import { useAuthGuard } from '../../hooks/useAuthGuard';
import { isSupportedImageFile, MOBILE_IMAGE_ACCEPT, normalizeImageFile } from '../../utils/imageNormalization';

export default function ImagePage() {
  const guard = useAuthGuard();
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [urlInput, setUrlInput] = useState('');
  const [requiresText, setRequiresText] = useState(false);
  const [isFetchingUrl, setIsFetchingUrl] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState('');
  const [audioTitle, setAudioTitle] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = async (f: File) => {
    try {
      const normalized = await normalizeImageFile(f, {
        maxDimension: 2048,
        quality: 0.9,
        outputType: 'image/jpeg',
        maxInputBytes: 10 * 1024 * 1024,
      });
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setFile(normalized.file);
      setPreviewUrl(URL.createObjectURL(normalized.blob));
      setError(null);
      setAudioUrl('');
      setAudioTitle('');
    } catch (error: any) {
      setError(error?.message || '图片读取失败');
    }
  };

  const handleUrlImport = async () => {
    if (!urlInput.trim()) return;
    if (!guard()) return;
    setIsFetchingUrl(true); setError(null);
    try {
      const res = await fetch('/api/proxy/image', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` }, body: JSON.stringify({ url: urlInput }) });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || '导入失败'); }
      const audio = res.headers.get('X-Audio-Url');
      const aTitle = res.headers.get('X-Audio-Title');
      if (audio) setAudioUrl(decodeURIComponent(audio));
      if (aTitle) setAudioTitle(decodeURIComponent(aTitle));
      const blob = await res.blob();
      const f = new File([blob], 'imported_image.jpg', { type: blob.type || 'image/jpeg' });
      await handleFile(f);
      if (audio) setAudioUrl(decodeURIComponent(audio));
    } catch (e: any) { setError(e.message); } finally { setIsFetchingUrl(false); }
  };

  const handleAnalyze = async () => {
    if (!file) return;
    if (!guard()) return;
    setIsAnalyzing(true); setError(null); setResult(null);
    try { setResult(await analysisApi.analyzeImage(file, requiresText, selectedModel || undefined)); } catch (e: any) { setError(e.message); } finally { setIsAnalyzing(false); }
  };

  const reset = () => { if (previewUrl) URL.revokeObjectURL(previewUrl); setFile(null); setPreviewUrl(null); setResult(null); setError(null); setAudioUrl(''); setAudioTitle(''); };

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
              <button onClick={handleUrlImport} disabled={isFetchingUrl || !urlInput.trim()} className="px-4 py-2 bg-white/5 hover:bg-white/10 rounded-xl text-xs font-medium transition-colors disabled:opacity-50">
                {isFetchingUrl ? <RefreshCw className="w-4 h-4 animate-spin" /> : '导入'}
              </button>
            </div>
          </div>

          <input ref={fileRef} type="file" accept={MOBILE_IMAGE_ACCEPT} className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) void handleFile(f); e.target.value = ''; }} />
          <div className="mb-4 border border-dashed border-white/10 rounded-2xl overflow-hidden h-[220px] hover:border-pink-500/30 cursor-pointer flex items-center justify-center"
            onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f && isSupportedImageFile(f)) void handleFile(f); }}
            onClick={() => !previewUrl && fileRef.current?.click()}>
            {previewUrl ? (
              <div className="relative w-full h-full">
                <img src={previewUrl} className="w-full h-full object-contain bg-black" />
                <button onClick={e => { e.stopPropagation(); reset(); }} className="absolute top-2 right-2 bg-red-500/80 p-1.5 rounded-full"><X className="w-3 h-3" /></button>
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
            <button onClick={() => setRequiresText(!requiresText)} className="relative w-11 h-11 rounded-full transition-colors" role="switch" aria-checked={requiresText} aria-label="分析画面文字">
              <span className={`absolute inset-x-0 top-2.5 h-6 rounded-full transition-colors ${requiresText ? 'bg-pink-500' : 'bg-white/10'}`} aria-hidden="true" />
              <div className={`absolute top-3 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${requiresText ? 'translate-x-5' : ''}`} />
            </button>
            <span className="text-xs text-zinc-400">保留文字排版</span>
          </div>

          <ModelSelector value={selectedModel} onChange={setSelectedModel} />

          {error && <div className="mb-4 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 text-sm text-red-400">{error}</div>}

          <div className="flex gap-3 mt-auto">
            <button onClick={handleAnalyze} disabled={!file || isAnalyzing} className="flex-1 bg-gradient-to-r from-pink-600 to-rose-600 hover:from-pink-500 hover:to-rose-500 text-white font-medium py-3 rounded-xl transition-all disabled:opacity-50 flex items-center justify-center gap-2">
              {isAnalyzing ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
              {isAnalyzing ? 'AI 分析中...' : '开始逆向'}
            </button>
            <button onClick={reset} className="px-4 py-3 bg-white/5 hover:bg-white/10 rounded-xl text-sm transition-colors">重置</button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6 [&::-webkit-scrollbar]:hidden" style={{ scrollbarWidth: 'none' }}>
        {isAnalyzing ? <LoadingOverlay /> : result ? (
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
          <div className="flex-1 flex items-center justify-center h-full"><p className="text-zinc-600 text-sm">上传图片后点击"开始逆向"</p></div>
        )}
      </div>
    </div>
  );
}

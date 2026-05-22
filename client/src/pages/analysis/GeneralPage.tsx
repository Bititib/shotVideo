import React, { useState, useRef } from 'react';
import { PlaySquare, UploadCloud, RefreshCw, FileText, Tag, MessageCircle, Music, Wand2, X } from 'lucide-react';
import { analysisApi } from '../../api/analysis';
import { PromptDisplay, ResultSection, CopyButton, TagList, LoadingOverlay } from '../../components/UIComponents';
import ModelSelector from '../../components/ModelSelector';
import { useAuthGuard } from '../../hooks/useAuthGuard';

export default function GeneralPage() {
  const guard = useAuthGuard();
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [urlInput, setUrlInput] = useState('');
  const [isFetchingUrl, setIsFetchingUrl] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = (f: File) => {
    if (f.size > 150 * 1024 * 1024) { setError('视频过大，请上传小于150MB的视频。'); return; }
    setFile(f); setPreviewUrl(URL.createObjectURL(f)); setError(null);
  };

  const handleUrlImport = async () => {
    if (!urlInput.trim()) return;
    if (!guard()) return;
    setIsFetchingUrl(true); setError(null);
    try {
      const res = await fetch('/api/proxy/video', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` },
        body: JSON.stringify({ url: urlInput }),
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || '导入失败'); }
      const blob = await res.blob();
      const f = new File([blob], 'imported_video.mp4', { type: 'video/mp4' });
      handleFile(f);
    } catch (e: any) { setError(e.message); } finally { setIsFetchingUrl(false); }
  };

  const handleAnalyze = async () => {
    if (!file) { setError('请先上传视频'); return; }
    if (!guard()) return;
    setIsAnalyzing(true); setError(null); setResult(null);
    try {
      const data = await analysisApi.analyzeGeneral(file, title, selectedModel || undefined);
      setResult(data);
    } catch (e: any) { setError(e.message); } finally { setIsAnalyzing(false); }
  };

  const reset = () => { setFile(null); setPreviewUrl(null); setTitle(''); setResult(null); setError(null); if (fileRef.current) fileRef.current.value = ''; };

  return (
    <div className="flex flex-col lg:flex-row h-full">
      {/* Input Panel */}
      <div className="w-full lg:w-[380px] shrink-0 h-fit lg:h-full lg:overflow-y-auto border-r border-white/5 bg-black [&::-webkit-scrollbar]:hidden" style={{ scrollbarWidth: 'none' }}>
        <div className="p-6 flex flex-col min-h-full">
          <h2 className="text-xl font-semibold text-white mb-6 flex items-center gap-3">
            <PlaySquare className="w-6 h-6 text-zinc-300" /> 开始通用分析
          </h2>

          {/* URL Input */}
          <div className="mb-4">
            <label className="block text-xs font-semibold text-zinc-400 mb-2 uppercase tracking-wider">视频链接导入</label>
            <div className="flex gap-2">
              <input type="text" value={urlInput} onChange={e => setUrlInput(e.target.value)} placeholder="粘贴 TikTok/YouTube/直链" className="flex-1 bg-white/[0.03] border-none rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:ring-1 focus:ring-white/20 placeholder:text-zinc-600" />
              <button onClick={handleUrlImport} disabled={isFetchingUrl || !urlInput.trim()} className="px-4 py-2 bg-white/5 hover:bg-white/10 rounded-xl text-xs font-medium transition-colors disabled:opacity-50">
                {isFetchingUrl ? <RefreshCw className="w-4 h-4 animate-spin" /> : '导入'}
              </button>
            </div>
          </div>

          {/* File Upload */}
          <input ref={fileRef} type="file" accept="video/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
          <div className="mb-4 border border-dashed border-white/10 rounded-2xl overflow-hidden h-[200px] transition-colors hover:border-blue-500/30 cursor-pointer flex items-center justify-center"
            onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f?.type.startsWith('video/')) handleFile(f); }}
            onClick={() => !previewUrl && fileRef.current?.click()}>
            {previewUrl ? (
              <div className="relative w-full h-full">
                <video src={previewUrl} className="w-full h-full object-contain bg-black" controls />
                <button onClick={e => { e.stopPropagation(); reset(); }} className="absolute top-2 right-2 bg-red-500/80 p-1.5 rounded-full"><X className="w-3 h-3" /></button>
              </div>
            ) : (
              <div className="text-center"><UploadCloud className="w-8 h-8 text-zinc-600 mx-auto mb-2" /><p className="text-xs text-zinc-500">拖拽或点击上传视频</p><p className="text-[10px] text-zinc-600 mt-1">支持 MP4/MOV/AVI/WebM，最大150MB</p></div>
            )}
          </div>

          {/* Title */}
          <div className="mb-6">
            <label className="block text-xs font-semibold text-zinc-400 mb-2 uppercase tracking-wider">视频标题 (选填)</label>
            <input type="text" value={title} onChange={e => setTitle(e.target.value)} placeholder="有标题可以让分析更精准" className="w-full bg-white/[0.03] border-none rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:ring-1 focus:ring-white/20 placeholder:text-zinc-600" />
          </div>

          <ModelSelector value={selectedModel} onChange={setSelectedModel} />

          {error && <div className="mb-4 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 text-sm text-red-400">{error}</div>}

          <div className="flex gap-3 mt-auto">
            <button onClick={handleAnalyze} disabled={!file || isAnalyzing} className="flex-1 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 text-white font-medium py-3 rounded-xl transition-all disabled:opacity-50 flex items-center justify-center gap-2">
              {isAnalyzing ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
              {isAnalyzing ? 'AI 分析中...' : '开始分析'}
            </button>
            <button onClick={reset} className="px-4 py-3 bg-white/5 hover:bg-white/10 rounded-xl text-sm transition-colors">重置</button>
          </div>
        </div>
      </div>

      {/* Result Panel */}
      <div className="flex-1 overflow-y-auto p-6 [&::-webkit-scrollbar]:hidden" style={{ scrollbarWidth: 'none' }}>
        {isAnalyzing ? <LoadingOverlay /> : result ? (
          <div className="max-w-4xl mx-auto space-y-6">
            <ResultSection icon={<FileText className="w-5 h-5 text-blue-400" />} title="视频总体思路">
              <p className="text-sm text-zinc-300 whitespace-pre-wrap leading-relaxed">{result.overallConcept}</p>
            </ResultSection>
            <PromptDisplay title="逆向视频提示词" english={result.reversePrompt} chinese={result.reversePromptTranslation} />
            <PromptDisplay title="逆向图片提示词" english={result.imageReversePrompt} chinese={result.imageReversePromptTranslation} />
            <ResultSection icon={<FileText className="w-5 h-5 text-zinc-400" />} title="标题分析">
              <p className="text-sm text-zinc-300 whitespace-pre-wrap">{result.titleAnalysis}</p>
            </ResultSection>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <ResultSection icon={<Tag className="w-4 h-4 text-blue-400" />} title="关键词"><TagList items={result.keywords} /></ResultSection>
              <ResultSection icon={<MessageCircle className="w-4 h-4 text-purple-400" />} title="热门话题"><TagList items={result.hotTopics} /></ResultSection>
              <ResultSection icon={<Music className="w-4 h-4 text-pink-400" />} title="BGM推荐"><TagList items={result.hotMusicStyles} /></ResultSection>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center h-full"><p className="text-zinc-600 text-sm">上传视频后点击"开始分析"</p></div>
        )}
      </div>
    </div>
  );
}

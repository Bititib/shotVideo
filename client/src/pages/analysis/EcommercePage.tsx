import React, { useState, useRef } from 'react';
import { ShoppingBag, UploadCloud, RefreshCw, Target, Zap, X, Wand2, ShoppingCart, Image as ImageIcon } from 'lucide-react';
import { analysisApi } from '../../api/analysis';
import { PromptDisplay, ResultSection, CopyButton, TagList, LoadingOverlay } from '../../components/UIComponents';
import ModelSelector from '../../components/ModelSelector';
import { useAuthGuard } from '../../hooks/useAuthGuard';

export default function EcommercePage() {
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

  // 换品功能
  const [replacementFile, setReplacementFile] = useState<File | null>(null);
  const [replacementPreview, setReplacementPreview] = useState<string | null>(null);
  const [isModifying, setIsModifying] = useState(false);
  const [modifyError, setModifyError] = useState<string | null>(null);
  const [productFrame, setProductFrame] = useState<string | null>(null);
  const replRef = useRef<HTMLInputElement>(null);

  const handleFile = (f: File) => {
    if (f.size > 150 * 1024 * 1024) { setError('视频过大'); return; }
    setFile(f); setPreviewUrl(URL.createObjectURL(f)); setError(null);
  };

  const handleUrlImport = async () => {
    if (!urlInput.trim()) return;
    if (!guard()) return;
    setIsFetchingUrl(true); setError(null);
    try {
      const res = await fetch('/api/proxy/video', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` }, body: JSON.stringify({ url: urlInput }) });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || '导入失败'); }
      const blob = await res.blob();
      handleFile(new File([blob], 'imported.mp4', { type: 'video/mp4' }));
    } catch (e: any) { setError(e.message); } finally { setIsFetchingUrl(false); }
  };

  const handleAnalyze = async () => {
    if (!file) return;
    if (!guard()) return;
    setIsAnalyzing(true); setError(null); setResult(null); setProductFrame(null);
    try {
      const data = await analysisApi.analyzeEcommerce(file, title, selectedModel || undefined);
      setResult(data);
      // 自动截取产品最佳展示帧
      if (data.bestProductShotTimestamp !== undefined && file) {
        try {
          const frame = await extractFrame(file, data.bestProductShotTimestamp);
          setProductFrame(frame);
        } catch (e) { console.error('Frame extraction failed:', e); }
      }
    } catch (e: any) { setError(e.message); } finally { setIsAnalyzing(false); }
  };

  /** 从视频中截取指定时间戳的帧画面 */
  const extractFrame = (videoFile: File, timestamp: number): Promise<string> => {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.src = URL.createObjectURL(videoFile);
      video.crossOrigin = 'anonymous';
      video.currentTime = timestamp;
      video.muted = true;
      video.playsInline = true;
      video.onseeked = () => {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth || 1280;
        canvas.height = video.videoHeight || 720;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.8));
        } else {
          reject(new Error('Canvas context not available'));
        }
        URL.revokeObjectURL(video.src);
      };
      video.onerror = () => { reject(new Error('Video frame extraction failed')); URL.revokeObjectURL(video.src); };
    });
  };

  const handleModifyPrompt = async () => {
    if (!replacementFile || !result) return;
    if (!guard()) return;
    setIsModifying(true); setModifyError(null);
    try {
      const data = await analysisApi.modifyPrompt(replacementFile, result.reversePrompt);
      setResult({ ...result, reversePrompt: data.reversePrompt, reversePromptTranslation: data.reversePromptTranslation });
    } catch (e: any) { setModifyError(e.message); } finally { setIsModifying(false); }
  };

  const reset = () => { setFile(null); setPreviewUrl(null); setTitle(''); setResult(null); setError(null); setReplacementFile(null); setReplacementPreview(null); setProductFrame(null); };

  return (
    <div className="flex flex-col lg:flex-row h-full">
      <div className="w-full lg:w-[380px] shrink-0 h-fit lg:h-full lg:overflow-y-auto border-r border-white/5 bg-black [&::-webkit-scrollbar]:hidden" style={{ scrollbarWidth: 'none' }}>
        <div className="p-6 flex flex-col min-h-full">
          <h2 className="text-xl font-semibold text-white mb-6 flex items-center gap-3">
            <ShoppingBag className="w-6 h-6 text-zinc-300" /> 开始带货分析
          </h2>

          <div className="mb-4">
            <label className="block text-xs font-semibold text-zinc-400 mb-2 uppercase tracking-wider">视频链接导入</label>
            <div className="flex gap-2">
              <input type="text" value={urlInput} onChange={e => setUrlInput(e.target.value)} placeholder="粘贴 TikTok/YouTube/直链" className="flex-1 bg-white/[0.03] border-none rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:ring-1 focus:ring-white/20 placeholder:text-zinc-600" />
              <button onClick={handleUrlImport} disabled={isFetchingUrl || !urlInput.trim()} className="px-4 py-2 bg-white/5 hover:bg-white/10 rounded-xl text-xs font-medium transition-colors disabled:opacity-50">
                {isFetchingUrl ? <RefreshCw className="w-4 h-4 animate-spin" /> : '导入'}
              </button>
            </div>
          </div>

          <input ref={fileRef} type="file" accept="video/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
          <div className="mb-4 border border-dashed border-white/10 rounded-2xl overflow-hidden h-[200px] hover:border-purple-500/30 cursor-pointer flex items-center justify-center"
            onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f?.type.startsWith('video/')) handleFile(f); }}
            onClick={() => !previewUrl && fileRef.current?.click()}>
            {previewUrl ? (
              <div className="relative w-full h-full">
                <video src={previewUrl} className="w-full h-full object-contain bg-black" controls />
                <button onClick={e => { e.stopPropagation(); reset(); }} className="absolute top-2 right-2 bg-red-500/80 p-1.5 rounded-full"><X className="w-3 h-3" /></button>
              </div>
            ) : (
              <div className="text-center"><UploadCloud className="w-8 h-8 text-zinc-600 mx-auto mb-2" /><p className="text-xs text-zinc-500">拖拽或点击上传带货视频</p></div>
            )}
          </div>

          <div className="mb-6">
            <label className="block text-xs font-semibold text-zinc-400 mb-2 uppercase tracking-wider">视频标题 (选填)</label>
            <input type="text" value={title} onChange={e => setTitle(e.target.value)} placeholder="填入标题让分析更精准" className="w-full bg-white/[0.03] border-none rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:ring-1 focus:ring-white/20 placeholder:text-zinc-600" />
          </div>

          <ModelSelector value={selectedModel} onChange={setSelectedModel} />

          {error && <div className="mb-4 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 text-sm text-red-400">{error}</div>}

          <div className="flex gap-3 mt-auto">
            <button onClick={handleAnalyze} disabled={!file || isAnalyzing} className="flex-1 bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-500 hover:to-pink-500 text-white font-medium py-3 rounded-xl transition-all disabled:opacity-50 flex items-center justify-center gap-2">
              {isAnalyzing ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
              {isAnalyzing ? 'AI 分析中...' : '开始分析'}
            </button>
            <button onClick={reset} className="px-4 py-3 bg-white/5 hover:bg-white/10 rounded-xl text-sm transition-colors">重置</button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6 [&::-webkit-scrollbar]:hidden" style={{ scrollbarWidth: 'none' }}>
        {isAnalyzing ? <LoadingOverlay /> : result ? (
          <div className="max-w-4xl mx-auto space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <ResultSection icon={<ShoppingCart className="w-5 h-5 text-purple-400" />} title="商品识别">
                <p className="text-lg font-bold text-white">{result.productName}</p>
              </ResultSection>
              <ResultSection icon={<Target className="w-5 h-5 text-pink-400" />} title="目标人群">
                <p className="text-sm text-zinc-300">{result.targetAudience}</p>
              </ResultSection>
            </div>

            {/* 产品参考图（自动截取） */}
            {(productFrame || result.bestProductShotTimestamp !== undefined) && (
              <ResultSection icon={<ImageIcon className="w-5 h-5 text-amber-400" />} title="产品参考图">
                <div className="rounded-lg border border-white/5 overflow-hidden relative min-h-[200px] flex items-center justify-center bg-black/50">
                  {productFrame ? (
                    <img src={productFrame} alt={result.productName} className="w-full h-full object-contain max-h-[400px]" />
                  ) : (
                    <div className="text-center p-4"><ImageIcon className="w-8 h-8 text-zinc-600 mx-auto mb-2" /><p className="text-xs text-zinc-500">正在从视频中提取...</p></div>
                  )}
                  {result.bestProductShotTimestamp !== undefined && (
                    <div className="absolute bottom-2 right-2 bg-black/70 text-white text-xs px-2 py-1 rounded backdrop-blur-sm border border-white/10">
                      {result.bestProductShotTimestamp}s
                    </div>
                  )}
                </div>
              </ResultSection>
            )}
            <ResultSection icon={<Zap className="w-5 h-5 text-yellow-400" />} title="Hook 分析 (前3秒)">
              <p className="text-sm text-zinc-300 whitespace-pre-wrap">{result.hookAnalysis}</p>
            </ResultSection>
            <ResultSection icon={<Target className="w-5 h-5 text-blue-400" />} title="核心卖点">
              <ul className="space-y-2">{result.sellingPoints?.map((p: string, i: number) => <li key={i} className="text-sm text-zinc-300 flex items-start gap-2"><span className="text-blue-400 mt-0.5">•</span>{p}</li>)}</ul>
            </ResultSection>
            <PromptDisplay title="逆向视频提示词" english={result.reversePrompt} chinese={result.reversePromptTranslation} />
            <PromptDisplay title="逆向图片提示词" english={result.imageReversePrompt} chinese={result.imageReversePromptTranslation} />

            {/* 视觉与情感分析 */}
            {result.visualAndEmotionAnalysis && (
              <ResultSection icon={<Zap className="w-5 h-5 text-indigo-400" />} title="视觉丰富度与情感共鸣">
                <p className="text-sm text-zinc-300 whitespace-pre-wrap">{result.visualAndEmotionAnalysis}</p>
              </ResultSection>
            )}

            {/* 脚本文案分析 */}
            {result.scriptAnalysis && (
              <ResultSection icon={<Target className="w-5 h-5 text-cyan-400" />} title="脚本文案分析">
                <div className="space-y-3">
                  <div><p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">整体概述</p><p className="text-sm text-zinc-300">{result.scriptAnalysis.overview}</p></div>
                  <div><p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Hook 开头</p><p className="text-sm text-zinc-300">{result.scriptAnalysis.hook}</p></div>
                  <div><p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">主体内容</p><p className="text-sm text-zinc-300">{result.scriptAnalysis.body}</p></div>
                  <div><p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">促单部分</p><p className="text-sm text-zinc-300">{result.scriptAnalysis.callToAction}</p></div>
                  {result.scriptAnalysis.keywords?.length > 0 && (
                    <div><p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">核心关键词</p><div className="flex flex-wrap gap-1">{result.scriptAnalysis.keywords.map((k: string, i: number) => <span key={i} className="text-xs bg-cyan-500/10 text-cyan-400 px-2 py-0.5 rounded-full">{k}</span>)}</div></div>
                  )}
                </div>
              </ResultSection>
            )}

            {/* 视频完整语音文案 */}
            {result.videoTranscript && (
              <ResultSection icon={<ShoppingBag className="w-5 h-5 text-emerald-400" />} title="视频完整语音文案">
                <div className="flex items-start gap-2"><p className="text-sm text-zinc-300 whitespace-pre-wrap flex-1">{result.videoTranscript}</p><CopyButton text={result.videoTranscript} /></div>
              </ResultSection>
            )}

            {/* 换品模块 */}
            <div className="bg-white/[0.02] border border-white/5 rounded-2xl p-5">
              <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2"><RefreshCw className="w-4 h-4 text-green-400" /> 一键换品</h3>
              <p className="text-xs text-zinc-500 mb-3">上传新产品图片，AI 保留视频风格和镜头语言，只替换商品。</p>
              <input ref={replRef} type="file" accept="image/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) { setReplacementFile(f); setReplacementPreview(URL.createObjectURL(f)); } }} />
              <div className="flex gap-3 items-center">
                <div className="w-20 h-20 rounded-xl border border-dashed border-white/10 cursor-pointer flex items-center justify-center overflow-hidden hover:border-green-500/30 transition-colors"
                  onClick={() => replRef.current?.click()}>
                  {replacementPreview ? <img src={replacementPreview} className="w-full h-full object-cover" /> : <UploadCloud className="w-5 h-5 text-zinc-600" />}
                </div>
                <button onClick={handleModifyPrompt} disabled={!replacementFile || isModifying} className="px-4 py-2 bg-green-600/80 hover:bg-green-600 text-white text-xs font-medium rounded-xl disabled:opacity-50 flex items-center gap-2">
                  {isModifying ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />}
                  {isModifying ? '替换中...' : '一键换品'}
                </button>
              </div>
              {modifyError && <p className="text-xs text-red-400 mt-2">{modifyError}</p>}
            </div>

            <ResultSection icon={<Zap className="w-5 h-5 text-orange-400" />} title="促单话术">
              <p className="text-sm text-zinc-300 whitespace-pre-wrap">{result.callToAction}</p>
            </ResultSection>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center h-full"><p className="text-zinc-600 text-sm">上传带货视频后点击"开始分析"</p></div>
        )}
      </div>
    </div>
  );
}

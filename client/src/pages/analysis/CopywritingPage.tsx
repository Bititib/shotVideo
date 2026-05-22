import React, { useState, useRef } from 'react';
import { Megaphone, UploadCloud, RefreshCw, Wand2, X, Plus, ShoppingCart, List, Tag, Download, Image as ImageIcon } from 'lucide-react';
import { analysisApi } from '../../api/analysis';
import { ResultSection, CopyButton, LoadingOverlay } from '../../components/UIComponents';
import ModelSelector from '../../components/ModelSelector';
import { useAuthGuard } from '../../hooks/useAuthGuard';

export default function CopywritingPage() {
  const guard = useAuthGuard();
  const [files, setFiles] = useState<File[]>([]);
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [genBg, setGenBg] = useState<Record<number, string>>({});
  const [genBgLoading, setGenBgLoading] = useState<Record<number, boolean>>({});
  const [selectedModel, setSelectedModel] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const addFiles = (newFiles: File[]) => {
    const valid = newFiles.filter(f => f.size <= 150 * 1024 * 1024);
    if (valid.length < newFiles.length) setError('部分文件过大，已忽略');
    if (valid.length > 0) {
      setFiles(p => [...p, ...valid]);
      setPreviewUrls(p => [...p, ...valid.map(f => URL.createObjectURL(f))]);
    }
  };

  const removeFile = (i: number) => {
    setFiles(p => p.filter((_, idx) => idx !== i));
    setPreviewUrls(p => { URL.revokeObjectURL(p[i]); return p.filter((_, idx) => idx !== i); });
  };

  const handleAnalyze = async () => {
    if (files.length === 0) return;
    if (!guard()) return;
    setIsAnalyzing(true); setError(null); setResult(null);
    try { setResult(await analysisApi.analyzeCopywriting(files, selectedModel || undefined)); } catch (e: any) { setError(e.message); } finally { setIsAnalyzing(false); }
  };

  const handleGenerateBg = async (index: number, prompt: string) => {
    if (!guard()) return;
    setGenBgLoading(p => ({ ...p, [index]: true }));
    try {
      const data = await analysisApi.generateImage(prompt, '4:5');
      setGenBg(p => ({ ...p, [index]: `data:image/png;base64,${data.imageBase64}` }));
    } catch (e: any) { setError(e.message); } finally { setGenBgLoading(p => ({ ...p, [index]: false })); }
  };

  const reset = () => { setFiles([]); setPreviewUrls([]); setResult(null); setError(null); setGenBg({}); };

  return (
    <div className="flex flex-col lg:flex-row h-full">
      <div className="w-full lg:w-[380px] shrink-0 h-fit lg:h-full lg:overflow-y-auto border-r border-white/5 bg-black [&::-webkit-scrollbar]:hidden" style={{ scrollbarWidth: 'none' }}>
        <div className="p-6 flex flex-col min-h-full">
          <h2 className="text-xl font-semibold text-white mb-6 flex items-center gap-3">
            <Megaphone className="w-6 h-6 text-zinc-300" /> 开始生成爆款文案
          </h2>

          <input ref={fileRef} type="file" accept="image/*,video/*" multiple className="hidden" onChange={e => { if (e.target.files) addFiles(Array.from(e.target.files)); }} />

          <div className="mb-4 border border-dashed border-white/10 rounded-2xl p-4 min-h-[200px] hover:border-orange-500/30 cursor-pointer transition-colors"
            onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); addFiles(Array.from(e.dataTransfer.files)); }}
            onClick={() => files.length === 0 && fileRef.current?.click()}>
            {previewUrls.length > 0 ? (
              <div className="space-y-2">
                <div className="grid grid-cols-3 gap-2">
                  {previewUrls.map((url, i) => (
                    <div key={i} className="relative aspect-square rounded-lg overflow-hidden bg-black/50 group border border-white/5">
                      {files[i]?.type.startsWith('video/') ? (
                        <video src={url} className="w-full h-full object-cover" />
                      ) : (
                        <img src={url} className="w-full h-full object-cover" />
                      )}
                      <button onClick={e => { e.stopPropagation(); removeFile(i); }} className="absolute top-1 right-1 bg-red-500/80 p-1 rounded-full opacity-0 group-hover:opacity-100 transition-opacity"><X className="w-3 h-3" /></button>
                    </div>
                  ))}
                </div>
                <button onClick={e => { e.stopPropagation(); fileRef.current?.click(); }} className="w-full py-2 border border-dashed border-white/10 rounded-lg text-xs text-zinc-500 hover:text-zinc-300 hover:border-white/20 flex items-center justify-center gap-1 transition-colors">
                  <Plus className="w-3 h-3" /> 添加更多
                </button>
              </div>
            ) : (
              <div className="flex items-center justify-center h-full text-center">
                <div><UploadCloud className="w-8 h-8 text-zinc-600 mx-auto mb-2" /><p className="text-xs text-zinc-500">上传产品图片或视频 (支持多文件)</p></div>
              </div>
            )}
          </div>

          <ModelSelector value={selectedModel} onChange={setSelectedModel} />

          {error && <div className="mb-4 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 text-sm text-red-400">{error}</div>}

          <div className="flex gap-3 mt-auto">
            <button onClick={handleAnalyze} disabled={files.length === 0 || isAnalyzing} className="flex-1 bg-gradient-to-r from-orange-600 to-amber-600 hover:from-orange-500 hover:to-amber-500 text-white font-medium py-3 rounded-xl transition-all disabled:opacity-50 flex items-center justify-center gap-2">
              {isAnalyzing ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
              {isAnalyzing ? 'AI 生成中...' : '生成文案'}
            </button>
            <button onClick={reset} className="px-4 py-3 bg-white/5 hover:bg-white/10 rounded-xl text-sm transition-colors">重置</button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6 [&::-webkit-scrollbar]:hidden" style={{ scrollbarWidth: 'none' }}>
        {isAnalyzing ? <LoadingOverlay message="AI 正在生成爆款文案..." /> : result ? (
          <div className="max-w-4xl mx-auto space-y-6">
            {/* TikTok */}
            <ResultSection icon={<Tag className="w-5 h-5 text-blue-400" />} title="TikTok 爆款文案">
              <div className="space-y-4">
                <div><p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Hook (黄金3秒)</p><div className="flex items-start gap-2"><p className="text-sm text-white font-medium">{result.tiktok?.hook}</p><CopyButton text={result.tiktok?.hook || ''} /></div></div>
                <div><p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Caption</p><div className="flex items-start gap-2"><p className="text-sm text-zinc-300 whitespace-pre-wrap">{result.tiktok?.caption}</p><CopyButton text={result.tiktok?.caption || ''} /></div></div>
                <div><p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Hashtags</p><div className="flex flex-wrap gap-1">{result.tiktok?.hashtags?.map((h: string, i: number) => <span key={i} className="text-xs text-blue-400">{h}</span>)}</div></div>
              </div>
            </ResultSection>

            {/* Amazon */}
            <ResultSection icon={<ShoppingCart className="w-5 h-5 text-orange-400" />} title="Amazon Listing">
              <div className="space-y-4">
                <div><p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">SEO 标题</p><div className="flex items-start gap-2"><p className="text-sm text-white font-medium">{result.amazon?.title}</p><CopyButton text={result.amazon?.title || ''} /></div></div>
                <div><p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">五点卖点</p>{result.amazon?.bulletPoints?.map((b: string, i: number) => <p key={i} className="text-xs text-zinc-300 flex items-start gap-2 mt-1"><span className="text-orange-400">•</span>{b}</p>)}</div>
                <div><p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">产品描述</p><p className="text-xs text-zinc-300 whitespace-pre-wrap">{result.amazon?.productDescription}</p></div>
              </div>
            </ResultSection>

            {/* A+ Content */}
            <ResultSection icon={<ImageIcon className="w-5 h-5 text-purple-400" />} title="A+ 详情页策划">
              <div className="space-y-4">
                {result.detailPageImages?.map((img: any, i: number) => (
                  <div key={i} className="bg-white/[0.02] border border-white/5 rounded-xl p-4">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-semibold text-zinc-300">{i + 1}. {img.imageType}</span>
                      <button onClick={() => handleGenerateBg(i, img.prompt)} disabled={genBgLoading[i]} className="text-[10px] px-3 py-1 bg-purple-500/20 text-purple-400 rounded-lg hover:bg-purple-500/30 disabled:opacity-50">
                        {genBgLoading[i] ? <RefreshCw className="w-3 h-3 animate-spin inline" /> : 'AI 生成底图'}
                      </button>
                    </div>
                    <p className="text-xs text-zinc-400 mb-2">{img.description}</p>
                    {img.textOverlay?.length > 0 && (
                      <div className="mb-2"><p className="text-[10px] text-zinc-500 mb-1">文案覆盖:</p>{img.textOverlay.map((t: string, j: number) => <p key={j} className="text-xs text-zinc-300">• {t}</p>)}</div>
                    )}
                    <div className="flex items-start gap-2"><p className="text-[10px] text-zinc-500 flex-1 break-all">Prompt: {img.prompt}</p><CopyButton text={img.prompt} /></div>
                    {genBg[i] && <img src={genBg[i]} className="mt-3 rounded-lg max-h-60 object-contain" />}
                  </div>
                ))}
              </div>
            </ResultSection>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center h-full"><p className="text-zinc-600 text-sm">上传产品素材后点击"生成文案"</p></div>
        )}
      </div>
    </div>
  );
}

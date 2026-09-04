import React, { useState, useRef } from 'react';
import { Users, UploadCloud, RefreshCw, Wand2, X, Plus, TrendingUp, BarChart, Crosshair, Lightbulb, UserCheck, Search, Zap } from 'lucide-react';
import { analysisApi } from '../../api/analysis';
import { ResultSection, CopyButton, LoadingOverlay } from '../../components/UIComponents';
import ModelSelector from '../../components/ModelSelector';
import { useAuthGuard } from '../../hooks/useAuthGuard';
import { isSupportedImageFile, MOBILE_IMAGE_ACCEPT, normalizeImageFile } from '../../utils/imageNormalization';

export default function AccountPage() {
  const guard = useAuthGuard();
  const [handle, setHandle] = useState('');
  const [description, setDescription] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [genAvatar, setGenAvatar] = useState<string | null>(null);
  const [genAvatarLoading, setGenAvatarLoading] = useState(false);
  const [genCover, setGenCover] = useState<string | null>(null);
  const [genCoverLoading, setGenCoverLoading] = useState(false);
  const [selectedModel, setSelectedModel] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const addFiles = async (newFiles: File[]) => {
    const valid = newFiles.filter(isSupportedImageFile).filter(f => f.size <= 10 * 1024 * 1024).slice(0, 5 - files.length);
    if (valid.length === 0) return;
    try {
      const normalized = await Promise.all(valid.map(file => normalizeImageFile(file, {
        maxDimension: 2048,
        quality: 0.9,
        outputType: 'image/jpeg',
        maxInputBytes: 10 * 1024 * 1024,
      })));
      setFiles(p => [...p, ...normalized.map(item => item.file)].slice(0, 5));
      setPreviewUrls(p => [...p, ...normalized.map(item => URL.createObjectURL(item.blob))].slice(0, 5));
      setError(null);
    } catch (error: any) {
      setError(error?.message || '图片读取失败');
    }
  };

  const removeFile = (i: number) => {
    setFiles(p => p.filter((_, idx) => idx !== i));
    setPreviewUrls(p => { URL.revokeObjectURL(p[i]); return p.filter((_, idx) => idx !== i); });
  };

  const handleAnalyze = async () => {
    if (!handle && files.length === 0) { setError('请至少填入账号名或上传截图'); return; }
    if (!guard()) return;
    setIsAnalyzing(true); setError(null); setResult(null);
    try { setResult(await analysisApi.analyzeAccount(handle, description, files, selectedModel || undefined)); } catch (e: any) { setError(e.message); } finally { setIsAnalyzing(false); }
  };

  const handleGenImage = async (type: 'avatar' | 'cover') => {
    if (!guard()) return;
    if (!result?.actionableBlueprint?.visualConcepts) return;
    const prompt = type === 'avatar' ? result.actionableBlueprint.visualConcepts.avatarPrompt : result.actionableBlueprint.visualConcepts.coverStylePrompt;
    const setter = type === 'avatar' ? setGenAvatar : setGenCover;
    const loadSetter = type === 'avatar' ? setGenAvatarLoading : setGenCoverLoading;
    loadSetter(true);
    try {
      const data = await analysisApi.generateImage(prompt, type === 'avatar' ? '1:1' : '16:9');
      setter(`data:image/png;base64,${data.imageBase64}`);
    } catch (e: any) { setError(e.message); } finally { loadSetter(false); }
  };

  const reset = () => { previewUrls.forEach(url => URL.revokeObjectURL(url)); setHandle(''); setDescription(''); setFiles([]); setPreviewUrls([]); setResult(null); setError(null); setGenAvatar(null); setGenCover(null); };

  const sections = result ? [
    { icon: <Search className="w-5 h-5 text-blue-400" />, title: '内容分析', content: result.contentAnalysis },
    { icon: <Zap className="w-5 h-5 text-yellow-400" />, title: '音频策略', content: result.audioAnalysis },
    { icon: <TrendingUp className="w-5 h-5 text-green-400" />, title: '涨粉策略', content: result.growthStrategy },
    { icon: <UserCheck className="w-5 h-5 text-purple-400" />, title: '目标人群', content: result.audienceAnalysis },
    { icon: <Lightbulb className="w-5 h-5 text-orange-400" />, title: '改进方案', content: result.improvementPlan },
    { icon: <BarChart className="w-5 h-5 text-cyan-400" />, title: '运营剖析', content: result.operationalAnalysis },
  ] : [];

  return (
    <div className="flex flex-col lg:flex-row h-full">
      <div className="w-full lg:w-[380px] shrink-0 h-fit lg:h-full lg:overflow-y-auto border-r border-white/5 bg-black [&::-webkit-scrollbar]:hidden" style={{ scrollbarWidth: 'none' }}>
        <div className="p-6 flex flex-col min-h-full">
          <h2 className="text-xl font-semibold text-white mb-6 flex items-center gap-3">
            <Users className="w-6 h-6 text-zinc-300" /> 开始账号全方位分析
          </h2>

          <div className="space-y-4 mb-4">
            <div>
              <label className="block text-xs font-semibold text-zinc-400 mb-2 uppercase tracking-wider">账号名称或链接</label>
              <input type="text" value={handle} onChange={e => setHandle(e.target.value)} placeholder="@creator 或主页链接" className="w-full bg-white/[0.03] border-none rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:ring-1 focus:ring-white/20 placeholder:text-zinc-600" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-zinc-400 mb-2 uppercase tracking-wider">账号简述 (选填)</label>
              <textarea value={description} onChange={e => setDescription(e.target.value)} rows={3} placeholder="描述该账号主要内容或你的观察..." className="w-full bg-white/[0.03] border-none rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:ring-1 focus:ring-white/20 placeholder:text-zinc-600 resize-none" />
            </div>
          </div>

          <input ref={fileRef} type="file" accept={MOBILE_IMAGE_ACCEPT} multiple className="hidden" onChange={e => { if (e.target.files) void addFiles(Array.from(e.target.files)); e.target.value = ''; }} />
          <div className="mb-4">
            <label className="block text-xs font-semibold text-zinc-400 mb-2 uppercase tracking-wider">主页截图 (最多5张)</label>
            <div className="border border-dashed border-white/10 rounded-2xl p-3 min-h-[120px] hover:border-emerald-500/30 cursor-pointer transition-colors"
              onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); void addFiles(Array.from(e.dataTransfer.files)); }}
              onClick={() => files.length === 0 && fileRef.current?.click()}>
              {previewUrls.length > 0 ? (
                <div className="space-y-2">
                  <div className="grid grid-cols-3 gap-2">
                    {previewUrls.map((url, i) => (
                      <div key={i} className="relative aspect-square rounded-lg overflow-hidden bg-black/50 group border border-white/5">
                        <img src={url} className="w-full h-full object-cover" />
                        <button onClick={e => { e.stopPropagation(); removeFile(i); }} className="absolute top-1 right-1 bg-red-500/80 p-1 rounded-full opacity-0 group-hover:opacity-100 transition-opacity"><X className="w-3 h-3" /></button>
                      </div>
                    ))}
                  </div>
                  {files.length < 5 && (
                    <button onClick={e => { e.stopPropagation(); fileRef.current?.click(); }} className="w-full py-1.5 border border-dashed border-white/10 rounded-lg text-xs text-zinc-500 hover:text-zinc-300 flex items-center justify-center gap-1"><Plus className="w-3 h-3" /> 添加</button>
                  )}
                </div>
              ) : (
                <div className="flex items-center justify-center h-full text-center py-4"><UploadCloud className="w-6 h-6 text-zinc-600 mx-auto mb-1" /><p className="text-xs text-zinc-500">上传主页截图</p></div>
              )}
            </div>
          </div>

          <ModelSelector value={selectedModel} onChange={setSelectedModel} />

          {error && <div className="mb-4 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 text-sm text-red-400">{error}</div>}

          <div className="flex gap-3 mt-auto">
            <button onClick={handleAnalyze} disabled={(!handle && files.length === 0) || isAnalyzing} className="flex-1 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-medium py-3 rounded-xl transition-all disabled:opacity-50 flex items-center justify-center gap-2">
              {isAnalyzing ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
              {isAnalyzing ? 'AI 分析中...' : '全方位分析'}
            </button>
            <button onClick={reset} className="px-4 py-3 bg-white/5 hover:bg-white/10 rounded-xl text-sm transition-colors">重置</button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6 [&::-webkit-scrollbar]:hidden" style={{ scrollbarWidth: 'none' }}>
        {isAnalyzing ? <LoadingOverlay message="AI 正在全方位深度分析..." /> : result ? (
          <div className="max-w-4xl mx-auto space-y-6">
            {sections.map((s, i) => (
              <ResultSection key={i} icon={s.icon} title={s.title}>
                {s.content && typeof s.content === 'object' && Object.entries(s.content).map(([key, val]) => (
                  <div key={key} className="mb-3 last:mb-0">
                    <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">{key}</p>
                    {Array.isArray(val) ? (
                      <ul className="space-y-1">{(val as any[]).map((v, j) => (
                        typeof v === 'object' && v !== null && v.phase ? (
                          <li key={j} className="text-xs text-zinc-300 flex items-start gap-2"><span className="text-emerald-400 font-semibold">{v.phase}:</span> {v.description}</li>
                        ) : (
                          <li key={j} className="text-xs text-zinc-300 flex items-start gap-2"><span className="text-emerald-400 mt-0.5">•</span>{String(v)}</li>
                        )
                      ))}</ul>
                    ) : (
                      <p className="text-sm text-zinc-300 whitespace-pre-wrap">{val as string}</p>
                    )}
                  </div>
                ))}
              </ResultSection>
            ))}

            {/* 估算总播放量 */}
            {result.calculatedPlayCount && (
              <ResultSection icon={<BarChart className="w-5 h-5 text-amber-400" />} title="估算总播放量">
                <p className="text-2xl font-bold text-white mb-2">{result.calculatedPlayCount.estimatedTotal}</p>
                <p className="text-xs text-zinc-400">{result.calculatedPlayCount.explanation}</p>
              </ResultSection>
            )}

            {/* 实操蓝图 */}
            {result.actionableBlueprint && (
              <ResultSection icon={<Crosshair className="w-5 h-5 text-red-400" />} title="实操蓝图">
                <div className="space-y-4">
                  <div><p className="text-[10px] text-zinc-500 uppercase mb-1">Positioning</p><p className="text-sm text-zinc-300">{result.actionableBlueprint.positioning}</p></div>
                  <div><p className="text-[10px] text-zinc-500 uppercase mb-1">Content Pillars</p><ul>{result.actionableBlueprint.contentPillars?.map((c: string, i: number) => <li key={i} className="text-xs text-zinc-300">• {c}</li>)}</ul></div>
                  <div><p className="text-[10px] text-zinc-500 uppercase mb-1">Execution Steps</p><ul>{result.actionableBlueprint.executionSteps?.map((s: string, i: number) => <li key={i} className="text-xs text-zinc-300">{i + 1}. {s}</li>)}</ul></div>

                  {/* AI 头像/封面生成 */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
                    <div className="bg-white/[0.02] border border-white/5 rounded-xl p-4">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-semibold text-zinc-300">AI 头像</span>
                        <button onClick={() => handleGenImage('avatar')} disabled={genAvatarLoading} className="text-[10px] px-3 py-1 bg-emerald-500/20 text-emerald-400 rounded-lg disabled:opacity-50">
                          {genAvatarLoading ? <RefreshCw className="w-3 h-3 animate-spin inline" /> : '生成'}
                        </button>
                      </div>
                      <p className="text-[10px] text-zinc-500 mb-2 break-all">{result.actionableBlueprint.visualConcepts?.avatarPrompt}</p>
                      {genAvatar && <img src={genAvatar} className="rounded-lg max-h-40 object-contain" />}
                    </div>
                    <div className="bg-white/[0.02] border border-white/5 rounded-xl p-4">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-semibold text-zinc-300">AI 封面风格</span>
                        <button onClick={() => handleGenImage('cover')} disabled={genCoverLoading} className="text-[10px] px-3 py-1 bg-emerald-500/20 text-emerald-400 rounded-lg disabled:opacity-50">
                          {genCoverLoading ? <RefreshCw className="w-3 h-3 animate-spin inline" /> : '生成'}
                        </button>
                      </div>
                      <p className="text-[10px] text-zinc-500 mb-2 break-all">{result.actionableBlueprint.visualConcepts?.coverStylePrompt}</p>
                      {genCover && <img src={genCover} className="rounded-lg max-h-40 object-contain" />}
                    </div>
                  </div>
                </div>
              </ResultSection>
            )}
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center h-full"><p className="text-zinc-600 text-sm">输入账号信息后点击"全方位分析"</p></div>
        )}
      </div>
    </div>
  );
}

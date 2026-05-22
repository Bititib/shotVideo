import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Video, Play, Square, Download, Loader2, Check, AlertCircle, Sparkles, Monitor, Smartphone, RectangleHorizontal, Upload, X, Film } from 'lucide-react';
import { fetchVideoModels, generateVideo, type VideoModel, type VideoSSEEvent } from '../../api/video';
import { useImageDropPaste } from '../../hooks/useImageDropPaste';
import { useAuthGuard } from '../../hooks/useAuthGuard';

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
const DURATIONS = [
  { value: 6, label: '6 秒' }, { value: 10, label: '10 秒' },
  { value: 12, label: '12 秒' }, { value: 16, label: '16 秒' },
  { value: 20, label: '20 秒' }, { value: 30, label: '30 秒' },
];
const RESOLUTIONS = [{ value: '480p', label: '480p' }, { value: '720p', label: '720p' }];
const MAX_REFS = 10;

function CustomSelect({ value, options, onChange }: any) {
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setIsOpen(false); };
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h);
  }, []);
  const selected = options.find((o: any) => o.value === value);
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setIsOpen(!isOpen)}
        className={`flex items-center gap-2 bg-white/[0.03] hover:bg-white/[0.05] rounded-lg px-3 py-2 text-[11px] text-zinc-300 transition-colors border ${isOpen ? 'border-indigo-500/30' : 'border-transparent'}`}>
        {selected?.icon && <selected.icon className="w-3.5 h-3.5 text-indigo-400" />}
        {selected?.label || value}
      </button>
      {isOpen && (
        <div className="absolute bottom-full left-0 mb-2 min-w-full w-max bg-[#1a1a1a] border border-white/10 rounded-xl shadow-2xl p-1 z-50 flex flex-col max-h-[240px] overflow-y-auto [&::-webkit-scrollbar]:hidden" style={{ scrollbarWidth: 'none' }}>
          {options.map((o: any) => (
            <button key={o.value} onClick={() => { onChange(o.value); setIsOpen(false); }}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-left text-[11px] transition-colors ${value === o.value ? 'bg-indigo-500/20 text-indigo-300' : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/5'}`}>
              {o.icon && <o.icon className="w-3.5 h-3.5" />}{o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function VideoPage() {
  const navigate = useNavigate();
  const guard = useAuthGuard();
  const [models, setModels] = useState<VideoModel[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [aspectRatio, setAspectRatio] = useState('16:9');
  const [duration, setDuration] = useState(6);
  const [resolution, setResolution] = useState('720p');
  const [referenceImages, setReferenceImages] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusMessage, setStatusMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [currentVideo, setCurrentVideo] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    fetchVideoModels().then((m) => { setModels(m); if (m.length > 0 && !selectedModel) setSelectedModel(m[0].id); }).catch(() => {});
  }, []);

  const readFileAsDataURL = (file: File): Promise<string> =>
    new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result as string); r.onerror = reject; r.readAsDataURL(file); });

  const handleFileSelect = async (files: FileList | null) => {
    if (!files) return;
    const remaining = MAX_REFS - referenceImages.length;
    if (remaining <= 0) { setError(`最多 ${MAX_REFS} 张参考图`); return; }
    const valid = Array.from(files).filter(f => f.type.startsWith('image/')).slice(0, remaining);
    if (valid.length === 0) return;
    if (valid.find(f => f.size > 20 * 1024 * 1024)) { setError('参考图超过 20MB'); return; }
    try { const urls = await Promise.all(valid.map(readFileAsDataURL)); setReferenceImages(prev => [...prev, ...urls]); } catch { setError('图片读取失败'); }
  };

  // 全局拖拽 + Ctrl+V 粘贴上传参考图
  useImageDropPaste(handleFileSelect);

  const handleGenerate = useCallback(() => {
    if (!prompt.trim() || isGenerating) return;
    if (!guard()) return;
    setIsGenerating(true); setProgress(0); setError(null); setCurrentVideo(null); setStatusMessage('正在连接...');
    const ctrl = generateVideo(
      { prompt: prompt.trim(), model: selectedModel, aspect_ratio: aspectRatio, video_length: duration, resolution, reference_images: referenceImages.length > 0 ? referenceImages : undefined },
      (event: VideoSSEEvent) => {
        switch (event.type) {
          case 'status': setStatusMessage(event.message || ''); break;
          case 'progress': setProgress(event.progress || 0); setStatusMessage(`视频生成中 ${event.progress}%`); break;
          case 'complete': setCurrentVideo(event.videoUrl || null); setIsGenerating(false); setProgress(100); setStatusMessage(''); break;
          case 'error': setError(event.message || '生成失败'); setIsGenerating(false); setStatusMessage(''); break;
        }
      },
    );
    abortRef.current = ctrl;
  }, [prompt, selectedModel, aspectRatio, duration, resolution, isGenerating, referenceImages]);

  const handleCancel = () => { abortRef.current?.abort(); setIsGenerating(false); setProgress(0); setStatusMessage(''); };

  /** 进入工作室：将当前视频作为第一段 */
  const enterStudio = () => {
    const initData = currentVideo ? JSON.stringify([{ id: Date.now().toString(), prompt: prompt.trim(), videoUrl: currentVideo, duration, model: selectedModel, aspectRatio, resolution }]) : null;
    if (initData) sessionStorage.setItem('studio_init', initData);
    navigate('/app/video/studio');
  };

  return (
    <div className="flex h-full">
      {/* 左栏 */}
      <div className="w-full lg:w-[320px] shrink-0 h-fit lg:h-full lg:overflow-y-auto border-r border-white/5 bg-black [&::-webkit-scrollbar]:hidden" style={{ scrollbarWidth: 'none' }}>
        <div className="p-6 flex flex-col min-h-full">
          <h2 className="text-xl font-semibold text-white mb-6 flex items-center gap-3">
            <Video className="w-6 h-6 text-indigo-400" /> 视频生成
          </h2>
          <div className="mb-6">
            <label className="block text-xs font-semibold text-zinc-400 mb-3 uppercase tracking-wider">生成模型</label>
            <div className="space-y-2">
              {models.map((m) => (
                <button key={m.id} onClick={() => setSelectedModel(m.id)}
                  className={`w-full text-left px-4 py-3 rounded-xl border transition-all ${selectedModel === m.id ? 'border-indigo-500/50 bg-indigo-500/10' : 'border-white/5 bg-white/[0.02] hover:border-white/10'}`}>
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium text-white">{m.name}</p>
                    {selectedModel === m.id && <div className="w-5 h-5 rounded-full bg-indigo-500 flex items-center justify-center shrink-0"><Check className="w-3 h-3 text-white" /></div>}
                  </div>
                  <p className="text-xs text-zinc-500 mt-1">{m.description}</p>
                </button>
              ))}
              <div className="p-4 rounded-xl border border-dashed border-white/5 opacity-40 mt-4">
                <p className="text-sm text-zinc-600 mb-1">更多模型</p><p className="text-xs text-zinc-700">即将支持...</p>
              </div>
            </div>
          </div>
          {/* 工作室入口 */}
          <button onClick={() => navigate('/app/video/studio')}
            className="w-full mt-auto flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-gradient-to-r from-indigo-600/20 to-purple-600/20 border border-indigo-500/20 hover:border-indigo-500/40 text-indigo-300 text-sm transition-all hover:from-indigo-600/30 hover:to-purple-600/30">
            <Film className="w-4 h-4" /> 分镜工作室
          </button>
        </div>
      </div>

      {/* 右栏 */}
      <div className="flex-1 flex flex-col min-w-0 relative">
        <div className="flex-1 flex items-center justify-center p-6 pb-40 overflow-y-auto [&::-webkit-scrollbar]:hidden" style={{ msOverflowStyle: 'none', scrollbarWidth: 'none' }}>
          {isGenerating ? (
            <div className="text-center max-w-sm">
              <div className="relative w-32 h-32 mx-auto mb-6">
                <svg className="w-32 h-32 -rotate-90" viewBox="0 0 120 120">
                  <circle cx="60" cy="60" r="52" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="6" />
                  <circle cx="60" cy="60" r="52" fill="none" stroke="url(#pg)" strokeWidth="6" strokeLinecap="round"
                    strokeDasharray={`${2 * Math.PI * 52}`} strokeDashoffset={`${2 * Math.PI * 52 * (1 - progress / 100)}`} className="transition-all duration-500" />
                  <defs><linearGradient id="pg" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stopColor="#6366f1" /><stop offset="100%" stopColor="#a855f7" /></linearGradient></defs>
                </svg>
                <div className="absolute inset-0 flex items-center justify-center"><span className="text-2xl font-bold text-white">{progress}%</span></div>
              </div>
              <p className="text-sm text-zinc-400 mb-3">{statusMessage}</p>
              <button onClick={handleCancel} className="text-xs text-zinc-500 hover:text-red-400 transition-colors flex items-center gap-1.5 mx-auto"><Square className="w-3 h-3" /> 取消</button>
            </div>
          ) : currentVideo ? (
            <div className="w-full max-w-2xl">
              <video src={currentVideo} controls autoPlay className="w-full rounded-2xl shadow-2xl shadow-black/50 bg-black" />
              <div className="flex items-center justify-center gap-3 mt-4 flex-wrap">
                <a href={currentVideo} target="_blank" rel="noopener noreferrer" download className="flex items-center gap-2 px-4 py-2 bg-white/5 hover:bg-white/10 rounded-xl text-xs text-zinc-300 transition-colors">
                  <Download className="w-3.5 h-3.5" /> 下载视频
                </a>
                <button onClick={enterStudio}
                  className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-indigo-600/20 to-purple-600/20 hover:from-indigo-600/30 hover:to-purple-600/30 border border-indigo-500/20 hover:border-indigo-500/40 rounded-xl text-xs text-indigo-300 transition-all">
                  <Film className="w-3.5 h-3.5" /> 进入工作室续写
                </button>
                <button onClick={() => { setCurrentVideo(null); setPrompt(''); }}
                  className="flex items-center gap-2 px-4 py-2 bg-white/5 hover:bg-white/10 rounded-xl text-xs text-zinc-300 transition-colors">
                  新建生成
                </button>
              </div>
            </div>
          ) : (
            <div className="text-center">
              <div className="w-20 h-20 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-indigo-500/10 to-purple-500/10 border border-white/5 flex items-center justify-center">
                <Sparkles className="w-8 h-8 text-indigo-400/60" />
              </div>
              <p className="text-sm text-zinc-500 mb-1">输入描述，生成AI视频</p>
              <p className="text-[11px] text-zinc-700">支持 6-30 秒视频 · 多种比例 · 多种分辨率</p>
            </div>
          )}
        </div>

        {error && (
          <div className="absolute bottom-[180px] left-4 right-4 z-10 px-4 py-2.5 bg-red-500/10 border border-red-500/20 rounded-xl text-sm text-red-400 flex items-center gap-2 backdrop-blur-sm">
            <AlertCircle className="w-4 h-4 shrink-0" /><span className="flex-1">{error}</span>
            <button onClick={() => setError(null)} className="text-red-500/60 hover:text-red-400 text-xs">✕</button>
          </div>
        )}

        {/* 悬浮输入区 */}
        <div className="absolute bottom-0 left-0 right-0 z-10">
          <div className="bg-gradient-to-t from-[#0c0c0c] via-[#0c0c0c]/95 to-transparent pt-8 px-6 pb-5">
            <div className="max-w-3xl mx-auto">
              {/* 工具栏 */}
              <div className="flex items-center gap-2 mb-3 flex-wrap">
                <CustomSelect value={aspectRatio} onChange={setAspectRatio} options={ASPECT_RATIOS} />
                <CustomSelect value={duration} onChange={(v: number) => setDuration(v)} options={DURATIONS} />
                <CustomSelect value={resolution} onChange={setResolution} options={RESOLUTIONS} />
                <button onClick={() => fileInputRef.current?.click()} className="flex items-center gap-1.5 bg-white/[0.04] hover:bg-white/[0.08] rounded-lg px-2.5 py-1.5 text-[11px] text-zinc-300 transition-colors border border-white/5 hover:border-white/10">
                  <Upload className="w-3 h-3 text-indigo-400" /> 参考图 ({referenceImages.length}/{MAX_REFS})
                </button>
                <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => { handleFileSelect(e.target.files); e.target.value = ''; }} />
              </div>
              {/* 输入容器 */}
              <div className="relative bg-white/[0.04] border border-white/[0.08] focus-within:border-indigo-500/30 rounded-2xl transition-all shadow-2xl shadow-black/30">
                {referenceImages.length > 0 && (
                  <div className="flex items-center gap-2 px-4 pt-3 pb-1">
                    {referenceImages.map((img, idx) => (
                      <div key={idx} className="relative w-12 h-12 rounded-lg overflow-hidden border border-white/10 group cursor-pointer shrink-0 hover:border-indigo-500/30 transition-colors">
                        <img src={img} alt="" className="w-full h-full object-cover" />
                        <button onClick={() => setReferenceImages(prev => prev.filter((_, i) => i !== idx))}
                          className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"><X className="w-3.5 h-3.5 text-white" /></button>
                      </div>
                    ))}
                  </div>
                )}
                <textarea ref={textareaRef} value={prompt} onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleGenerate(); } }}
                  placeholder="描述你想生成的视频内容..." rows={3}
                  className="w-full bg-transparent px-4 py-3 pr-16 text-sm text-white focus:outline-none placeholder:text-zinc-600 resize-none [&::-webkit-scrollbar]:hidden" style={{ msOverflowStyle: 'none', scrollbarWidth: 'none' } as React.CSSProperties} />
                {/* 圆形发送按钮 */}
                <button onClick={isGenerating ? handleCancel : handleGenerate} disabled={!prompt.trim() && !isGenerating}
                  className={`absolute right-3 bottom-3 w-10 h-10 rounded-full flex items-center justify-center transition-all ${isGenerating ? 'bg-red-500/20 text-red-300 hover:bg-red-500/30 border border-red-500/20' : 'bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white shadow-lg shadow-indigo-500/20 disabled:opacity-30 disabled:cursor-not-allowed'}`}>
                  {isGenerating ? <Square className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

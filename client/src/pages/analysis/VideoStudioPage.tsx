import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Film, Play, Square, Download, Loader2, AlertCircle, ArrowLeft, Plus, Trash2, FastForward, Upload, X, Pause, SkipForward, PackageOpen, Scissors, HelpCircle } from 'lucide-react';
import { fetchVideoModels, generateVideo, type VideoModel, type VideoSSEEvent } from '../../api/video';
import ImageSlicerModal from '../../components/ImageSlicerModal';
import { useImageDropPaste } from '../../hooks/useImageDropPaste';
import { useAuthGuard } from '../../hooks/useAuthGuard';

interface Segment { id: string; prompt: string; videoUrl: string; duration: number; model: string; lastFrame?: string; }
interface Project { id: string; name: string; segments: Segment[]; aspectRatio: string; resolution: string; createdAt: number; }

function CustomSelect({ value, options, onChange }: { value: any; options: { value: any; label: string }[]; onChange: (v: any) => void }) {
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setIsOpen(false); };
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h);
  }, []);
  const selected = options.find((o) => o.value === value);
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setIsOpen(!isOpen)}
        className={`flex items-center gap-2 bg-white/[0.03] hover:bg-white/[0.05] rounded-lg px-2 py-1.5 text-[11px] text-zinc-300 transition-colors border ${isOpen ? 'border-indigo-500/30' : 'border-white/5'}`}>
        {selected?.label || value}
        <svg className={`w-3 h-3 text-zinc-500 transition-transform ${isOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
      </button>
      {isOpen && (
        <div className="absolute bottom-full left-0 mb-2 min-w-full w-max bg-[#1a1a1a] border border-white/10 rounded-xl shadow-2xl p-1 z-50 flex flex-col max-h-[240px] overflow-y-auto [&::-webkit-scrollbar]:hidden" style={{ scrollbarWidth: 'none' }}>
          {options.map((o) => (
            <button key={o.value} onClick={() => { onChange(o.value); setIsOpen(false); }}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-left text-[11px] transition-colors ${value === o.value ? 'bg-indigo-500/20 text-indigo-300' : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/5'}`}>
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const STORAGE_KEY = 'video_studio_projects';
const loadProjects = (): Project[] => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; } };
const saveProjects = (p: Project[]) => localStorage.setItem(STORAGE_KEY, JSON.stringify(p));

function captureLastFrame(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.crossOrigin = 'anonymous'; v.preload = 'auto'; v.muted = true;
    v.onloadedmetadata = () => { v.currentTime = Math.max(0, v.duration - 0.1); };
    v.onseeked = () => {
      try { const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
        c.getContext('2d')!.drawImage(v, 0, 0); resolve(c.toDataURL('image/jpeg', 0.8));
      } catch (e) { reject(e); }
    };
    v.onerror = () => reject(new Error('加载失败'));
    setTimeout(() => reject(new Error('超时')), 15000);
    v.src = url; v.load();
  });
}

const DURATIONS = [{ value: 6, label: '6s' }, { value: 10, label: '10s' }, { value: 16, label: '16s' }, { value: 20, label: '20s' }];

const getMaxReferenceImages = (modelId: string, models: VideoModel[]) => {
  if (modelId === 'sdas-d7-seedance-2.0-face-720p') return 99;
  if (modelId.startsWith('sd-') || modelId.includes('sdas-') || modelId.startsWith('lg-')) return 9;
  if (modelId === 'seedance-2.0-fast' || modelId === 'seedance-2.0' || modelId === 'sora-v4-fast' || modelId === 'sora-v4-pro') return 4;
  if (modelId === 'omni-flash') return 7;
  if (modelId === 'omni-flash-vref') return 5;
  const model = models.find(m => m.id === modelId);
  if (model?.requireRef) return 1;
  return 5;
};

export default function VideoStudioPage() {
  const navigate = useNavigate();
  const guard = useAuthGuard();
  const [models, setModels] = useState<VideoModel[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [projects, setProjects] = useState<Project[]>(loadProjects);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [duration, setDuration] = useState(6);
  const [referenceImages, setReferenceImages] = useState<string[]>([]);
  const maxRefs = getMaxReferenceImages(selectedModel, models);

  useEffect(() => {
    if (referenceImages.length > maxRefs) {
      setReferenceImages(prev => prev.slice(0, maxRefs));
    }
  }, [selectedModel, maxRefs]);
  
  // 切分分镜拼图相关状态
  const [slicingImageUrl, setSlicingImageUrl] = useState<string | null>(null);
  const [slicingImageIndex, setSlicingImageIndex] = useState<number | null>(null);

  const handleConfirmSlice = (sliced: string[]) => {
    if (slicingImageIndex !== null) {
      setReferenceImages(prev => {
        const next = [...prev];
        next.splice(slicingImageIndex, 1, ...sliced);
        return next.slice(0, maxRefs);
      });
    }
    setSlicingImageUrl(null);
    setSlicingImageIndex(null);
  };

  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusMsg, setStatusMsg] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [playingIdx, setPlayingIdx] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isExtendMode, setIsExtendMode] = useState(false);
  const [merging, setMerging] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const project = projects.find(p => p.id === activeProjectId) || null;
  const segments = project?.segments || [];
  const totalDur = segments.reduce((s, seg) => s + seg.duration, 0);

  useEffect(() => { fetchVideoModels().then(m => { setModels(m); if (m.length > 0) setSelectedModel(m[0].id); }).catch(() => {}); }, []);

  const readFileAsDataURL = (file: File): Promise<string> =>
    new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result as string); r.onerror = reject; r.readAsDataURL(file); });

  const handleFileSelect = async (files: FileList | null) => {
    if (!files) return;
    const remaining = maxRefs - referenceImages.length;
    if (remaining <= 0) { setError(`当前模型最多支持 ${maxRefs} 张参考图`); return; }
    const valid = Array.from(files).filter(f => f.type.startsWith('image/')).slice(0, remaining);
    if (valid.length === 0) return;
    if (valid.find(f => f.size > 20 * 1024 * 1024)) { setError('参考图超过 20MB'); return; }
    try { const urls = await Promise.all(valid.map(readFileAsDataURL)); setReferenceImages(prev => [...prev, ...urls]); }
    catch { setError('图片读取失败'); }
  };

  // 全局拖拽 + Ctrl+V 粘贴上传参考图
  useImageDropPaste(handleFileSelect);

  // 初始化：从 sessionStorage 读取 VideoPage 传来的首段
  useEffect(() => {
    const init = sessionStorage.getItem('studio_init');
    if (init) {
      sessionStorage.removeItem('studio_init');
      try {
        const segs = JSON.parse(init) as any[];
        const p: Project = { id: Date.now().toString(), name: `项目 ${projects.length + 1}`, segments: segs.map(s => ({ id: s.id, prompt: s.prompt, videoUrl: s.videoUrl, duration: s.duration, model: s.model || '' })), aspectRatio: segs[0]?.aspectRatio || '16:9', resolution: segs[0]?.resolution || '720p', createdAt: Date.now() };
        const updated = [p, ...projects];
        setProjects(updated); saveProjects(updated); setActiveProjectId(p.id);
      } catch {}
    }
  }, []);

  useEffect(() => { saveProjects(projects); }, [projects]);

  const updateProject = (fn: (p: Project) => Project) => {
    if (!activeProjectId) return;
    setProjects(prev => prev.map(p => p.id === activeProjectId ? fn(p) : p));
  };

  const createProject = () => {
    const p: Project = { id: Date.now().toString(), name: `项目 ${projects.length + 1}`, segments: [], aspectRatio: '16:9', resolution: '720p', createdAt: Date.now() };
    setProjects(prev => [p, ...prev]); setActiveProjectId(p.id); setIsExtendMode(false); setReferenceImages([]); setPrompt('');
  };

  const deleteProject = (id: string) => {
    setProjects(prev => prev.filter(p => p.id !== id));
    if (activeProjectId === id) setActiveProjectId(null);
  };

  const handleGenerate = useCallback(() => {
    if (!prompt.trim() || isGenerating) return;
    if (!guard()) return;
    if (!activeProjectId) { createProject(); return; }
    setIsGenerating(true); setProgress(0); setError(null); setStatusMsg(isExtendMode ? '续写生成中...' : '生成中...');
    const ctrl = generateVideo(
      { prompt: prompt.trim(), model: selectedModel, aspect_ratio: project?.aspectRatio || '16:9', video_length: duration, resolution: project?.resolution || '720p', reference_images: referenceImages.length > 0 ? referenceImages : undefined },
      (ev: VideoSSEEvent) => {
        switch (ev.type) {
          case 'status': setStatusMsg(ev.message || ''); break;
          case 'progress': setProgress(ev.progress || 0); setStatusMsg(`生成中 ${ev.progress}%`); break;
          case 'complete':
            setIsGenerating(false); setProgress(100); setStatusMsg('');
            if (ev.videoUrl) {
              const seg: Segment = { id: Date.now().toString(), prompt: prompt.trim(), videoUrl: ev.videoUrl, duration, model: selectedModel };
              updateProject(p => ({ ...p, segments: [...p.segments, seg] }));
              setPlayingIdx(segments.length);
              setPrompt(''); setReferenceImages([]); setIsExtendMode(false);
            }
            break;
          case 'error': setError(ev.message || '失败'); setIsGenerating(false); setStatusMsg(''); break;
        }
      },
    );
    abortRef.current = ctrl;
  }, [prompt, selectedModel, duration, isGenerating, referenceImages, activeProjectId, project, isExtendMode, segments.length]);

  const startExtend = useCallback(async () => {
    const last = segments[segments.length - 1];
    if (!last) return;
    setStatusMsg('截取最后一帧...');
    try {
      const frame = await captureLastFrame(last.videoUrl);
      updateProject(p => ({ ...p, segments: p.segments.map((s, i) => i === p.segments.length - 1 ? { ...s, lastFrame: frame } : s) }));
      setReferenceImages([frame]); setIsExtendMode(true); setPrompt(''); setStatusMsg('');
    } catch { setError('截帧失败，请手动上传参考图'); setIsExtendMode(true); setReferenceImages([]); setStatusMsg(''); }
  }, [segments]);

  const deleteSeg = (idx: number) => {
    updateProject(p => ({ ...p, segments: p.segments.filter((_, i) => i !== idx) }));
    if (playingIdx >= segments.length - 1) setPlayingIdx(Math.max(0, segments.length - 2));
  };

  // 连续播放
  const handleEnded = () => {
    if (playingIdx < segments.length - 1) { setPlayingIdx(prev => prev + 1); }
    else { setIsPlaying(false); }
  };

  const playAll = () => { setPlayingIdx(0); setIsPlaying(true); };

  useEffect(() => {
    if (videoRef.current && segments[playingIdx]) {
      videoRef.current.src = segments[playingIdx].videoUrl;
      if (isPlaying) videoRef.current.play().catch(() => {});
    }
  }, [playingIdx, segments]);

  // 合并导出
  const handleMerge = async () => {
    if (segments.length < 2) return;
    setMerging(true); setError(null);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch('/api/video/merge', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ urls: segments.map(s => s.videoUrl) }),
      });
      if (!res.ok) throw new Error(await res.text());
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = `${project?.name || 'video'}_merged.mp4`; a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) { setError(`合并失败: ${e.message}`); }
    setMerging(false);
  };

  // ═══ 项目列表视图 ═══
  if (!activeProjectId) {
    return (
      <div className="h-screen flex flex-col bg-black">
        <div className="border-b border-white/5 px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate('/app/video')} className="text-zinc-500 hover:text-white transition-colors"><ArrowLeft className="w-5 h-5" /></button>
            <h1 className="text-lg font-semibold text-white flex items-center gap-2"><Film className="w-5 h-5 text-indigo-400" /> 分镜工作室</h1>
          </div>
          <button onClick={createProject} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 rounded-xl text-sm text-white transition-colors"><Plus className="w-4 h-4" /> 新建项目</button>
        </div>
        <div className="flex-1 overflow-y-auto p-6">
          {projects.length === 0 ? (
            <div className="text-center mt-20">
              <Film className="w-16 h-16 text-zinc-800 mx-auto mb-4" />
              <p className="text-zinc-500 mb-2">暂无项目</p>
              <p className="text-zinc-700 text-sm mb-6">创建一个新项目开始分镜制作</p>
              <button onClick={createProject} className="px-6 py-3 bg-indigo-600 hover:bg-indigo-500 rounded-xl text-white text-sm transition-colors"><Plus className="w-4 h-4 inline mr-2" />新建项目</button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 max-w-4xl mx-auto">
              {projects.map(p => (
                <div key={p.id} className="bg-white/[0.02] border border-white/5 rounded-2xl p-4 hover:border-indigo-500/30 transition-all cursor-pointer group" onClick={() => setActiveProjectId(p.id)}>
                  {/* 缩略图 */}
                  <div className="aspect-video bg-black/50 rounded-xl mb-3 overflow-hidden flex items-center justify-center">
                    {p.segments[0]?.lastFrame ? <img src={p.segments[0].lastFrame} className="w-full h-full object-cover" /> :
                      p.segments.length > 0 ? <Film className="w-8 h-8 text-zinc-700" /> : <Plus className="w-8 h-8 text-zinc-800" />}
                  </div>
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-white">{p.name}</p>
                      <p className="text-[11px] text-zinc-600 mt-0.5">{p.segments.length} 段 · {p.segments.reduce((s, seg) => s + seg.duration, 0)}秒</p>
                    </div>
                    <button onClick={(e) => { e.stopPropagation(); deleteProject(p.id); }} className="opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-red-400 transition-all p-1"><Trash2 className="w-3.5 h-3.5" /></button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ═══ 工作室视图 ═══
  return (
    <div className="h-screen flex flex-col bg-black">
      {/* 顶栏 */}
      <div className="border-b border-white/5 px-4 py-3 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <button onClick={() => setActiveProjectId(null)} className="text-zinc-500 hover:text-white transition-colors"><ArrowLeft className="w-5 h-5" /></button>
          <h1 className="text-sm font-semibold text-white">{project?.name}</h1>
          <span className="text-[11px] text-zinc-600">{segments.length} 段 · {totalDur}秒</span>
        </div>
        <div className="flex items-center gap-2">
          {segments.length >= 2 && (
            <button onClick={handleMerge} disabled={merging} className="flex items-center gap-1.5 px-3 py-1.5 bg-white/5 hover:bg-white/10 rounded-lg text-[11px] text-zinc-300 transition-colors disabled:opacity-40">
              {merging ? <Loader2 className="w-3 h-3 animate-spin" /> : <PackageOpen className="w-3 h-3" />} {merging ? '合并中...' : '合并导出'}
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 flex min-h-0">
        {/* 左：预览 */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex-1 flex items-center justify-center p-4 bg-zinc-950">
            {isGenerating ? (
              <div className="text-center">
                <div className="relative w-28 h-28 mx-auto mb-4">
                  <svg className="w-28 h-28 -rotate-90" viewBox="0 0 120 120">
                    <circle cx="60" cy="60" r="52" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="6" />
                    <circle cx="60" cy="60" r="52" fill="none" stroke="url(#spg)" strokeWidth="6" strokeLinecap="round"
                      strokeDasharray={`${2*Math.PI*52}`} strokeDashoffset={`${2*Math.PI*52*(1-progress/100)}`} className="transition-all duration-500"/>
                    <defs><linearGradient id="spg" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stopColor="#6366f1"/><stop offset="100%" stopColor="#a855f7"/></linearGradient></defs>
                  </svg>
                  <div className="absolute inset-0 flex items-center justify-center"><span className="text-xl font-bold text-white">{progress}%</span></div>
                </div>
                <p className="text-xs text-zinc-400 mb-2">{statusMsg}</p>
                <button onClick={() => { abortRef.current?.abort(); setIsGenerating(false); }} className="text-[11px] text-zinc-500 hover:text-red-400"><Square className="w-3 h-3 inline mr-1"/>取消</button>
              </div>
            ) : segments.length > 0 ? (
              <div className="w-full max-w-3xl">
                <video ref={videoRef} controls className="w-full rounded-xl bg-black shadow-2xl"
                  onEnded={handleEnded} onPlay={() => setIsPlaying(true)} onPause={() => setIsPlaying(false)} />
              </div>
            ) : (
              <div className="text-center">
                <Film className="w-12 h-12 text-zinc-800 mx-auto mb-3" />
                <p className="text-sm text-zinc-600">输入第一段分镜描述开始创作</p>
              </div>
            )}
          </div>

          {/* 时间线轨道 */}
          {segments.length > 0 && (
            <div className="border-t border-white/5 px-4 py-3 bg-black/80 shrink-0">
              <div className="flex items-center gap-3 mb-2">
                <button onClick={playAll} className="flex items-center gap-1 text-[11px] text-indigo-400 hover:text-indigo-300">
                  <Play className="w-3 h-3" /> 连播
                </button>
                <span className="text-[10px] text-zinc-600">
                  第 {playingIdx + 1}/{segments.length} 段 · {totalDur}秒
                </span>
              </div>
              <div className="flex gap-1 h-8">
                {segments.map((seg, i) => (
                  <button key={seg.id} onClick={() => { setPlayingIdx(i); setIsPlaying(true); }}
                    style={{ flex: seg.duration }}
                    className={`rounded-lg text-[9px] font-medium transition-all truncate px-2 ${i === playingIdx ? 'bg-indigo-500/30 text-indigo-300 border border-indigo-500/50' : 'bg-white/[0.03] text-zinc-500 border border-white/5 hover:bg-white/[0.06]'}`}>
                    {i + 1}. {seg.prompt.slice(0, 12)}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 错误 */}
          {error && (
            <div className="mx-4 mb-2 px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400 flex items-center gap-2">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" /><span className="flex-1">{error}</span>
              <button onClick={() => setError(null)} className="text-red-500/60 hover:text-red-400">✕</button>
            </div>
          )}

          {/* 续写提示 */}
          {isExtendMode && !isGenerating && (
            <div className="mx-4 mb-2 px-3 py-2 bg-indigo-500/10 border border-indigo-500/20 rounded-lg flex items-center gap-2">
              <FastForward className="w-3.5 h-3.5 text-indigo-400" />
              <span className="text-[11px] text-indigo-300 flex-1">续写第 {segments.length + 1} 段 · 已截取上一帧</span>
              <button onClick={() => { setIsExtendMode(false); setReferenceImages([]); }} className="text-[10px] text-indigo-400/60 hover:text-indigo-300">取消</button>
            </div>
          )}

          {/* 输入区 */}
          <div className="border-t border-white/5 p-3 shrink-0 bg-black/60">
            <div className="max-w-3xl mx-auto">
            <div className="flex items-center gap-2 mb-2">
              <CustomSelect value={duration} onChange={(v: number) => setDuration(v)} options={DURATIONS} />
              {models.length > 0 && (
                <CustomSelect value={selectedModel} onChange={(v: string) => setSelectedModel(v)} options={models.map(m => ({ value: m.id, label: m.name }))} />
              )}
              <button onClick={() => fileRef.current?.click()} className="flex items-center gap-1 bg-white/[0.03] hover:bg-white/[0.05] rounded-lg px-2 py-1.5 text-[11px] text-zinc-300 border border-transparent hover:border-white/10">
                <Upload className="w-3 h-3 text-indigo-400" /> 参考图 ({referenceImages.length}/{maxRefs})
              </button>
              <div className="group relative flex items-center">
                <HelpCircle className="w-3.5 h-3.5 text-zinc-500 hover:text-zinc-300 transition-colors cursor-help" />
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 p-3 bg-zinc-950 border border-white/10 rounded-xl shadow-2xl text-[10px] text-zinc-400 leading-normal pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity z-50">
                  <p className="font-semibold text-yellow-400 mb-1 flex items-center gap-1">⚠️ 避免使用多格拼图</p>
                  为了保证视频连贯性，请勿直接使用九宫格或多格拼图。点击参考图上的 <Scissors className="w-3 h-3 inline text-indigo-400" /> 剪刀按钮即可将其切分为单张画面。
                </div>
              </div>
              <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => { handleFileSelect(e.target.files); e.target.value = ''; }} />
            </div>
            {referenceImages.length > 0 && (
              <div className="flex items-center gap-1.5 mb-2 flex-wrap">
                {referenceImages.map((img, i) => (
                  <div key={i} className="relative w-10 h-10 rounded overflow-hidden border border-white/10 group">
                    <img src={img} className="w-full h-full object-cover" />
                    {isExtendMode && i === 0 && <div className="absolute top-0 left-0 bg-indigo-500 text-[7px] text-white px-0.5 rounded-br z-10">帧</div>}
                    <div className="absolute inset-0 bg-black/70 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-0.5">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSlicingImageUrl(img);
                          setSlicingImageIndex(i);
                        }}
                        className="bg-indigo-600 hover:bg-indigo-500 p-0.5 rounded transition-colors"
                        title="智能切分拼图"
                      >
                        <Scissors className="w-2.5 h-2.5 text-white" />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setReferenceImages(prev => prev.filter((_, idx) => idx !== i));
                        }}
                        className="bg-red-500/80 hover:bg-red-500 p-0.5 rounded transition-colors"
                        title="删除"
                      >
                        <X className="w-2.5 h-2.5 text-white" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="flex gap-2 items-end">
              <textarea value={prompt} onChange={e => setPrompt(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleGenerate(); } }}
                placeholder={isExtendMode ? '描述下一段动作或场景...' : segments.length > 0 ? '添加下一段分镜...' : '描述第一段分镜...'}
                rows={2} className="flex-1 bg-white/[0.03] border border-white/5 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-indigo-500/30 placeholder:text-zinc-600 resize-none" />
              <button onClick={isGenerating ? () => { abortRef.current?.abort(); setIsGenerating(false); } : handleGenerate} disabled={!prompt.trim() && !isGenerating}
                className={`shrink-0 h-[44px] px-5 rounded-xl font-medium text-sm flex items-center gap-2 transition-all ${isGenerating ? 'bg-red-500/20 text-red-300' : 'bg-gradient-to-r from-indigo-600 to-purple-600 text-white disabled:opacity-40'}`}>
                {isGenerating ? <><Loader2 className="w-4 h-4 animate-spin"/>停止</> : isExtendMode ? <><FastForward className="w-4 h-4"/>续写</> : <><Play className="w-4 h-4"/>生成</>}
              </button>
            </div>
            </div>
          </div>
        </div>

        {/* 右：分镜面板 */}
        <div className="w-[280px] shrink-0 border-l border-white/5 bg-black flex flex-col">
          <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between">
            <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">分镜列表</span>
            <span className="text-[10px] text-zinc-600">{segments.length} 段</span>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-2 [&::-webkit-scrollbar]:hidden" style={{scrollbarWidth:'none'}}>
            {segments.map((seg, i) => (
              <div key={seg.id} onClick={() => { setPlayingIdx(i); setIsPlaying(true); }}
                className={`rounded-xl border p-3 cursor-pointer transition-all group ${i === playingIdx ? 'border-indigo-500/50 bg-indigo-500/10' : 'border-white/5 bg-white/[0.02] hover:border-white/10'}`}>
                <div className="flex items-start gap-2">
                  <div className={`w-6 h-6 rounded-lg flex items-center justify-center text-[10px] font-bold shrink-0 ${i === playingIdx ? 'bg-indigo-500 text-white' : 'bg-white/5 text-zinc-500'}`}>{i + 1}</div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] text-zinc-300 leading-relaxed line-clamp-2">{seg.prompt}</p>
                    <p className="text-[10px] text-zinc-600 mt-1">{seg.duration}秒 · {seg.model.split('-').pop()}</p>
                  </div>
                  {seg.lastFrame && <img src={seg.lastFrame} className="w-10 h-7 rounded object-cover shrink-0 border border-white/5" />}
                </div>
                <div className="flex items-center gap-1.5 mt-2 opacity-0 group-hover:opacity-100 transition-opacity">
                  <a href={`/api/video/download?url=${encodeURIComponent(seg.videoUrl)}&filename=segment_${i + 1}.mp4`} download className="text-[10px] text-zinc-500 hover:text-zinc-300 flex items-center gap-0.5"><Download className="w-3 h-3"/>下载</a>
                  <button onClick={(e) => { e.stopPropagation(); deleteSeg(i); }} className="text-[10px] text-zinc-500 hover:text-red-400 flex items-center gap-0.5 ml-auto"><Trash2 className="w-3 h-3"/>删除</button>
                </div>
              </div>
            ))}
            {/* 添加分镜按钮 */}
            {segments.length > 0 && !isExtendMode && !isGenerating && (
              <button onClick={startExtend} className="w-full py-3 rounded-xl border border-dashed border-indigo-500/20 text-[11px] text-indigo-400/70 hover:text-indigo-300 hover:border-indigo-500/40 hover:bg-indigo-500/5 transition-all flex items-center justify-center gap-1.5">
                <FastForward className="w-3.5 h-3.5" /> 续写下一段
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 切图模态框 */}
      {slicingImageUrl && (
        <ImageSlicerModal
          imageUrl={slicingImageUrl}
          onClose={() => { setSlicingImageUrl(null); setSlicingImageIndex(null); }}
          onConfirm={handleConfirmSlice}
        />
      )}
    </div>
  );
}

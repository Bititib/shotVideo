import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Video, Play, Square, Download, Loader2, Check, AlertCircle, Sparkles, Monitor, Smartphone, RectangleHorizontal, Upload, X, Film, RotateCcw } from 'lucide-react';
import { fetchVideoModels, generateVideo, type VideoModel, type VideoSSEEvent } from '../../api/video';
import { contentApi } from '../../api/content';
import { useImageDropPaste } from '../../hooks/useImageDropPaste';
import { useAuthGuard } from '../../hooks/useAuthGuard';

interface VideoTask {
  id: string;
  prompt: string;
  status: 'generating' | 'complete' | 'error';
  progress: number;
  statusMessage: string;
  videoUrl: string | null;
  error: string | null;
  metadata: { resolution: string; seconds: number; aspect_ratio: string; model: string };
  createdAt: string;
}

const ALL_ASPECT_RATIOS = [
  { value: '16:9', label: '16:9', icon: RectangleHorizontal },
  { value: '9:16', label: '9:16', icon: Smartphone },
  { value: '1:1', label: '1:1', icon: Monitor },
  { value: '4:3', label: '4:3', icon: RectangleHorizontal },
  { value: '3:4', label: '3:4', icon: Smartphone },
  { value: '3:2', label: '3:2', icon: RectangleHorizontal },
  { value: '2:3', label: '2:3', icon: Smartphone },
  { value: '21:9', label: '21:9', icon: RectangleHorizontal },
];
const ALL_DURATIONS = [
  { value: 6, label: '6 秒' }, { value: 10, label: '10 秒' },
  { value: 12, label: '12 秒' }, { value: 16, label: '16 秒' },
  { value: 20, label: '20 秒' }, { value: 30, label: '30 秒' },
];
const MAX_REFS = 10;

/** 将比例字符串转换为 CSS aspect-ratio 数值 */
const ASPECT_RATIO_CSS: Record<string, string> = {
  '16:9': '16/9',
  '9:16': '9/16',
  '1:1': '1/1',
  '4:3': '4/3',
  '3:4': '3/4',
  '3:2': '3/2',
  '2:3': '2/3',
  '21:9': '21/9',
};
const getAspectStyle = (ratio?: string) => {
  const css = ratio ? ASPECT_RATIO_CSS[ratio] : undefined;
  return css ? { aspectRatio: css } : undefined;
};
/** 竖屏比例需要限制卡片最大宽度，避免太高 */
const isVertical = (ratio?: string) => ['9:16', '3:4', '2:3'].includes(ratio || '');

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
  const [referenceVideo, setReferenceVideo] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoFileInputRef = useRef<HTMLInputElement>(null);
  const [tasks, setTasks] = useState<VideoTask[]>([]);
  const [history, setHistory] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<Map<string, AbortController>>(new Map());
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isGenerating = tasks.some(t => t.status === 'generating');
  const [playingVideo, setPlayingVideo] = useState<{ url: string; prompt: string } | null>(null);

  useEffect(() => {
    fetchVideoModels().then((m) => { setModels(m); if (m.length > 0 && !selectedModel) setSelectedModel(m[0].id); }).catch(() => {});
    
    // 加载历史生成记录
    contentApi.getMyContents({ type: 'video', pageSize: 50 })
      .then((res: any) => {
        const items = res?.items || res?.data || [];
        setHistory(items.filter((item: any) => item.resultUrl));
      })
      .catch(() => {});
  }, []);

  // 当选中模型变化时，动态调整可选时长与分辨率
  const currentModel = models.find(m => m.id === selectedModel);
  const DURATIONS = currentModel?.allowedSeconds
    ? ALL_DURATIONS.filter(d => currentModel.allowedSeconds!.includes(d.value))
    : ALL_DURATIONS;

  const isOmniModel = selectedModel.startsWith('omni-flash');
  const RESOLUTIONS = isOmniModel
    ? [{ value: '720p', label: '720p' }, { value: '1080p', label: '1080p' }]
    : [{ value: '480p', label: '480p' }, { value: '720p', label: '720p' }];

  const ASPECT_RATIOS = isOmniModel
    ? [
        { value: '16:9', label: '16:9', icon: RectangleHorizontal },
        { value: '9:16', label: '9:16', icon: Smartphone },
      ]
    : ALL_ASPECT_RATIOS;

  useEffect(() => {
    if (currentModel?.allowedSeconds && !currentModel.allowedSeconds.includes(duration)) {
      setDuration(currentModel.allowedSeconds[0]);
    }
    if (isOmniModel) {
      if (resolution !== '720p' && resolution !== '1080p') {
        setResolution('720p');
      }
      if (aspectRatio !== '16:9' && aspectRatio !== '9:16') {
        setAspectRatio('16:9');
      }
    } else {
      if (resolution !== '480p' && resolution !== '720p') {
        setResolution('720p');
      }
    }
  }, [selectedModel]);

  /** 压缩参考图：缩放到 maxSize 并转为 JPEG base64，避免请求体过大 */
  const compressImage = (file: File, maxSize = 768, quality = 0.7): Promise<string> =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxSize || height > maxSize) {
          const scale = maxSize / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
        URL.revokeObjectURL(img.src);
      };
      img.onerror = () => { URL.revokeObjectURL(img.src); reject(new Error('图片加载失败')); };
      img.src = URL.createObjectURL(file);
    });

  const handleFileSelect = async (files: FileList | null) => {
    if (!files) return;
    const remaining = MAX_REFS - referenceImages.length;
    if (remaining <= 0) { setError(`最多 ${MAX_REFS} 张参考图`); return; }
    const valid = Array.from(files).filter(f => f.type.startsWith('image/')).slice(0, remaining);
    if (valid.length === 0) return;
    if (valid.find(f => f.size > 20 * 1024 * 1024)) { setError('参考图超过 20MB'); return; }
    try { const urls = await Promise.all(valid.map(f => compressImage(f))); setReferenceImages(prev => [...prev, ...urls]); } catch { setError('图片读取失败'); }
  };

  const handleVideoSelect = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    if (!file.type.startsWith('video/')) {
      setError('请选择视频文件');
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      setError('参考视频不能超过 50MB');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setReferenceVideo(reader.result as string);
    };
    reader.onerror = () => {
      setError('读取视频失败');
    };
    reader.readAsDataURL(file);
  };

  // 全局拖拽 + Ctrl+V 粘贴上传参考图
  useImageDropPaste(handleFileSelect);

  const handleGenerate = useCallback(() => {
    if (!prompt.trim()) return;
    if (!guard()) return;
    if (selectedModel === 'omni-flash-vref' && !referenceVideo) {
      setError('视频编辑模型必须上传参考视频');
      return;
    }
    setError(null);

    const taskId = `task_${Date.now()}`;
    const newTask: VideoTask = {
      id: taskId,
      prompt: prompt.trim(),
      status: 'generating',
      progress: 0,
      statusMessage: '正在连接...',
      videoUrl: null,
      error: null,
      metadata: { resolution, seconds: duration, aspect_ratio: aspectRatio, model: selectedModel },
      createdAt: new Date().toISOString(),
    };
    setTasks(prev => [newTask, ...prev]);

    const updateTask = (patch: Partial<VideoTask>) => {
      setTasks(prev => prev.map(t => t.id === taskId ? { ...t, ...patch } : t));
    };

    const ctrl = generateVideo(
      {
        prompt: prompt.trim(),
        model: selectedModel,
        aspect_ratio: aspectRatio,
        video_length: duration,
        resolution,
        reference_images: referenceImages.length > 0 ? referenceImages : undefined,
        reference_video: referenceVideo || undefined,
      },
      (event: VideoSSEEvent) => {
        switch (event.type) {
          case 'status': updateTask({ statusMessage: event.message || '' }); break;
          case 'progress': updateTask({ progress: event.progress || 0, statusMessage: `视频生成中 ${event.progress}%` }); break;
          case 'complete':
            updateTask({ status: 'complete', progress: 100, videoUrl: event.videoUrl || null, statusMessage: '' });
            abortRef.current.delete(taskId);
            break;
          case 'error':
            updateTask({ status: 'error', error: event.message || '生成失败', statusMessage: '' });
            abortRef.current.delete(taskId);
            break;
        }
      },
    );
    abortRef.current.set(taskId, ctrl);
    setPrompt('');
    setReferenceImages([]);
    setReferenceVideo(null);
  }, [prompt, selectedModel, aspectRatio, duration, resolution, referenceImages, referenceVideo]);

  const handleCancel = (taskId: string) => {
    abortRef.current.get(taskId)?.abort();
    abortRef.current.delete(taskId);
    setTasks(prev => prev.filter(t => t.id !== taskId));
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
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium text-white">{m.name}</p>
                    <div className="flex items-center gap-2">
                      {m.rates && (
                        <span className="text-[10px] bg-indigo-500/10 text-indigo-400 px-1.5 py-0.5 rounded border border-indigo-500/20 font-medium">
                          ¥{m.rates[resolution as keyof typeof m.rates]?.toFixed(2)}/秒
                        </span>
                      )}
                      {selectedModel === m.id && <div className="w-5 h-5 rounded-full bg-indigo-500 flex items-center justify-center shrink-0"><Check className="w-3 h-3 text-white" /></div>}
                    </div>
                  </div>
                  <p className="text-xs text-zinc-500 mt-1">{m.description}</p>
                  {m.rates && (
                    <div className="mt-2 flex items-center gap-2 text-[10px] text-zinc-600 border-t border-white/5 pt-1.5">
                      {m.rates['1080p'] ? (
                        <>
                          <span>1080p: <span className="text-zinc-400">¥{m.rates['1080p']?.toFixed(2)}/秒</span></span>
                          <span className="text-zinc-800">•</span>
                          <span>720p: <span className="text-zinc-400">¥{m.rates['720p']?.toFixed(2)}/秒</span></span>
                        </>
                      ) : (
                        <>
                          <span>720p: <span className="text-zinc-400">¥{m.rates['720p']?.toFixed(2)}/秒</span></span>
                          <span className="text-zinc-800">•</span>
                          <span>480p: <span className="text-zinc-400">¥{m.rates['480p']?.toFixed(2)}/秒</span></span>
                        </>
                      )}
                    </div>
                  )}
                  {m.requireRef && <p className="text-[10px] text-amber-400/80 mt-1.5 flex items-center gap-1">⚠️ 必须提供参考图</p>}
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
        <div className="flex-1 overflow-y-auto p-6 pb-40 [&::-webkit-scrollbar]:hidden" style={{ scrollbarWidth: 'none' }}>
          {tasks.length === 0 && history.length === 0 ? (
            <div className="h-full flex items-center justify-center">
              <div className="text-center">
                <div className="w-20 h-20 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-indigo-500/10 to-purple-500/10 border border-white/5 flex items-center justify-center">
                  <Sparkles className="w-8 h-8 text-indigo-400/60" />
                </div>
                <p className="text-sm text-zinc-500 mb-1">输入描述，生成AI视频</p>
                <p className="text-[11px] text-zinc-700">支持多种模型 · 多种比例 · 多种分辨率</p>
              </div>
            </div>
          ) : (
            <div className="w-full space-y-6">
              {/* 当前会话任务 */}
              {tasks.length > 0 && (
                <div>
                  <p className="text-xs text-zinc-500 mb-4 font-semibold tracking-wider uppercase">当前任务 ({tasks.length})</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 items-start">
                    {tasks.map((task) => (
                      <div key={task.id} className={`group relative rounded-2xl overflow-hidden border flex flex-col transition-all ${isVertical(task.metadata.aspect_ratio) ? 'max-w-[220px]' : ''} ${task.status === 'generating' ? 'border-indigo-500/30 bg-indigo-500/[0.03]' : task.status === 'error' ? 'border-red-500/20 bg-red-500/[0.03]' : 'border-white/5 bg-white/[0.02] hover:border-indigo-500/30'}`}>
                        {/* 视频区域 */}
                        <div className="relative w-full bg-black flex items-center justify-center overflow-hidden" style={getAspectStyle(task.metadata.aspect_ratio) || { aspectRatio: '16/9' }}>
                          {task.status === 'generating' ? (
                            <>
                              <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/[0.03] to-transparent animate-[shimmer_2s_infinite]" style={{ backgroundSize: '200% 100%' }} />
                              <div className="flex flex-col items-center gap-2 z-10">
                                <div className="relative w-14 h-14">
                                  <svg className="w-14 h-14 -rotate-90" viewBox="0 0 56 56">
                                    <circle cx="28" cy="28" r="24" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="3" />
                                    <circle cx="28" cy="28" r="24" fill="none" stroke="url(#vpg)" strokeWidth="3" strokeLinecap="round"
                                      strokeDasharray={`${2 * Math.PI * 24}`} strokeDashoffset={`${2 * Math.PI * 24 * (1 - task.progress / 100)}`} className="transition-all duration-700 ease-out" />
                                    <defs><linearGradient id="vpg" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stopColor="#6366f1" /><stop offset="100%" stopColor="#a855f7" /></linearGradient></defs>
                                  </svg>
                                  <div className="absolute inset-0 flex items-center justify-center">
                                    <span className="text-sm font-bold text-white tabular-nums">{task.progress}%</span>
                                  </div>
                                </div>
                                <p className="text-[11px] text-zinc-400 text-center px-3 line-clamp-1">{task.statusMessage}</p>
                              </div>
                            </>
                          ) : task.status === 'complete' && task.videoUrl ? (
                            <>
                              <video src={task.videoUrl} className={`w-full h-full ${isVertical(task.metadata.aspect_ratio) ? 'object-contain' : 'object-cover'}`} preload="metadata" playsInline muted loop
                                onMouseEnter={(e) => e.currentTarget.play().catch(() => {})}
                                onMouseLeave={(e) => { e.currentTarget.pause(); e.currentTarget.currentTime = 0; }} />
                              <div className="absolute inset-0 bg-black/30 flex items-center justify-center group-hover:bg-black/10 transition-colors cursor-pointer" onClick={() => setPlayingVideo({ url: task.videoUrl!, prompt: task.prompt })}>
                                <Play className="w-8 h-8 text-white/80 group-hover:text-white group-hover:scale-110 transition-all" />
                              </div>
                            </>
                          ) : task.status === 'error' ? (
                            <div className="flex flex-col items-center gap-2 p-4">
                              <AlertCircle className="w-8 h-8 text-red-400/60" />
                              <p className="text-xs text-red-400/80 text-center line-clamp-2">{task.error}</p>
                            </div>
                          ) : null}
                        </div>
                        {/* 信息区 */}
                        <div className="p-3 flex-1 flex flex-col justify-between gap-1.5 bg-black/40">
                          <p className="text-xs text-zinc-300 line-clamp-2 leading-relaxed">{task.prompt}</p>
                          <div className="flex items-center justify-between mt-1">
                            <span className="text-[10px] text-zinc-500">{task.metadata.resolution} · {task.metadata.seconds}秒</span>
                            {task.status === 'generating' ? (
                              <button onClick={() => handleCancel(task.id)} className="text-[10px] text-red-400/70 hover:text-red-400 transition-colors flex items-center gap-1">
                                <Square className="w-2.5 h-2.5" /> 取消
                              </button>
                            ) : task.status === 'complete' && task.videoUrl ? (
                              <div className="flex items-center gap-2">
                                <button onClick={() => { setPrompt(task.prompt); textareaRef.current?.focus(); }}
                                  className="text-[10px] text-zinc-500 hover:text-indigo-400 transition-colors flex items-center gap-0.5" title="套用提示词">
                                  <RotateCcw className="w-3 h-3" />套用
                                </button>
                                <a href={task.videoUrl} target="_blank" rel="noopener noreferrer" download className="text-[10px] text-zinc-500 hover:text-indigo-400 transition-colors">
                                  <Download className="w-3 h-3" />
                                </a>
                                <button onClick={() => { const d = JSON.stringify([{ id: task.id, prompt: task.prompt, videoUrl: task.videoUrl, duration: task.metadata.seconds, model: task.metadata.model, aspectRatio: task.metadata.aspect_ratio, resolution: task.metadata.resolution }]); sessionStorage.setItem('studio_init', d); navigate('/app/video/studio'); }}
                                  className="text-[10px] text-zinc-500 hover:text-indigo-400 transition-colors"><Film className="w-3 h-3" /></button>
                              </div>
                            ) : task.status === 'error' ? (
                              <button onClick={() => setTasks(prev => prev.filter(t => t.id !== task.id))} className="text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors">
                                <X className="w-3 h-3" />
                              </button>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 历史记录 */}
              {history.length > 0 && (
                <div>
                  <p className="text-xs text-zinc-500 mb-4 font-semibold tracking-wider uppercase">历史生成 ({history.length})</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 items-start">
                    {history.map((h) => (
                      <div key={h.id} onClick={() => setPlayingVideo({ url: h.resultUrl, prompt: h.title || h.inputText || '' })} className={`group relative rounded-2xl overflow-hidden border border-white/5 bg-white/[0.02] hover:border-indigo-500/30 transition-all flex flex-col cursor-pointer ${isVertical(h.metadata?.aspect_ratio) ? 'max-w-[220px]' : ''}`}>
                        <div className="relative w-full bg-black flex items-center justify-center overflow-hidden" style={getAspectStyle(h.metadata?.aspect_ratio) || { aspectRatio: '16/9' }}>
                          <video src={h.resultUrl} className={`w-full h-full ${isVertical(h.metadata?.aspect_ratio) ? 'object-contain' : 'object-cover'}`} preload="metadata" playsInline muted loop
                            onMouseEnter={(e) => e.currentTarget.play().catch(() => {})}
                            onMouseLeave={(e) => { e.currentTarget.pause(); e.currentTarget.currentTime = 0; }} />
                          <div className="absolute inset-0 bg-black/30 flex items-center justify-center group-hover:bg-black/10 transition-colors">
                            <Play className="w-8 h-8 text-white/80 group-hover:text-white group-hover:scale-110 transition-all" />
                          </div>
                        </div>
                        <div className="p-3 flex-1 flex flex-col justify-between gap-1 bg-black/40">
                          <p className="text-xs text-zinc-300 line-clamp-2 leading-relaxed">{h.title || h.inputText || '无描述'}</p>
                          <div className="flex items-center justify-between mt-2 text-[10px] text-zinc-500">
                            <span>{h.metadata?.resolution || '720p'} · {h.metadata?.seconds || 6}秒</span>
                            <div className="flex items-center gap-2">
                              <span>{new Date(h.createdAt).toLocaleDateString()}</span>
                              <button onClick={(e) => { e.stopPropagation(); setPrompt(h.title || h.inputText || ''); textareaRef.current?.focus(); }}
                                className="text-zinc-500 hover:text-indigo-400 transition-colors flex items-center gap-0.5" title="套用提示词">
                                <RotateCcw className="w-3 h-3" />套用
                              </button>
                              <a href={h.resultUrl} target="_blank" rel="noopener noreferrer" download onClick={(e) => e.stopPropagation()} className="text-zinc-500 hover:text-indigo-400 transition-colors"><Download className="w-3 h-3" /></a>
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* 视频播放弹窗 */}
        {playingVideo && (
          <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-8" onClick={() => setPlayingVideo(null)}>
            <div className="relative w-full max-w-4xl" onClick={(e) => e.stopPropagation()}>
              <video src={playingVideo.url} controls autoPlay className="w-full max-h-[75vh] rounded-2xl shadow-2xl bg-black" />
              <div className="flex items-center justify-between mt-4">
                <p className="text-sm text-zinc-300 line-clamp-1 flex-1 mr-4">{playingVideo.prompt}</p>
                <div className="flex items-center gap-3 shrink-0">
                  <a href={playingVideo.url} target="_blank" rel="noopener noreferrer" download className="flex items-center gap-2 px-4 py-2 bg-white/5 hover:bg-white/10 rounded-xl text-xs text-zinc-300 transition-colors">
                    <Download className="w-3.5 h-3.5" /> 下载
                  </a>
                  <button onClick={() => setPlayingVideo(null)} className="flex items-center gap-2 px-4 py-2 bg-white/5 hover:bg-white/10 rounded-xl text-xs text-zinc-300 transition-colors">
                    <X className="w-3.5 h-3.5" /> 关闭
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

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
                {selectedModel === 'omni-flash-vref' && (
                  <>
                    <button onClick={() => videoFileInputRef.current?.click()} className="flex items-center gap-1.5 bg-white/[0.04] hover:bg-white/[0.08] rounded-lg px-2.5 py-1.5 text-[11px] text-zinc-300 transition-colors border border-white/5 hover:border-white/10">
                      <Upload className="w-3 h-3 text-indigo-400" /> 参考视频 {referenceVideo ? '(已上传)' : ''}
                    </button>
                    <input ref={videoFileInputRef} type="file" accept="video/mp4,video/*" className="hidden" onChange={(e) => { handleVideoSelect(e.target.files); e.target.value = ''; }} />
                  </>
                )}
                <button onClick={() => fileInputRef.current?.click()} className="flex items-center gap-1.5 bg-white/[0.04] hover:bg-white/[0.08] rounded-lg px-2.5 py-1.5 text-[11px] text-zinc-300 transition-colors border border-white/5 hover:border-white/10">
                  <Upload className="w-3 h-3 text-indigo-400" /> 参考图 ({referenceImages.length}/{MAX_REFS})
                </button>
                <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => { handleFileSelect(e.target.files); e.target.value = ''; }} />
              </div>
              {/* 输入容器 */}
              <div className="relative bg-white/[0.04] border border-white/[0.08] focus-within:border-indigo-500/30 rounded-2xl transition-all shadow-2xl shadow-black/30">
                {(referenceImages.length > 0 || referenceVideo) && (
                  <div className="flex items-center gap-2 px-4 pt-3 pb-1 flex-wrap">
                    {referenceVideo && (
                      <div className="relative w-12 h-12 rounded-lg overflow-hidden border border-indigo-500/40 group cursor-pointer shrink-0 hover:border-red-500/30 transition-colors">
                        <video src={referenceVideo} className="w-full h-full object-cover" />
                        <button onClick={() => setReferenceVideo(null)}
                          className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"><X className="w-3.5 h-3.5 text-white" /></button>
                      </div>
                    )}
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
                <button onClick={handleGenerate} disabled={!prompt.trim()}
                  className="absolute right-3 bottom-3 w-10 h-10 rounded-full flex items-center justify-center transition-all bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white shadow-lg shadow-indigo-500/20 disabled:opacity-30 disabled:cursor-not-allowed">
                  <Play className="w-4 h-4 ml-0.5" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Video, Play, Square, Download, Loader2, Check, AlertCircle, Sparkles, Monitor, Smartphone, RectangleHorizontal, Upload, X, Film, RotateCcw, Maximize2, Minimize2, Scissors, HelpCircle } from 'lucide-react';
import { fetchVideoModels, generateVideo, type VideoModel, type VideoSSEEvent } from '../../api/video';
import ImageSlicerModal from '../../components/ImageSlicerModal';
import { contentApi } from '../../api/content';
import { useImageDropPaste } from '../../hooks/useImageDropPaste';
import { useAuthGuard } from '../../hooks/useAuthGuard';
import { saveAsset, getAssets, deleteAsset, type Asset } from '../../utils/idb';

interface VideoTask {
  id: string;
  prompt: string;
  status: 'generating' | 'complete' | 'error';
  progress: number;
  statusMessage: string;
  videoUrl: string | null;
  error: string | null;
  metadata: { 
    resolution: string; 
    seconds: number; 
    aspect_ratio: string; 
    model: string;
    reference_images?: string[];
    reference_video?: string | null;
    audio_url?: string | null;
  };
  createdAt: string;
  dbId?: number;
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
  { value: 4, label: '4 秒' }, { value: 5, label: '5 秒' },
  { value: 6, label: '6 秒' }, { value: 7, label: '7 秒' },
  { value: 8, label: '8 秒' }, { value: 9, label: '9 秒' },
  { value: 10, label: '10 秒' }, { value: 11, label: '11 秒' },
  { value: 12, label: '12 秒' }, { value: 13, label: '13 秒' },
  { value: 14, label: '14 秒' }, { value: 15, label: '15 秒' },
  { value: 16, label: '16 秒' }, { value: 20, label: '20 秒' },
  { value: 30, label: '30 秒' },
];
const getMaxReferenceImages = (modelId: string, models: VideoModel[]) => {
  if (modelId === 'omni-flash') return 7;
  if (modelId === 'omni-flash-vref') return 5;
  if (modelId === 'sora-v4-fast') return 4;
  const model = models.find(m => m.id === modelId);
  if (model?.requireRef) return 1;
  return 5;
};


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

const getRefFilename = (dataUrl: string, index: number) => {
  const mimeMatch = dataUrl.match(/^data:([^;]+);/);
  const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
  const ext = mimeType.includes('png') ? 'png' : 'jpg';
  return `ref_${index}.${ext}`;
};

const restorePrompt = (targetPrompt: string) => {
  if (!targetPrompt) return '';
  return targetPrompt.replace(/\[ref_(\d+)(?:\.[a-zA-Z0-9]+)?\]/g, (match, idxStr) => {
    const idx = parseInt(idxStr, 10);
    return `@图${idx + 1}`;
  });
};

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
  const maxRefs = getMaxReferenceImages(selectedModel, models);

  useEffect(() => {
    if (referenceImages.length > maxRefs) {
      setReferenceImages(prev => prev.slice(0, maxRefs));
    }
  }, [selectedModel, maxRefs]);

  const [referenceVideo, setReferenceVideo] = useState<string | null>(null);
  const [referenceAudio, setReferenceAudio] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoFileInputRef = useRef<HTMLInputElement>(null);
  const audioFileInputRef = useRef<HTMLInputElement>(null);
  const [tasks, setTasks] = useState<VideoTask[]>([]);
  const [history, setHistory] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<Map<string, AbortController>>(new Map());
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const isGenerating = tasks.some(t => t.status === 'generating');
  const [playingVideo, setPlayingVideo] = useState<{ url: string; prompt: string } | null>(null);
  
  // 资产库状态
  const [showAssetPicker, setShowAssetPicker] = useState(false);
  const [myAssets, setMyAssets] = useState<Asset[]>([]);
  const [cursorPos, setCursorPos] = useState<number | null>(null);
  const [isMaximized, setIsMaximized] = useState(false);

  const renderHighlightedText = (text: string) => {
    if (!text) return null;
    const regex = /([@＠]图\d+)/g;
    const parts = text.split(regex);
    return parts.map((part, index) => {
      if (regex.test(part)) {
        const match = part.match(/\d+/);
        const idx = match ? parseInt(match[0], 10) - 1 : -1;
        const exists = idx >= 0 && idx < referenceImages.length;
        
        return (
          <span 
            key={index} 
            className={`inline font-medium rounded px-0.5 transition-all ${
              exists 
                ? 'text-indigo-400 bg-indigo-500/15 border border-indigo-500/20 shadow-sm shadow-indigo-500/5 font-sans' 
                : 'text-zinc-500 bg-zinc-500/10 line-through decoration-zinc-600 font-sans'
            }`}
          >
            {part}
          </span>
        );
      }
      return <span key={index}>{part}</span>;
    });
  };

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

  useEffect(() => {
    fetchVideoModels().then((m) => { setModels(m); if (m.length > 0 && !selectedModel) setSelectedModel(m[0].id); }).catch(() => {});
    
    // 加载历史与生产中生成记录
    contentApi.getMyContents({ type: 'video', pageSize: 50 })
      .then((res: any) => {
        const items = res?.items || res?.data || [];
        // 已完成或已失败的记录计入历史面板
        setHistory(items.filter((item: any) => item.status === 'completed' || item.status === 'success' || item.resultUrl));
        
        // 正在生产中的记录恢复到 tasks 队列中继续展示生成进度
        const processingTasks: VideoTask[] = items
          .filter((item: any) => item.status === 'processing')
          .map((item: any) => {
            let meta = {};
            try {
              meta = item.metadata ? (typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata) : {};
            } catch {}
            return {
              id: `db_${item.id}`,
              prompt: item.inputText || item.title || '',
              status: 'generating',
              progress: 0,
              statusMessage: '正在后台恢复生成...',
              videoUrl: null,
              error: null,
              metadata: meta as any,
              createdAt: item.createdAt,
            };
          });
        setTasks(processingTasks);
      })
      .catch(() => {});
      
    // 加载本地资产库
    getAssets().then(setMyAssets).catch(() => {});
  }, []);

  // 轮询在后台生成中的数据库任务
  useEffect(() => {
    const dbTasks = tasks.filter(t => t.status === 'generating' && t.id.startsWith('db_'));
    if (dbTasks.length === 0) return;

    let active = true;
    const intervalId = setInterval(() => {
      dbTasks.forEach(task => {
        const dbId = parseInt(task.id.replace('db_', ''));
        contentApi.getById(dbId)
          .then((res: any) => {
            if (!active) return;
            const item = res;
            if (item.status === 'completed' || item.status === 'success') {
              // 先将任务标记为完成状态并显示视频，避免直接移除导致视觉"消失"
              setTasks(prev => prev.map(t => t.id === task.id ? {
                ...t,
                status: 'complete',
                progress: 100,
                videoUrl: item.resultUrl || null,
                statusMessage: '',
              } : t));
              // 延迟后刷新历史记录
              setTimeout(() => {
                contentApi.getMyContents({ type: 'video', pageSize: 50 })
                  .then((r: any) => {
                    const items = r?.items || r?.data || [];
                    setHistory(items.filter((x: any) => x.status === 'completed' || x.status === 'success' || x.resultUrl));
                    // 历史已加载，从当前任务中移除
                    setTasks(prev => prev.filter(t => t.id !== task.id));
                  }).catch(() => {});
              }, 2000);
            } else if (item.status === 'failed') {
              setTasks(prev => prev.map(t => t.id === task.id ? {
                ...t,
                status: 'error',
                statusMessage: '',
                error: item.metadata?.error || '生成失败'
              } : t));
            } else {
              // processing 状态：从 metadata.progress 读取实时进度
              let meta: any = {};
              try { meta = typeof item.metadata === 'string' ? JSON.parse(item.metadata) : (item.metadata || {}); } catch {}
              const p = meta.progress || 0;
              setTasks(prev => prev.map(t => t.id === task.id ? {
                ...t,
                progress: p,
                statusMessage: p > 0 ? `视频生成中 ${p}%` : '正在后台生成中...'
              } : t));
            }
          })
          .catch(() => {});
      });
    }, 5000);

    return () => {
      active = false;
      clearInterval(intervalId);
    };
  }, [tasks]);

  // 自动调整输入框高度
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      if (isMaximized) {
        textarea.style.height = '360px';
      } else {
        textarea.style.height = 'auto';
        textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
      }
    }
  }, [prompt, isMaximized]);

  // 保持滚动条高度与输入框完全同步
  useEffect(() => {
    if (textareaRef.current && backdropRef.current) {
      backdropRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  }, [prompt]);

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

    if (selectedModel !== 'omni-flash-vref' && selectedModel !== 'sora-v4-fast') {
      setReferenceVideo(null);
    }
    if (selectedModel !== 'sora-v4-fast') {
      setReferenceAudio(null);
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
    const remaining = maxRefs - referenceImages.length;
    if (remaining <= 0) { setError(`当前模型最多支持 ${maxRefs} 张参考图`); return; }
    const valid = Array.from(files).filter(f => f.type.startsWith('image/')).slice(0, remaining);
    if (valid.length === 0) return;
    if (valid.find(f => f.size > 20 * 1024 * 1024)) { setError('参考图超过 20MB'); return; }
    try { 
      const compressed = await Promise.all(valid.map(async f => ({
        url: await compressImage(f),
        name: f.name
      })));
      const urls = compressed.map(c => c.url);
      setReferenceImages(prev => [...prev, ...urls]); 
      
      // 保存到本地持久化资产库
      compressed.forEach(c => {
        const newAsset: Asset = {
          id: `img_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
          name: c.name,
          dataUrl: c.url,
          type: 'image',
          createdAt: Date.now()
        };
        saveAsset(newAsset).then(() => setMyAssets(prev => [newAsset, ...prev])).catch(() => {});
      });
    } catch { 
      setError('图片读取失败'); 
    }
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
      const dataUrl = reader.result as string;
      setReferenceVideo(dataUrl);
      const newAsset: Asset = {
        id: `vid_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
        name: file.name,
        dataUrl,
        type: 'video',
        createdAt: Date.now()
      };
      saveAsset(newAsset).then(() => setMyAssets(prev => [newAsset, ...prev])).catch(() => {});
    };
    reader.onerror = () => {
      setError('读取视频失败');
    };
    reader.readAsDataURL(file);
  };

  const handleAudioSelect = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    if (!file.type.startsWith('audio/')) {
      setError('请选择音频文件');
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setError('参考音频不能超过 20MB');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      setReferenceAudio(dataUrl);
    };
    reader.onerror = () => {
      setError('读取音频失败');
    };
    reader.readAsDataURL(file);
  };

  const handleMediaDrop = useCallback((files: FileList | null) => {
    if (!files) return;
    const imageFiles = new DataTransfer();
    const videoFiles = new DataTransfer();
    Array.from(files).forEach(f => {
      if (f.type.startsWith('image/')) imageFiles.items.add(f);
      else if (f.type.startsWith('video/')) videoFiles.items.add(f);
    });
    if (imageFiles.files.length > 0) handleFileSelect(imageFiles.files);
    if (videoFiles.files.length > 0) handleVideoSelect(videoFiles.files);
  }, [handleFileSelect, handleVideoSelect]);

  // 全局拖拽 + Ctrl+V 粘贴上传媒体
  const { isDragging } = useImageDropPaste(handleMediaDrop);

  const handleApplyHistory = (item: {
    prompt?: string;
    inputText?: string;
    title?: string;
    metadata?: {
      model?: string;
      resolution?: string;
      seconds?: number;
      aspect_ratio?: string;
      reference_images?: string[];
      reference_video?: string | null;
      audio_url?: string | null;
    };
  }) => {
    const targetPrompt = item.inputText || item.title || item.prompt || '';
    setPrompt(restorePrompt(targetPrompt));
    
    if (item.metadata) {
      const meta = item.metadata;
      if (meta.model) setSelectedModel(meta.model);
      if (meta.resolution) setResolution(meta.resolution);
      if (meta.seconds) setDuration(meta.seconds);
      if (meta.aspect_ratio) setAspectRatio(meta.aspect_ratio);
      
      // 恢复参考图与参考视频及参考音频
      setReferenceImages(meta.reference_images || []);
      setReferenceVideo(meta.reference_video || null);
      setReferenceAudio(meta.audio_url || null);
    }
    
    setTimeout(() => {
      textareaRef.current?.focus();
    }, 50);
  };

  const handleGenerate = useCallback(() => {
    if (!prompt.trim()) return;
    if (!guard()) return;
    if (selectedModel === 'omni-flash-vref' && !referenceVideo) {
      setError('视频编辑模型必须上传参考视频');
      return;
    }
    setError(null);

    // 将 prompt 中的 @图1, @图2 翻译回后端 API 支持的 [ref_0.jpg] 格式
    let finalPrompt = prompt.trim();
    referenceImages.forEach((img, idx) => {
      const refName = getRefFilename(img, idx);
      const userRefLabelPattern = new RegExp(`[@＠]图${idx + 1}\\b|[@＠]图${idx + 1}`, 'g');
      finalPrompt = finalPrompt.replace(userRefLabelPattern, `[${refName}]`);
    });

    const taskId = `task_${Date.now()}`;
    const newTask: VideoTask = {
      id: taskId,
      prompt: finalPrompt,
      status: 'generating',
      progress: 0,
      statusMessage: '正在连接...',
      videoUrl: null,
      error: null,
      metadata: { 
        resolution, 
        seconds: duration, 
        aspect_ratio: aspectRatio, 
        model: selectedModel,
        reference_images: referenceImages,
        reference_video: referenceVideo,
        audio_url: referenceAudio
      },
      createdAt: new Date().toISOString(),
    };
    setTasks(prev => [newTask, ...prev]);

    const updateTask = (patch: Partial<VideoTask>) => {
      setTasks(prev => prev.map(t => t.id === taskId ? { ...t, ...patch } : t));
    };

    const ctrl = generateVideo(
      {
        prompt: finalPrompt,
        model: selectedModel,
        aspect_ratio: aspectRatio,
        video_length: duration,
        resolution,
        reference_images: referenceImages.length > 0 ? referenceImages : undefined,
        reference_video: referenceVideo || undefined,
        audio_url: referenceAudio || undefined,
      },
      (event: VideoSSEEvent) => {
        switch (event.type) {
          case 'content_id':
            updateTask({ dbId: event.contentId });
            break;
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
          case 'close':
            // SSE 连接中断，且任务没有完成/失败，有数据库 ID 的情况下，直接升级为 db_ 开头的后台轮询任务
            setTasks(prev => prev.map(t => {
              if (t.id === taskId && t.status === 'generating' && t.dbId) {
                return {
                  ...t,
                  id: `db_${t.dbId}`,
                  statusMessage: '连接已断开，正在后台恢复生成...'
                };
              }
              return t;
            }));
            abortRef.current.delete(taskId);
            break;
        }
      },
    );
    abortRef.current.set(taskId, ctrl);
    setPrompt('');
    setReferenceImages([]);
    setReferenceVideo(null);
    setReferenceAudio(null);
  }, [prompt, selectedModel, aspectRatio, duration, resolution, referenceImages, referenceVideo, referenceAudio]);

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
                          {m.rates['480p'] !== undefined && (
                            <>
                              <span className="text-zinc-800">•</span>
                              <span>480p: <span className="text-zinc-400">¥{m.rates['480p']?.toFixed(2)}/秒</span></span>
                            </>
                          )}
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
      <div className="flex-1 flex flex-col min-w-0 relative h-full">
        <div className="flex-1 overflow-y-auto p-6 [&::-webkit-scrollbar]:hidden" style={{ scrollbarWidth: 'none' }}>
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
                              <div className="absolute inset-0 bg-black/30 flex items-center justify-center group-hover:bg-black/10 transition-colors cursor-pointer" onClick={() => setPlayingVideo({ url: task.videoUrl!, prompt: restorePrompt(task.prompt) })}>
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
                          <div>
                            <p className="text-xs text-zinc-300 line-clamp-2 leading-relaxed">{restorePrompt(task.prompt)}</p>
                            
                            {/* 参考图微缩图预览 */}
                            {task.metadata?.reference_images && task.metadata.reference_images.length > 0 && (
                              <div className="flex gap-1.5 mt-2 flex-wrap">
                                {task.metadata.reference_images.map((imgUrl, imgIdx) => (
                                  <div key={imgIdx} className="relative w-7 h-7 rounded-md border border-white/10 overflow-hidden shrink-0" title={`ref_${imgIdx}`}>
                                    <img src={imgUrl} className="w-full h-full object-cover" />
                                    <div className="absolute top-0 left-0 bg-black/70 text-[7px] text-zinc-400 font-mono px-0.5 rounded-br scale-90 origin-top-left">
                                      ref_{imgIdx}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                          
                          <div className="flex items-center justify-between mt-1">
                            <span className="text-[10px] text-zinc-500">{task.metadata.resolution} · {task.metadata.seconds}秒</span>
                            {task.status === 'generating' ? (
                              <button onClick={() => handleCancel(task.id)} className="text-[10px] text-red-400/70 hover:text-red-400 transition-colors flex items-center gap-1">
                                <Square className="w-2.5 h-2.5" /> 取消
                              </button>
                            ) : task.status === 'complete' && task.videoUrl ? (
                              <div className="flex items-center gap-2">
                                <button onClick={() => handleApplyHistory(task)}
                                  className="text-[10px] text-zinc-500 hover:text-indigo-400 transition-colors flex items-center gap-0.5" title="套用历史配置（包含提示词与参考图片）">
                                  <RotateCcw className="w-3 h-3" />套用
                                </button>
                                <a href={`/api/video/download?url=${encodeURIComponent(task.videoUrl)}&filename=video_${task.id}.mp4`} download className="text-[10px] text-zinc-500 hover:text-indigo-400 transition-colors">
                                  <Download className="w-3 h-3" />
                                </a>
                                <button onClick={() => { const d = JSON.stringify([{ id: task.id, prompt: task.prompt, videoUrl: task.videoUrl, duration: task.metadata.seconds, model: task.metadata.model, aspectRatio: task.metadata.aspect_ratio, resolution: task.metadata.resolution }]); sessionStorage.setItem('studio_init', d); navigate('/app/video/studio'); }}
                                  className="text-[10px] text-zinc-500 hover:text-indigo-400 transition-colors"><Film className="w-3 h-3" /></button>
                              </div>
                            ) : task.status === 'error' ? (
                              <div className="flex items-center gap-2">
                                <button onClick={() => handleApplyHistory(task)}
                                  className="text-[10px] text-zinc-500 hover:text-indigo-400 transition-colors flex items-center gap-0.5" title="套用历史配置（包含提示词与参考图片）">
                                  <RotateCcw className="w-3 h-3" />套用
                                </button>
                                <button onClick={() => setTasks(prev => prev.filter(t => t.id !== task.id))} className="text-[10px] text-zinc-500 hover:text-red-400 transition-colors" title="移除">
                                  <X className="w-3 h-3" />
                                </button>
                              </div>
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
                      <div key={h.id} onClick={() => setPlayingVideo({ url: h.resultUrl, prompt: restorePrompt(h.title || h.inputText || '') })} className={`group relative rounded-2xl overflow-hidden border border-white/5 bg-white/[0.02] hover:border-indigo-500/30 transition-all flex flex-col cursor-pointer ${isVertical(h.metadata?.aspect_ratio) ? 'max-w-[220px]' : ''}`}>
                        <div className="relative w-full bg-black flex items-center justify-center overflow-hidden" style={getAspectStyle(h.metadata?.aspect_ratio) || { aspectRatio: '16/9' }}>
                          <video src={h.resultUrl} className={`w-full h-full ${isVertical(h.metadata?.aspect_ratio) ? 'object-contain' : 'object-cover'}`} preload="metadata" playsInline muted loop
                            onMouseEnter={(e) => e.currentTarget.play().catch(() => {})}
                            onMouseLeave={(e) => { e.currentTarget.pause(); e.currentTarget.currentTime = 0; }} />
                          <div className="absolute inset-0 bg-black/30 flex items-center justify-center group-hover:bg-black/10 transition-colors">
                            <Play className="w-8 h-8 text-white/80 group-hover:text-white group-hover:scale-110 transition-all" />
                          </div>
                        </div>
                        <div className="p-3 flex-1 flex flex-col justify-between gap-1 bg-black/40">
                          <div>
                            <p className="text-xs text-zinc-300 line-clamp-2 leading-relaxed">{restorePrompt(h.title || h.inputText || '无描述')}</p>
                            
                            {/* 参考图微缩图预览 */}
                            {h.metadata?.reference_images && h.metadata.reference_images.length > 0 && (
                              <div className="flex gap-1.5 mt-2 flex-wrap">
                                {h.metadata.reference_images.map((imgUrl: string, imgIdx: number) => (
                                  <div key={imgIdx} className="relative w-7 h-7 rounded-md border border-white/10 overflow-hidden shrink-0" title={`ref_${imgIdx}`}>
                                    <img src={imgUrl} className="w-full h-full object-cover" />
                                    <div className="absolute top-0 left-0 bg-black/70 text-[7px] text-zinc-400 font-mono px-0.5 rounded-br scale-90 origin-top-left">
                                      ref_{imgIdx}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                          
                          <div className="flex items-center justify-between mt-2 text-[10px] text-zinc-500">
                            <span>{h.metadata?.resolution || '720p'} · {h.metadata?.seconds || 6}秒</span>
                            <div className="flex items-center gap-2">
                              <span>{new Date(h.createdAt).toLocaleDateString()}</span>
                              <button onClick={(e) => { e.stopPropagation(); handleApplyHistory(h); }}
                                className="text-zinc-500 hover:text-indigo-400 transition-colors flex items-center gap-0.5" title="套用历史配置（包含提示词与参考图片）">
                                <RotateCcw className="w-3 h-3" />套用
                              </button>
                              <a href={`/api/video/download?url=${encodeURIComponent(h.resultUrl)}&filename=video_${h.id}.mp4`} download onClick={(e) => e.stopPropagation()} className="text-zinc-500 hover:text-indigo-400 transition-colors"><Download className="w-3 h-3" /></a>
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
                <p className="text-sm text-zinc-300 line-clamp-1 flex-1 mr-4">{restorePrompt(playingVideo.prompt)}</p>
                <div className="flex items-center gap-3 shrink-0">
                  <a href={`/api/video/download?url=${encodeURIComponent(playingVideo.url)}&filename=video_download.mp4`} download className="flex items-center gap-2 px-4 py-2 bg-white/5 hover:bg-white/10 rounded-xl text-xs text-zinc-300 transition-colors">
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

        {/* 输入区（不再是绝对定位的悬浮区，而是底栏） */}
        <div className="border-t border-white/5 bg-[#0c0c0c]/95 backdrop-blur-md w-full shrink-0 z-10 relative">
          {error && (
            <div className="absolute bottom-full left-6 right-6 mb-3 z-20 px-4 py-2.5 bg-red-500/10 border border-red-500/20 rounded-xl text-sm text-red-400 flex items-center gap-2 backdrop-blur-md shadow-2xl">
              <AlertCircle className="w-4 h-4 shrink-0" /><span className="flex-1">{error}</span>
              <button onClick={() => setError(null)} className="text-red-500/60 hover:text-red-400 text-xs">✕</button>
            </div>
          )}

          <div className="px-6 py-4">
            <div className="max-w-3xl mx-auto">
              <div className="relative bg-white/[0.04] border border-white/[0.08] focus-within:border-indigo-500/30 rounded-2xl transition-all shadow-2xl shadow-black/30 flex flex-col">
                
                {/* 顶部辅助工具栏 */}
                <div className="flex items-center justify-between px-4 py-2 border-b border-white/[0.04] text-[11px] text-zinc-500 bg-white/[0.01] rounded-t-2xl">
                  <span className="flex items-center gap-1.5 font-medium">
                    <Sparkles className="w-3 h-3 text-indigo-400" />
                    提示词脚本编辑器
                  </span>
                  <div className="flex items-center gap-3">
                    <span className="font-mono">{prompt.length} 字</span>
                    <button 
                      onClick={() => setIsMaximized(prev => !prev)}
                      type="button"
                      className="flex items-center gap-1 text-indigo-400 hover:text-indigo-300 transition-colors cursor-pointer select-none">
                      {isMaximized ? (
                        <>
                          <Minimize2 className="w-3 h-3" />
                          <span>收起</span>
                        </>
                      ) : (
                        <>
                          <Maximize2 className="w-3 h-3" />
                          <span>展开长提示词</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>

                {/* 资产选择弹窗 */}
                {showAssetPicker && (
                  <div className="absolute bottom-full left-4 mb-2 w-80 max-w-full bg-[#1a1a1a] border border-white/10 rounded-xl shadow-2xl p-2.5 z-50">
                    <div className="flex items-center justify-between px-2 pb-2 border-b border-white/10 mb-2">
                      <span className="text-xs font-semibold text-zinc-400 font-medium">选择图片引用</span>
                      <button onClick={() => setShowAssetPicker(false)} className="text-zinc-500 hover:text-white"><X className="w-3.5 h-3.5" /></button>
                    </div>

                    {/* 第一部分：已上传的参考图列表 (直接在文本中@引用) */}
                    {referenceImages.length > 0 && (
                      <div className="mb-3 pb-3 border-b border-white/5">
                        <span className="text-[10px] text-zinc-500 mb-2 block px-1 font-semibold">已上传参考图 (点击引用至文本)</span>
                        <div className="flex flex-col gap-1 max-h-40 overflow-y-auto [&::-webkit-scrollbar]:hidden" style={{ scrollbarWidth: 'none' }}>
                          {referenceImages.map((img, idx) => {
                            return (
                              <div 
                                key={`uploaded_${idx}`} 
                                onClick={() => {
                                  const textToInsert = `@图${idx + 1} `;
                                  if (cursorPos !== null) {
                                    setPrompt(prev => prev.slice(0, cursorPos) + textToInsert + prev.slice(cursorPos));
                                    setCursorPos(cursorPos + textToInsert.length);
                                  } else {
                                    setPrompt(prev => prev + textToInsert);
                                  }
                                  setShowAssetPicker(false);
                                  setTimeout(() => textareaRef.current?.focus(), 50);
                                }}
                                className="flex items-center gap-3 px-2 py-1.5 rounded-lg cursor-pointer hover:bg-indigo-500/10 group transition-all text-xs text-zinc-300 hover:text-indigo-400"
                                title={`点击在光标处插入 @图${idx + 1}`}
                              >
                                <img src={img} className="w-8 h-8 rounded-lg object-cover border border-white/5" />
                                <span className="font-medium group-hover:text-indigo-400">@图{idx + 1}</span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    
                    <button onClick={() => { fileInputRef.current?.click(); setShowAssetPicker(false); }} 
                      className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 transition-colors text-xs text-white mb-3 cursor-pointer">
                      <Upload className="w-3.5 h-3.5 text-indigo-400" /> 从本地上传新文件
                    </button>
                    
                    <div className="max-h-60 overflow-y-auto [&::-webkit-scrollbar]:hidden" style={{ scrollbarWidth: 'none' }}>
                      <span className="text-[10px] text-zinc-500 mb-2 block px-1 font-semibold">本地资产库 (点击添加并插入引用)</span>
                      {myAssets.length === 0 ? (
                        <div className="text-center py-6 text-xs text-zinc-600">暂无历史保存的资产</div>
                      ) : (
                        <div className="grid grid-cols-4 gap-2">
                          {myAssets.map(asset => {
                            const isSelected = asset.type === 'video' ? referenceVideo === asset.dataUrl : referenceImages.includes(asset.dataUrl);
                            
                            return (
                            <div key={asset.id} className={`relative group aspect-square rounded-lg overflow-hidden border cursor-pointer bg-black/50 transition-all ${isSelected ? 'border-indigo-500 shadow-[0_0_0_2px_rgba(99,102,241,0.3)]' : 'border-white/10 hover:border-indigo-500/50'}`} 
                                 onClick={() => {
                                   if (asset.type === 'video') {
                                     setReferenceVideo(asset.dataUrl);
                                     setShowAssetPicker(false);
                                     setTimeout(() => textareaRef.current?.focus(), 50);
                                   } else {
                                     let idx = referenceImages.indexOf(asset.dataUrl);
                                     if (idx === -1) {
                                       if (referenceImages.length >= maxRefs) {
                                         setError(`当前模型最多支持 ${maxRefs} 张参考图`);
                                         setShowAssetPicker(false);
                                         return;
                                       }
                                       idx = referenceImages.length;
                                       setReferenceImages(prev => [...prev, asset.dataUrl]);
                                     }
                                     
                                     // 插入对应的 @图${idx + 1} 到文本中
                                     const textToInsert = `@图${idx + 1} `;
                                     if (cursorPos !== null) {
                                       setPrompt(prev => prev.slice(0, cursorPos) + textToInsert + prev.slice(cursorPos));
                                       setCursorPos(cursorPos + textToInsert.length);
                                     } else {
                                       setPrompt(prev => prev + textToInsert);
                                     }
                                     setShowAssetPicker(false);
                                     setTimeout(() => textareaRef.current?.focus(), 50);
                                   }
                                 }}>
                              {asset.type === 'image' ? (
                                <img src={asset.dataUrl} className="w-full h-full object-cover" />
                              ) : (
                                <video src={asset.dataUrl} className="w-full h-full object-cover" />
                              )}
                              {/* 选中态遮罩与对号 */}
                              {isSelected && (
                                <div className="absolute inset-0 bg-indigo-500/20 flex items-center justify-center">
                                  <div className="bg-indigo-500 rounded-full p-1 shadow-lg">
                                    <Check className="w-4 h-4 text-white" />
                                  </div>
                                </div>
                              )}
                              <button 
                                onClick={(e) => {
                                  e.stopPropagation();
                                  deleteAsset(asset.id).then(() => {
                                    setMyAssets(prev => prev.filter(a => a.id !== asset.id));
                                  });
                                }}
                                className="absolute top-1 right-1 bg-black/70 rounded-full p-1 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-500/90 z-10">
                                <X className="w-3 h-3 text-white" />
                              </button>
                              {asset.type === 'video' && <div className="absolute bottom-1 right-1"><Film className="w-4 h-4 text-white/90 drop-shadow-md" /></div>}
                            </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                )}
                
                {(referenceImages.length > 0 || referenceVideo || referenceAudio) && (
                  <div className="flex items-center gap-2 px-4 pt-3 pb-1 flex-wrap">
                    {referenceVideo && (
                      <div className="relative w-12 h-12 rounded-lg overflow-hidden border border-indigo-500/40 group cursor-pointer shrink-0 hover:border-red-500/30 transition-colors">
                        <video src={referenceVideo} className="w-full h-full object-cover" />
                        <button onClick={() => setReferenceVideo(null)}
                          className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"><X className="w-3.5 h-3.5 text-white" /></button>
                      </div>
                    )}
                    {referenceAudio && (
                      <div className="relative h-12 px-3 flex items-center gap-1.5 rounded-lg border border-indigo-500/40 bg-indigo-500/5 group cursor-pointer shrink-0 hover:border-red-500/30 transition-colors">
                        <span className="text-[10px] text-indigo-300 max-w-[80px] truncate">🔊 包含音频</span>
                        <button onClick={() => setReferenceAudio(null)}
                          className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"><X className="w-3.5 h-3.5 text-white" /></button>
                      </div>
                    )}
                    {referenceImages.map((img, idx) => (
                      <div key={idx} className="relative w-12 h-12 rounded-lg overflow-hidden border border-white/10 group cursor-pointer shrink-0 hover:border-indigo-500/30 transition-colors">
                        <img src={img} alt="" className="w-full h-full object-cover" />
                        {/* 索引代号角标 */}
                        <div className="absolute top-0 left-0 bg-indigo-600/90 text-white text-[9px] px-1 py-0.5 rounded-br font-mono leading-none pointer-events-none group-hover:opacity-0 transition-opacity">
                          ref_{idx}
                        </div>
                        <div className="absolute inset-0 bg-black/70 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-1">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSlicingImageUrl(img);
                              setSlicingImageIndex(idx);
                            }}
                            className="bg-indigo-600 hover:bg-indigo-500 p-0.5 rounded transition-colors"
                            title="智能切分拼图"
                          >
                            <Scissors className="w-3 h-3 text-white" />
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setReferenceImages(prev => prev.filter((_, i) => i !== idx));
                            }}
                            className="bg-red-500/80 hover:bg-red-500 p-0.5 rounded transition-colors"
                            title="删除"
                          >
                            <X className="w-3 h-3 text-white" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <div className="relative flex-1 flex min-h-[80px]">
                  {/* 背景高亮层 */}
                  <div 
                    ref={backdropRef}
                    className="absolute inset-0 pointer-events-none select-none px-4 py-3 pr-4 text-sm text-transparent font-sans leading-relaxed whitespace-pre-wrap break-words overflow-hidden [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:bg-transparent [&::-webkit-scrollbar-track]:bg-transparent"
                  >
                    {renderHighlightedText(prompt)}
                  </div>

                  {/* 前景输入框 */}
                  <textarea 
                    ref={textareaRef} 
                    value={prompt} 
                    onChange={(e) => {
                      const val = e.target.value;
                      const nativeEvent = e.nativeEvent as any;
                      // 监听任意位置输入的 @ 或全角 ＠ 
                      if (nativeEvent.data === '@' || nativeEvent.data === '＠') {
                        setShowAssetPicker(true);
                        // 移除刚刚输入的那个 @ 符号，并记录光标位置
                        const pos = e.target.selectionStart || val.length;
                        const finalPos = Math.max(0, pos - 1);
                        setCursorPos(finalPos);
                        setPrompt(val.slice(0, finalPos) + val.slice(pos));
                      } else {
                        setPrompt(val);
                        // 用户正常打字时重置或更新 cursor
                        setCursorPos(e.target.selectionStart || null);
                      }
                    }}
                    onScroll={(e) => {
                      if (backdropRef.current) {
                        backdropRef.current.scrollTop = e.currentTarget.scrollTop;
                      }
                    }}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleGenerate(); } }}
                    placeholder="描述你想生成的视频内容... (输入 @ 可直接上传参考图)"
                    className={`w-full bg-transparent px-4 py-3 pr-4 text-sm text-transparent caret-white focus:outline-none placeholder:text-zinc-600 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:bg-white/10 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-track]:bg-transparent font-sans leading-relaxed overflow-y-auto ${isMaximized ? 'resize-y' : 'resize-none'}`} 
                  />
                </div>

                {/* 底部辅助工具栏与生成按钮 */}
                <div className="flex items-center justify-between px-4 py-2.5 border-t border-white/[0.04] bg-white/[0.01] rounded-b-2xl flex-wrap gap-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <CustomSelect value={aspectRatio} onChange={setAspectRatio} options={ASPECT_RATIOS} />
                    <CustomSelect value={duration} onChange={(v: number) => setDuration(v)} options={DURATIONS} />
                    <CustomSelect value={resolution} onChange={setResolution} options={RESOLUTIONS} />
                    {(selectedModel === 'omni-flash-vref' || selectedModel === 'sora-v4-fast') && (
                      <>
                        <button onClick={() => videoFileInputRef.current?.click()} className="flex items-center gap-1.5 bg-white/[0.04] hover:bg-white/[0.08] rounded-lg px-2.5 py-1.5 text-[11px] text-zinc-300 transition-colors border border-white/5 hover:border-white/10">
                          <Upload className="w-3 h-3 text-indigo-400" /> 参考视频 {referenceVideo ? '(已上传)' : ''}
                        </button>
                        <input ref={videoFileInputRef} type="file" accept="video/mp4,video/*" className="hidden" onChange={(e) => { handleVideoSelect(e.target.files); e.target.value = ''; }} />
                      </>
                    )}
                    {selectedModel === 'sora-v4-fast' && (
                      <>
                        <button onClick={() => audioFileInputRef.current?.click()} className="flex items-center gap-1.5 bg-white/[0.04] hover:bg-white/[0.08] rounded-lg px-2.5 py-1.5 text-[11px] text-zinc-300 transition-colors border border-white/5 hover:border-white/10">
                          <Upload className="w-3 h-3 text-indigo-400" /> 参考音频 {referenceAudio ? '(已上传)' : ''}
                        </button>
                        <input ref={audioFileInputRef} type="file" accept="audio/*" className="hidden" onChange={(e) => { handleAudioSelect(e.target.files); e.target.value = ''; }} />
                      </>
                    )}
                    <button onClick={() => fileInputRef.current?.click()} className="flex items-center gap-1.5 bg-white/[0.04] hover:bg-white/[0.08] rounded-lg px-2.5 py-1.5 text-[11px] text-zinc-300 transition-colors border border-white/5 hover:border-white/10">
                      <Upload className="w-3 h-3 text-indigo-400" /> 参考图 ({referenceImages.length}/{maxRefs})
                    </button>
                    <div className="group relative flex items-center">
                      <HelpCircle className="w-3.5 h-3.5 text-zinc-500 hover:text-zinc-300 transition-colors cursor-help" />
                      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 p-3 bg-zinc-950 border border-white/10 rounded-xl shadow-2xl text-[10px] text-zinc-400 leading-normal pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity z-50">
                        <p className="font-semibold text-yellow-400 mb-1 flex items-center gap-1">⚠️ 避免使用多格拼图</p>
                        视频模型推荐使用连贯的单镜头画面。使用九宫格等拼图会导致生成失败或变形。如果上传了拼图，可使用参考图上的 <Scissors className="w-3 h-3 inline text-indigo-400" /> 按钮智能切分。
                      </div>
                    </div>
                    <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => { handleFileSelect(e.target.files); e.target.value = ''; }} />
                  </div>

                  <button 
                    onClick={handleGenerate} 
                    disabled={!prompt.trim()}
                    className="w-8 h-8 rounded-full flex items-center justify-center transition-all bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white shadow-lg shadow-indigo-500/20 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer shrink-0"
                    title="生成视频"
                  >
                    <Play className="w-3.5 h-3.5 ml-0.5" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      
      {/* 全局拖拽遮罩 */}
      {isDragging && (
        <div className="fixed inset-0 z-[100] bg-indigo-500/10 backdrop-blur-sm border-4 border-indigo-500/50 border-dashed m-4 rounded-3xl flex items-center justify-center pointer-events-none transition-all">
          <div className="bg-black/60 px-8 py-6 rounded-2xl flex flex-col items-center shadow-2xl">
            <Upload className="w-12 h-12 text-indigo-400 mb-3 animate-bounce" />
            <p className="text-xl font-semibold text-white">松开鼠标即可上传</p>
            <p className="text-sm text-zinc-400 mt-2">支持拖拽图片或视频 (将自动加入资产库)</p>
          </div>
        </div>
      )}

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

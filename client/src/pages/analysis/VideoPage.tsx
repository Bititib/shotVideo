import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Video, Play, Square, Download, Loader2, Check, AlertCircle, Sparkles, Monitor, Smartphone, RectangleHorizontal, Upload, X, Film, RotateCcw, Maximize2, Minimize2, Scissors, HelpCircle } from 'lucide-react';
import { fetchVideoModels, generateVideo, type VideoModel, type VideoSSEEvent } from '../../api/video';
import ImageSlicerModal from '../../components/ImageSlicerModal';
import { contentApi } from '../../api/content';
import { useImageDropPaste } from '../../hooks/useImageDropPaste';
import { useAuthGuard } from '../../hooks/useAuthGuard';
import { saveAsset, getAssets, deleteAsset, type Asset } from '../../utils/idb';
import { useAuthStore } from '../../stores/authStore';

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
function getVideoPlayUrl(url: string | null) {
  if (!url) return '';
  if (url.startsWith('/') || url.startsWith('http://localhost') || url.startsWith('http://127.0.0.1')) {
    return url;
  }
  return `/api/video/play?url=${encodeURIComponent(url)}`;
}

const isFlatRateModel = (modelId: string) => {
  return [
    'seedance-2.0-fast',
    'sd2-c7',
    'seedance-2.0-720p',
    'seedance-2.0-fast-720p',
    'grok-imagine-1.0-video',
    'grok-imagine-video-1.5-1080p',
    'grok-imagine-video-1.5-fast',
    'grok-imagine-video-1.5-preview',
    'sdas-pg-s2.0-fast'
  ].includes(modelId);
};
interface WoodenFishLoaderProps {
  progress: number;
  statusMessage?: string;
}

function WoodenFishLoader({ progress, statusMessage }: WoodenFishLoaderProps) {
  const [floats, setFloats] = useState<{ id: number; text: string; x: number; y: number }[]>([]);
  const [strike, setStrike] = useState(false);
  const floatIdRef = useRef(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setStrike(true);
      const id = floatIdRef.current++;
      const text = `进度 ${progress}%`;
      const x = Math.floor(Math.random() * 20) - 10;
      const y = Math.floor(Math.random() * 10) - 5;
      
      setFloats(prev => [...prev, { id, text, x, y }]);
      
      setTimeout(() => setStrike(false), 150);
      setTimeout(() => {
        setFloats(prev => prev.filter(f => f.id !== id));
      }, 1500);
    }, 1200);

    return () => clearInterval(interval);
  }, [progress]);

  return (
    <div className="flex flex-col items-center justify-center h-full w-full select-none relative py-2 bg-zinc-950/20 rounded-2xl">
      <style>{`
        @keyframes fishFloat {
          0% {
            transform: translateY(0) scale(0.85);
            opacity: 0;
          }
          15% {
            transform: translateY(-6px) scale(1.05);
            opacity: 1;
          }
          100% {
            transform: translateY(-40px) scale(0.9);
            opacity: 0;
          }
        }
        @keyframes woodenStrike {
          0% { transform: rotate(0deg); }
          45% { transform: rotate(-22deg); }
          75% { transform: rotate(10deg); }
          100% { transform: rotate(0deg); }
        }
        @keyframes fishSquish {
          0% { transform: scale(1); }
          30% { transform: scale(0.91, 0.95); }
          60% { transform: scale(1.04, 1.01); }
          100% { transform: scale(1); }
        }
      `}</style>

      {/* 飘字容器 */}
      <div className="absolute inset-x-0 bottom-[62px] top-0 pointer-events-none overflow-hidden flex items-end justify-center z-30">
        <div className="relative w-full h-full">
          {floats.map(f => (
            <div
              key={f.id}
              style={{
                left: `calc(50% + ${f.x}px - 40px)`,
                transform: `translateY(${f.y}px)`,
                animation: 'fishFloat 1.4s ease-out forwards'
              }}
              className="absolute bottom-6 w-20 text-center text-[11px] font-bold text-indigo-300 font-sans tracking-wide"
            >
              {f.text}
            </div>
          ))}
        </div>
      </div>

      {/* 核心图形区 */}
      <div className="relative w-28 h-20 flex items-center justify-center mb-1">
        {/* 木槌 */}
        <div 
          style={{
            animation: strike ? 'woodenStrike 0.18s ease-in-out' : 'none'
          }}
          className="absolute right-4 top-1 w-10 h-10 origin-[80%_20%] z-20 pointer-events-none"
        >
          <svg className="w-full h-full filter drop-shadow-[0_2px_4px_rgba(0,0,0,0.5)]" viewBox="0 0 40 40">
            <path d="M12 28 L28 12" stroke="#d97706" strokeWidth="2.5" strokeLinecap="round" />
            <circle cx="10" cy="30" r="4.5" fill="#78350f" />
          </svg>
        </div>

        {/* 木鱼 */}
        <div 
          style={{
            animation: strike ? 'fishSquish 0.15s ease-out' : 'none'
          }}
          className="w-16 h-16 origin-center transition-transform"
        >
          <svg className="w-full h-full filter drop-shadow-[0_4px_8px_rgba(0,0,0,0.6)]" viewBox="0 0 64 64">
            <path 
              d="M32 10 C16 10, 8 24, 8 38 C8 48, 16 52, 32 52 C48 52, 56 48, 56 38 C56 24, 48 10, 32 10 Z" 
              fill="url(#fishGrad)" 
            />
            <path d="M18 42 Q32 30 46 42" stroke="#3b1901" strokeWidth="2.5" fill="none" strokeLinecap="round" />
            <circle cx="20" cy="24" r="3.5" fill="#3b1901" />
            <defs>
              <linearGradient id="fishGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#d97706" />
                <stop offset="60%" stopColor="#78350f" />
                <stop offset="100%" stopColor="#451a03" />
              </linearGradient>
            </defs>
          </svg>
        </div>
      </div>

      {/* 底部信息 */}
      <div className="text-center z-10 px-2 w-full">
        <div className="text-xs font-bold text-white/90 tabular-nums">
          生成进度 {progress}%
        </div>
        <p className="text-[10px] text-zinc-500 truncate mt-0.5 max-w-[180px] mx-auto">{statusMessage || '正在生成...'}</p>
      </div>
    </div>
  );
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
  { value: 1, label: '1 秒' }, { value: 2, label: '2 秒' },
  { value: 3, label: '3 秒' }, { value: 4, label: '4 秒' },
  { value: 5, label: '5 秒' }, { value: 6, label: '6 秒' },
  { value: 7, label: '7 秒' }, { value: 8, label: '8 秒' },
  { value: 9, label: '9 秒' }, { value: 10, label: '10 秒' },
  { value: 11, label: '11 秒' }, { value: 12, label: '12 秒' },
  { value: 13, label: '13 秒' }, { value: 14, label: '14 秒' },
  { value: 15, label: '15 秒' }, { value: 16, label: '16 秒' },
  { value: 20, label: '20 秒' }, { value: 30, label: '30 秒' },
];
const isSoraV4Model = (modelId: string) => {
  return modelId === 'seedance-2.0-fast' || modelId === 'seedance-2.0' || modelId === 'sora-v4-fast' || modelId === 'sora-v4-pro';
};

const getMaxReferenceImages = (modelId: string, models: VideoModel[]) => {
  if (modelId === 'seedance2.0-full-4img' || modelId === 'seedance2.0-fast-4img') return 4;
  if (modelId === 'seedance2.0-full-9img') return 9;
  if (modelId === 'grok-imagine-1.0-video' || modelId === 'grok-imagine-video-1.5-fast') return 7;
  if (modelId === 'grok-imagine-video-1.5-1080p' || modelId === 'grok-imagine-video-1.5-preview') return 1;
  if (modelId === 'sdas-pg-s2.0-fast') return 5;
  if (modelId.startsWith('sd-') || modelId.startsWith('seedance-') || modelId.includes('sdas-') || modelId.startsWith('lg-')) return 9;
  if (isSoraV4Model(modelId)) return 4;
  if (modelId === 'omni-flash') return 7;
  if (modelId === 'omni-flash-vref') return 5;
  if (modelId === 'veo-omni-flash') return 6;
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
  return targetPrompt
    .replace(/\[ref_(\d+)(?:\.[a-zA-Z0-9]+)?\]/g, (match, idxStr) => {
      const idx = parseInt(idxStr, 10);
      return `@图${idx + 1}`;
    })
    .replace(/\[ref_video\]/g, '@视频')
    .replace(/\[ref_audio\]/g, '@音频');
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

  const [referenceVideos, setReferenceVideos] = useState<string[]>([]);
  const [referenceAudios, setReferenceAudios] = useState<string[]>([]);
  const [referenceAudioNames, setReferenceAudioNames] = useState<string[]>([]);
  const [firstFrame, setFirstFrame] = useState<string | null>(null);
  const [lastFrame, setLastFrame] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoFileInputRef = useRef<HTMLInputElement>(null);
  const audioFileInputRef = useRef<HTMLInputElement>(null);

  // 各模型的参考视频/音频上限
  const getMaxRefVideos = (m: string) => {
    if (m.startsWith('seedance2.0-')) return 3;
    if (m === 'sdas-pg-s2.0-fast') return 1;
    if (m.includes('sdas-') || m.startsWith('sd-') || m.startsWith('seedance-') || m.startsWith('lg-')) return 3;
    if (m === 'omni-flash-vref') return 1;
    return 0;
  };
  const getMaxRefAudios = (m: string) => {
    if (m.startsWith('seedance2.0-')) return 3;
    if (m === 'sdas-pg-s2.0-fast') return 0;
    if (m.includes('sdas-') || m.startsWith('sd-') || m.startsWith('seedance-') || m.startsWith('lg-')) return 3;
    return 0;
  };
  const maxRefVideos = getMaxRefVideos(selectedModel);
  const maxRefAudios = getMaxRefAudios(selectedModel);
  const firstFrameInputRef = useRef<HTMLInputElement>(null);
  const lastFrameInputRef = useRef<HTMLInputElement>(null);
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
    const splitRegex = /([@＠]图\d+|[@＠]视频\d*|[@＠]音频\d*)/g;
    const parts = text.split(splitRegex);
    return parts.map((part, index) => {
      if (/^[@＠]图\d+$/.test(part)) {
        const match = part.match(/\d+/);
        const idx = match ? parseInt(match[0], 10) - 1 : -1;
        const exists = idx >= 0 && idx < referenceImages.length;

        return (
          <span
            key={index}
            className={`inline rounded transition-colors ${exists
                ? 'text-indigo-400 bg-indigo-500/15 font-sans'
                : 'text-zinc-500 bg-zinc-500/10 line-through decoration-zinc-600 font-sans'
              }`}
          >
            {part}
          </span>
        );
      }

      if (/^[@＠]视频\d*$/.test(part)) {
        const numMatch = part.match(/\d+/);
        const vidIdx = numMatch ? parseInt(numMatch[0], 10) - 1 : 0;
        const exists = vidIdx >= 0 && vidIdx < referenceVideos.length;
        return (
          <span
            key={index}
            className={`inline rounded transition-colors px-1 ${exists
                ? 'text-purple-400 bg-purple-500/20 font-sans font-medium'
                : 'text-zinc-500 bg-zinc-500/10 line-through decoration-zinc-600 font-sans'
              }`}
          >
            {part}
          </span>
        );
      }

      if (/^[@＠]音频\d*$/.test(part)) {
        const numMatch = part.match(/\d+/);
        const audIdx = numMatch ? parseInt(numMatch[0], 10) - 1 : 0;
        const exists = audIdx >= 0 && audIdx < referenceAudios.length;
        return (
          <span
            key={index}
            className={`inline rounded transition-colors px-1 ${exists
                ? 'text-emerald-400 bg-emerald-500/20 font-sans font-medium'
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

  const insertTextAtCursor = (textToInsert: string) => {
    const textarea = textareaRef.current;
    const currentScrollTop = textarea ? textarea.scrollTop : 0;

    let insertPos = cursorPos;
    if (insertPos === null || insertPos < 0) {
      insertPos = textarea ? textarea.selectionStart : prompt.length;
    }

    const newPrompt = prompt.slice(0, insertPos) + textToInsert + prompt.slice(insertPos);
    const nextCursorPos = insertPos + textToInsert.length;

    setPrompt(newPrompt);
    setCursorPos(nextCursorPos);
    setShowAssetPicker(false);

    requestAnimationFrame(() => {
      if (textarea) {
        textarea.focus();
        textarea.setSelectionRange(nextCursorPos, nextCursorPos);
        textarea.scrollTop = currentScrollTop;
        if (backdropRef.current) {
          backdropRef.current.scrollTop = currentScrollTop;
        }
      }
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
    fetchVideoModels().then((m) => { setModels(m); if (m.length > 0 && !selectedModel) setSelectedModel(m[0].id); }).catch(() => { });

    // 加载历史与生产中生成记录
    contentApi.getMyContents({ type: 'video', pageSize: 50 })
      .then((res: any) => {
        const items = res?.items || res?.data || [];
        const parsed = items.map((item: any) => {
          let meta = {};
          try {
            meta = item.metadata ? (typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata) : {};
          } catch { }
          return { ...item, metadata: meta };
        });

        // 已完成或已失败的记录计入历史面板
        setHistory(parsed.filter((item: any) => item.status === 'completed' || item.status === 'success' || item.resultUrl));

        // 正在生产中的记录恢复到 tasks 队列中继续展示生成进度
        const processingTasks: VideoTask[] = parsed
          .filter((item: any) => item.status === 'processing')
          .map((item: any) => ({
            id: `db_${item.id}`,
            prompt: item.inputText || item.title || '',
            status: 'generating',
            progress: 0,
            statusMessage: '正在后台恢复生成...',
            videoUrl: null,
            error: null,
            metadata: item.metadata as any,
            createdAt: item.createdAt,
          }));
        setTasks(processingTasks);
      })
      .catch(() => { });

    // 加载本地资产库
    getAssets().then(setMyAssets).catch(() => { });
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
              useAuthStore.getState().fetchProfile().catch(() => {});
              // 延迟后刷新历史记录
              setTimeout(() => {
                contentApi.getMyContents({ type: 'video', pageSize: 50 })
                  .then((r: any) => {
                    const items = r?.items || r?.data || [];
                    const parsed = items.map((item: any) => {
                      let meta = {};
                      try {
                        meta = item.metadata ? (typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata) : {};
                      } catch { }
                      return { ...item, metadata: meta };
                    });
                    setHistory(parsed.filter((x: any) => x.status === 'completed' || x.status === 'success' || x.resultUrl));
                    // 历史已加载，从当前任务中移除
                    setTasks(prev => prev.filter(t => t.id !== task.id));
                  }).catch(() => { });
              }, 2000);
            } else if (item.status === 'failed') {
              setTasks(prev => prev.map(t => t.id === task.id ? {
                ...t,
                status: 'error',
                statusMessage: '',
                error: item.metadata?.error || '生成失败'
              } : t));
              useAuthStore.getState().fetchProfile().catch(() => {});
            } else {
              // processing 状态：从 metadata.progress 读取实时进度
              let meta: any = {};
              try { meta = typeof item.metadata === 'string' ? JSON.parse(item.metadata) : (item.metadata || {}); } catch { }
              const p = meta.progress || 0;
              setTasks(prev => prev.map(t => t.id === task.id ? {
                ...t,
                progress: p,
                statusMessage: p > 0 ? `视频生成中 ${p}%` : '正在后台生成中...'
              } : t));
            }
          })
          .catch(() => { });
      });
    }, 5000);

    return () => {
      active = false;
      clearInterval(intervalId);
    };
  }, [tasks]);

  // 自动调整输入框高度，并同步高亮层高度
  useEffect(() => {
    const textarea = textareaRef.current;
    const backdrop = backdropRef.current;
    if (textarea) {
      if (isMaximized) {
        textarea.style.height = '360px';
      } else {
        textarea.style.height = 'auto';
        textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
      }
      // 同步高亮背景层高度，避免层叠错位
      if (backdrop) {
        backdrop.style.height = textarea.style.height;
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

  const isOmniModel = selectedModel.startsWith('omni-flash') || selectedModel === 'veo-omni-flash';
  const RESOLUTIONS = currentModel?.rates
    ? Object.keys(currentModel.rates)
        .sort((a, b) => parseInt(a) - parseInt(b))
        .map(r => ({ value: r, label: r }))
    : isOmniModel
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
    // 自动修正分辨率：如果当前分辨率不在该模型支持的选项中，回退到第一个可用选项
    const validResolutions = RESOLUTIONS.map(r => r.value);
    if (!validResolutions.includes(resolution)) {
      setResolution(validResolutions[validResolutions.length - 1] || '720p');
    }
    if (isOmniModel) {
      if (aspectRatio !== '16:9' && aspectRatio !== '9:16') {
        setAspectRatio('16:9');
      }
    }

    const isSudashui = selectedModel.startsWith('sd-') || selectedModel.startsWith('seedance-') || selectedModel.includes('sdas-') || selectedModel.startsWith('lg-');
    const isSoraV3Pro = selectedModel === 'seedance-2.0-fast';
    if (selectedModel !== 'omni-flash-vref' && !isSudashui && !isSoraV3Pro) {
      setReferenceVideos([]);
    }
    if (!isSudashui && !isSoraV3Pro) {
      setReferenceAudios([]);
      setReferenceAudioNames([]);
    }
    if (!isSoraV3Pro) {
      setFirstFrame(null);
      setLastFrame(null);
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
        saveAsset(newAsset).then(() => setMyAssets(prev => [newAsset, ...prev])).catch(() => { });
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
    const readFile = (f: File) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        setReferenceVideos(prev => {
          if (prev.length >= maxRefVideos) return prev;
          return [...prev, dataUrl];
        });
        const newAsset: Asset = {
          id: `vid_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
          name: f.name,
          dataUrl,
          type: 'video',
          createdAt: Date.now()
        };
        saveAsset(newAsset).then(() => setMyAssets(prev => [newAsset, ...prev])).catch(() => { });
      };
      reader.onerror = () => setError('读取视频失败');
      reader.readAsDataURL(f);
    };
    const remaining = maxRefVideos - referenceVideos.length;
    const filesToRead = Array.from(files).filter(f => f.type.startsWith('video/')).slice(0, remaining > 0 ? remaining : 0);
    if (filesToRead.length === 0 && remaining <= 0) {
      setError(`最多只能上传 ${maxRefVideos} 个参考视频`);
      return;
    }
    for (const f of filesToRead) {
      if (f.size > 100 * 1024 * 1024) { setError('参考视频不能超过 100MB'); continue; }
      readFile(f);
    }
  };

  const handleAudioSelect = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const remaining = maxRefAudios - referenceAudios.length;
    const audioFiles = Array.from(files).filter(f => f.type.startsWith('audio/')).slice(0, remaining > 0 ? remaining : 0);
    if (audioFiles.length === 0 && remaining <= 0) {
      setError(`最多只能上传 ${maxRefAudios} 个参考音频`);
      return;
    }
    for (const file of audioFiles) {
      if (file.size > 20 * 1024 * 1024) {
        setError('参考音频不能超过 20MB');
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        setReferenceAudios(prev => {
          if (prev.length >= maxRefAudios) return prev;
          return [...prev, dataUrl];
        });
        setReferenceAudioNames(prev => [...prev, file.name]);
      };
      reader.onerror = () => setError('读取音频失败');
      reader.readAsDataURL(file);
    }
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
      setReferenceVideos(meta.reference_videos || (meta.reference_video ? [meta.reference_video] : []));
      setReferenceAudios(meta.audio_urls || (meta.audio_url ? [meta.audio_url] : []));
      setReferenceAudioNames(meta.audio_names || []);
    }

    setTimeout(() => {
      textareaRef.current?.focus();
    }, 50);
  };

  const handleGenerate = useCallback(() => {
    if (!prompt.trim()) return;
    if (!guard()) return;
    if (selectedModel === 'omni-flash-vref' && referenceVideos.length === 0) {
      setError('视频编辑模型必须上传参考视频');
      return;
    }
    setError(null);

    // 将 prompt 中的 @图1, @图2, @视频, @音频 翻译回后端 API 支持的 [ref_0.jpg], [ref_video], [ref_audio] 格式
    let finalPrompt = prompt.trim();
    referenceImages.forEach((img, idx) => {
      const refName = getRefFilename(img, idx);
      const userRefLabelPattern = new RegExp(`[@＠]图${idx + 1}\\b|[@＠]图${idx + 1}`, 'g');
      finalPrompt = finalPrompt.replace(userRefLabelPattern, `[${refName}]`);
    });
    finalPrompt = finalPrompt.replace(/[@＠]视频(\d+)?/g, (_, n) => `[ref_video_${n || '1'}]`);
    finalPrompt = finalPrompt.replace(/[@＠]音频(\d+)?/g, (_, n) => `[ref_audio_${n || '1'}]`);

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
        reference_videos: referenceVideos,
        audio_urls: referenceAudios
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
        reference_videos: referenceVideos.length > 0 ? referenceVideos : undefined,
        audio_urls: referenceAudios.length > 0 ? referenceAudios : undefined,
        first_frame: firstFrame || undefined,
        last_frame: lastFrame || undefined,
      },
      (event: VideoSSEEvent) => {
        // 如果已经被主动取消，忽略后续所有事件以防竞态将 ID 改为 db_ 后台轮询
        if (!abortRef.current.has(taskId)) return;

        switch (event.type) {
          case 'content_id':
            updateTask({ dbId: event.contentId });
            break;
          case 'status': updateTask({ statusMessage: event.message || '' }); break;
          case 'progress': updateTask({ progress: event.progress || 0, statusMessage: `视频生成中 ${event.progress}%` }); break;
          case 'complete':
            updateTask({ status: 'complete', progress: 100, videoUrl: event.videoUrl || null, statusMessage: '' });
            abortRef.current.delete(taskId);
            useAuthStore.getState().fetchProfile().catch(() => {});
            break;
          case 'error':
            updateTask({ status: 'error', error: event.message || '生成失败', statusMessage: '' });
            abortRef.current.delete(taskId);
            useAuthStore.getState().fetchProfile().catch(() => {});
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
    setReferenceVideos([]);
    setReferenceAudios([]);
    setReferenceAudioNames([]);
    setFirstFrame(null);
    setLastFrame(null);
  }, [prompt, selectedModel, aspectRatio, duration, resolution, referenceImages, referenceVideos, referenceAudios, firstFrame, lastFrame]);

  const handleRemove = (taskId: string) => {
    if (taskId.startsWith('db_')) {
      const dbId = parseInt(taskId.replace('db_', ''), 10);
      if (!isNaN(dbId)) {
        contentApi.delete(dbId).catch(err => {
          console.error('Failed to delete content from db:', err);
        });
      }
    } else {
      const task = tasks.find(t => t.id === taskId);
      if (task?.dbId) {
        contentApi.delete(task.dbId).catch(err => {
          console.error('Failed to delete content from db:', err);
        });
      }
    }
    setTasks(prev => prev.filter(t => t.id !== taskId));
  };

  const handleCancel = (taskId: string) => {
    abortRef.current.get(taskId)?.abort();
    abortRef.current.delete(taskId);
    handleRemove(taskId);
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
                          ¥{m.rates[resolution as keyof typeof m.rates]?.toFixed(2)}{isFlatRateModel(m.id) ? '/次' : '/秒'}
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
                          <span>1080p: <span className="text-zinc-400">¥{m.rates['1080p']?.toFixed(2)}{isFlatRateModel(m.id) ? '/次' : '/秒'}</span></span>
                          <span className="text-zinc-800">•</span>
                          <span>720p: <span className="text-zinc-400">¥{m.rates['720p']?.toFixed(2)}{isFlatRateModel(m.id) ? '/次' : '/秒'}</span></span>
                        </>
                      ) : (
                        <>
                          <span>720p: <span className="text-zinc-400">¥{m.rates['720p']?.toFixed(2)}{isFlatRateModel(m.id) ? '/次' : '/秒'}</span></span>
                          {m.rates['480p'] !== undefined && (
                            <>
                              <span className="text-zinc-800">•</span>
                              <span>480p: <span className="text-zinc-400">¥{m.rates['480p']?.toFixed(2)}{isFlatRateModel(m.id) ? '/次' : '/秒'}</span></span>
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
        <div className={`flex-1 overflow-y-auto p-6 ${isMaximized ? 'pb-[440px]' : 'pb-64'} [&::-webkit-scrollbar]:hidden`} style={{ scrollbarWidth: 'none' }}>
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
                            <WoodenFishLoader progress={task.progress} statusMessage={task.statusMessage} />
                          ) : task.status === 'complete' && task.videoUrl ? (
                            <>
                              <video src={getVideoPlayUrl(task.videoUrl)} className={`w-full h-full ${isVertical(task.metadata.aspect_ratio) ? 'object-contain' : 'object-cover'}`} preload="metadata" playsInline muted loop
                                onMouseEnter={(e) => e.currentTarget.play().catch(() => { })}
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
                                <button onClick={() => handleRemove(task.id)} className="text-[10px] text-zinc-500 hover:text-red-400 transition-colors" title="移除">
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
                          <video src={getVideoPlayUrl(h.resultUrl)} className={`w-full h-full ${isVertical(h.metadata?.aspect_ratio) ? 'object-contain' : 'object-cover'}`} preload="metadata" playsInline muted loop
                            onMouseEnter={(e) => e.currentTarget.play().catch(() => { })}
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
              <video src={getVideoPlayUrl(playingVideo.url)} controls autoPlay className="w-full max-h-[75vh] rounded-2xl shadow-2xl bg-black" />
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

        {/* 输入区（悬浮于底部，背景透明，支持穿透点击） */}
        <div className="absolute bottom-0 left-0 right-0 z-10 bg-transparent pointer-events-none">
          {error && (
            <div className="absolute bottom-full left-6 right-6 mb-3 z-20 px-4 py-2.5 bg-red-500/10 border border-red-500/20 rounded-xl text-sm text-red-400 flex items-center gap-2 backdrop-blur-md shadow-2xl pointer-events-auto">
              <AlertCircle className="w-4 h-4 shrink-0" /><span className="flex-1">{error}</span>
              <button onClick={() => setError(null)} className="text-red-500/60 hover:text-red-400 text-xs">✕</button>
            </div>
          )}

          <div className="px-6 py-4 pointer-events-auto">
            <div className="max-w-3xl mx-auto">
              <div className="relative bg-[#0c0c0c] border border-white/[0.08] focus-within:border-indigo-500/30 rounded-2xl transition-all shadow-2xl shadow-black/30 flex flex-col">

                {/* 参数工具栏 — 卡片顶部 */}
                <div className="flex items-center gap-2 px-4 py-2 border-b border-white/[0.04] flex-wrap rounded-t-2xl">
                  <CustomSelect value={aspectRatio} onChange={setAspectRatio} options={ASPECT_RATIOS} />
                  <CustomSelect value={duration} onChange={(v: number) => setDuration(v)} options={DURATIONS} />
                  <CustomSelect value={resolution} onChange={setResolution} options={RESOLUTIONS} />
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

                  {(selectedModel === 'omni-flash-vref' || isSoraV4Model(selectedModel) || selectedModel?.startsWith('sd-') || selectedModel?.startsWith('seedance-') || selectedModel?.includes('sdas-') || selectedModel?.startsWith('lg-')) && (
                    <>
                      <button onClick={() => videoFileInputRef.current?.click()} className="flex items-center gap-1.5 bg-white/[0.04] hover:bg-white/[0.08] rounded-lg px-2.5 py-1.5 text-[11px] text-zinc-300 transition-colors border border-white/5 hover:border-white/10">
                        <Upload className="w-3 h-3 text-indigo-400" /> 参考视频 {referenceVideos.length > 0 ? `(${referenceVideos.length}/${maxRefVideos})` : ''}
                      </button>
                      <input ref={videoFileInputRef} type="file" accept="video/mp4,video/*" multiple className="hidden" onChange={(e) => { handleVideoSelect(e.target.files); e.target.value = ''; }} />
                    </>
                  )}
                  {maxRefAudios > 0 && (
                    <>
                      <button onClick={() => audioFileInputRef.current?.click()} className="flex items-center gap-1.5 bg-white/[0.04] hover:bg-white/[0.08] rounded-lg px-2.5 py-1.5 text-[11px] text-zinc-300 transition-colors border border-white/5 hover:border-white/10">
                        <Upload className="w-3 h-3 text-indigo-400" /> 参考音频 {referenceAudios.length > 0 ? `(${referenceAudios.length}/${maxRefAudios})` : ''}
                      </button>
                      <input ref={audioFileInputRef} type="file" accept="audio/*" multiple className="hidden" onChange={(e) => { handleAudioSelect(e.target.files); e.target.value = ''; }} />
                    </>
                  )}
                  {isSoraV4Model(selectedModel) && (
                    <>
                      <button onClick={() => firstFrameInputRef.current?.click()} className="flex items-center gap-1.5 bg-white/[0.04] hover:bg-white/[0.08] rounded-lg px-2.5 py-1.5 text-[11px] text-zinc-300 transition-colors border border-white/5 hover:border-white/10">
                        <Upload className="w-3 h-3 text-emerald-400" /> 首帧 {firstFrame ? '(已上传)' : ''}
                      </button>
                      <input ref={firstFrameInputRef} type="file" accept="image/*" className="hidden" onChange={async (e) => { if (e.target.files?.[0]) { const url = await compressImage(e.target.files[0]); setFirstFrame(url); } e.target.value = ''; }} />
                              <button onClick={() => lastFrameInputRef.current?.click()} className="flex items-center gap-1.5 bg-white/[0.04] hover:bg-white/[0.08] rounded-lg px-2.5 py-1.5 text-[11px] text-zinc-300 transition-colors border border-white/5 hover:border-white/10">
                        <Upload className="w-3 h-3 text-amber-400" /> 尾帧 {lastFrame ? '(已上传)' : ''}
                      </button>
                      <input ref={lastFrameInputRef} type="file" accept="image/*" className="hidden" onChange={async (e) => { if (e.target.files?.[0]) { const url = await compressImage(e.target.files[0]); setLastFrame(url); } e.target.value = ''; }} />
                    </>
                  )}
                </div>

                {/* 标题栏 */}
                <div className="flex items-center justify-between px-4 py-2 border-b border-white/[0.04] text-[11px] text-zinc-500 bg-white/[0.01]">
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
                      <span className="text-xs font-semibold text-zinc-400 font-medium">选择素材引用 (@)</span>
                      <button onClick={() => setShowAssetPicker(false)} className="text-zinc-500 hover:text-white"><X className="w-3.5 h-3.5" /></button>
                    </div>

                    {/* 第一部分：已上传素材列表 (直接在文本中@引用) */}
                    {(referenceImages.length > 0 || referenceVideos.length > 0 || referenceAudios.length > 0) && (
                      <div className="mb-3 pb-3 border-b border-white/5">
                        <span className="text-[10px] text-zinc-500 mb-2 block px-1 font-semibold">已上传素材 (点击引用至文本)</span>
                        <div className="flex flex-col gap-1 max-h-40 overflow-y-auto [&::-webkit-scrollbar]:hidden" style={{ scrollbarWidth: 'none' }}>
                          {referenceImages.map((img, idx) => (
                            <div
                              key={`uploaded_img_${idx}`}
                              onClick={() => insertTextAtCursor(`@图${idx + 1} `)}
                              className="flex items-center gap-3 px-2 py-1.5 rounded-lg cursor-pointer hover:bg-indigo-500/10 group transition-all text-xs text-zinc-300 hover:text-indigo-400"
                              title={`点击在光标处插入 @图${idx + 1}`}
                            >
                              <img src={img} className="w-8 h-8 rounded-lg object-cover border border-white/5" />
                              <span className="font-medium group-hover:text-indigo-400">@图{idx + 1}</span>
                            </div>
                          ))}

                          {referenceVideos.map((vid, idx) => (
                            <div
                              key={`uploaded_vid_${idx}`}
                              onClick={() => insertTextAtCursor(`@视频${idx + 1} `)}
                              className="flex items-center gap-3 px-2 py-1.5 rounded-lg cursor-pointer hover:bg-purple-500/10 group transition-all text-xs text-purple-300 hover:text-purple-400"
                              title={`点击在光标处插入 @视频${idx + 1}`}
                            >
                              <div className="w-8 h-8 rounded-lg overflow-hidden border border-purple-500/30 bg-black shrink-0 flex items-center justify-center">
                                <Film className="w-4 h-4 text-purple-400" />
                              </div>
                              <span className="font-medium group-hover:text-purple-400">@视频{idx + 1}</span>
                            </div>
                          ))}

                          {referenceAudios.map((aud, idx) => (
                            <div
                              key={`uploaded_aud_${idx}`}
                              onClick={() => insertTextAtCursor(`@音频${idx + 1} `)}
                              className="flex items-center gap-3 px-2 py-1.5 rounded-lg cursor-pointer hover:bg-emerald-500/10 group transition-all text-xs text-emerald-300 hover:text-emerald-400"
                              title={`点击在光标处插入 @音频${idx + 1}`}
                            >
                              <div className="w-8 h-8 rounded-lg overflow-hidden border border-emerald-500/30 bg-emerald-500/10 shrink-0 flex items-center justify-center">
                                <span className="text-sm">🔊</span>
                              </div>
                              <span className="font-medium group-hover:text-emerald-400">@音频{idx + 1} {referenceAudioNames[idx] ? `(${referenceAudioNames[idx]})` : ''}</span>
                            </div>
                          ))}
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
                            const isSelected = asset.type === 'video' ? referenceVideos.includes(asset.dataUrl) : referenceImages.includes(asset.dataUrl);

                            return (
                              <div key={asset.id} className={`relative group aspect-square rounded-lg overflow-hidden border cursor-pointer bg-black/50 transition-all ${isSelected ? 'border-indigo-500 shadow-[0_0_0_2px_rgba(99,102,241,0.3)]' : 'border-white/10 hover:border-indigo-500/50'}`}
                                onClick={() => {
                                  if (asset.type === 'video') {
                                    if (referenceVideos.length >= maxRefVideos) {
                                      setError(`当前模型最多支持 ${maxRefVideos} 个参考视频`);
                                      setShowAssetPicker(false);
                                      return;
                                    }
                                    const vidIdx = referenceVideos.length;
                                    setReferenceVideos(prev => [...prev, asset.dataUrl]);
                                    insertTextAtCursor(`@视频${vidIdx + 1} `);
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
                                    insertTextAtCursor(`@图${idx + 1} `);
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

                {(referenceImages.length > 0 || referenceVideos.length > 0 || referenceAudios.length > 0) && (
                  <div className="flex items-center gap-2 px-4 pt-3 pb-1 flex-wrap">
                    {referenceVideos.map((v, idx) => (
                      <div key={`pv_${idx}`} className="relative w-12 h-12 rounded-lg overflow-hidden border border-indigo-500/40 group cursor-pointer shrink-0 hover:border-red-500/30 transition-colors">
                        <video src={v} className="w-full h-full object-cover" />
                        <div className="absolute top-0 left-0 bg-purple-600/90 text-white text-[9px] px-1 py-0.5 rounded-br font-mono leading-none pointer-events-none group-hover:opacity-0 transition-opacity">V{idx + 1}</div>
                        <button onClick={() => setReferenceVideos(prev => prev.filter((_, i) => i !== idx))}
                          className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"><X className="w-3.5 h-3.5 text-white" /></button>
                      </div>
                    ))}
                    {referenceAudios.map((a, idx) => (
                      <div key={`pa_${idx}`} className="relative h-12 px-3 flex items-center gap-1.5 rounded-lg border border-indigo-500/40 bg-indigo-500/5 group cursor-pointer shrink-0 hover:border-red-500/30 transition-colors">
                        <span className="text-[10px] text-indigo-300 max-w-[100px] truncate" title={referenceAudioNames[idx] || `音频${idx + 1}`}>🔊 {referenceAudioNames[idx] || `音频${idx + 1}`}</span>
                        <button onClick={() => { setReferenceAudios(prev => prev.filter((_, i) => i !== idx)); setReferenceAudioNames(prev => prev.filter((_, i) => i !== idx)); }}
                          className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"><X className="w-3.5 h-3.5 text-white" /></button>
                      </div>
                    ))}
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
                    className="absolute inset-0 pointer-events-none select-none px-4 py-3 pr-16 text-sm text-zinc-300 font-sans leading-relaxed whitespace-pre-wrap break-words overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:bg-transparent [&::-webkit-scrollbar-track]:bg-transparent"
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
                      const currentScrollTop = e.target.scrollTop;
                      // 监听任意位置输入的 @ 或全角 ＠ 
                      if (nativeEvent.data === '@' || nativeEvent.data === '＠') {
                        setShowAssetPicker(true);
                        // 移除刚刚输入的那个 @ 符号，并记录光标位置
                        const pos = e.target.selectionStart || val.length;
                        const finalPos = Math.max(0, pos - 1);
                        setCursorPos(finalPos);
                        setPrompt(val.slice(0, finalPos) + val.slice(pos));

                        requestAnimationFrame(() => {
                          if (textareaRef.current) {
                            textareaRef.current.setSelectionRange(finalPos, finalPos);
                            textareaRef.current.scrollTop = currentScrollTop;
                            if (backdropRef.current) backdropRef.current.scrollTop = currentScrollTop;
                          }
                        });
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
                    className={`w-full bg-transparent px-4 py-3 pr-16 text-sm text-transparent caret-white focus:outline-none placeholder:text-zinc-600 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:bg-white/10 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-track]:bg-transparent font-sans leading-relaxed overflow-y-auto whitespace-pre-wrap break-words selection:text-transparent selection:bg-indigo-500/30 ${isMaximized ? 'resize-y' : 'resize-none'}`}
                  />

                  {/* 圆形发送按钮 */}
                  <button onClick={handleGenerate} disabled={!prompt.trim()}
                    className="absolute right-3 bottom-3 w-10 h-10 rounded-full flex items-center justify-center transition-all bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white shadow-lg shadow-indigo-500/20 disabled:opacity-30 disabled:cursor-not-allowed z-10">
                    <Play className="w-4 h-4 ml-0.5" />
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

import { startPolling } from '../../utils/polling';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Image as ImageIcon, ArrowUpRight, Pencil, Plus, ChevronDown, SlidersHorizontal, MoreHorizontal, Square, Download, RotateCcw, Loader2, Check, AlertCircle, Sparkles, Monitor, Smartphone, RectangleHorizontal, Upload, X, Maximize2, Trash2 } from 'lucide-react';
import './ImageGenPage.css';
import { downloadGeneratedImage, fetchImageModels, generateImage, generatedImageReference, getCachedImageModels, imageReferenceLimit, type ImageModel, type ImageSSEEvent } from '../../api/imageGen';
import { contentApi } from '../../api/content';
import { useImageDropPaste } from '../../hooks/useImageDropPaste';
import { useAuthGuard } from '../../hooks/useAuthGuard';
import { isSupportedImageFile, MOBILE_IMAGE_ACCEPT, normalizeImageFile } from '../../utils/imageNormalization';

interface GeneratedImage {
  id: string;
  prompt: string;
  imageUrl: string;
  model: string;
  createdAt: Date;
  aspectRatio: string;
  missing?: boolean;
}

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

const COUNT_OPTIONS = [
  { value: 1, label: '1张' },
  { value: 2, label: '2张' },
  { value: 4, label: '4张' },
];

const PIDOI_QUALITY_OPTIONS = [
  { value: 'high', label: '原生 4K' },
  { value: 'low', label: '快速 1K' },
];

const MINGFEI_QUALITY_OPTIONS = [
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
];

const MINGFEI_RESOLUTION_OPTIONS = [
  { value: '1K', label: '1K' },
  { value: '2K', label: '2K' },
  { value: '4K', label: '4K' },
];

async function downloadImageFile(event: React.MouseEvent, url: string, filename: string) {
  event.stopPropagation();
  try {
    await downloadGeneratedImage(url, filename);
  } catch (error: any) {
    window.alert(error?.message || '图片下载失败，请稍后重试');
  }
}

interface ActiveImageBatch {
  id: string;
  contentId?: number;
  persisted?: boolean;
  prompt: string;
  model: string;
  aspectRatio: string;
  count: number;
  images: string[];
  progresses: number[];
  failedIndexes: number[];
  statusMessage: string;
}

const MAX_CONCURRENT_BATCHES = 4;

function SettingSelect({ label, value, options, onChange }: { label: string; value: string | number; options: { value: string | number; label: string }[]; onChange: (value: any) => void }) {
  return (
    <label className="ig-field"><span>{label}</span><div className="ig-select-wrap">
      <select aria-label={label} value={value} onChange={e => onChange(typeof value === 'number' ? Number(e.target.value) : e.target.value)}>
        {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select><ChevronDown size={15} aria-hidden="true" />
    </div></label>
  );
}

/** 瀑布流图片卡片 */
function ImageCard({ url, index, onPreview, onEdit, editing }: { url: string; index: number; onPreview: () => void; onEdit: () => void; editing: boolean; key?: any }) {
  return (
    <article className="ig-artwork">
      <button type="button" className="ig-artwork-preview" aria-label={`预览生成图片 ${index + 1}`} onClick={onPreview}>
        <img src={url} alt={`生成图片 ${index + 1}`} loading="lazy" /><span className="ig-preview-badge"><Maximize2 size={15} /></span>
      </button>
      <div className="ig-artwork-footer"><button type="button" aria-label="继续改图" disabled={editing} onClick={onEdit} className="ig-edit"><Pencil size={14} />改图</button>
        <button type="button" aria-label={`下载生成图片 ${index + 1}`} className="ig-icon-button" onClick={e => void downloadImageFile(e, url, `generated-image-${index + 1}.png`)}><Download size={16} /></button>
      </div>
    </article>
  );
}

/** 生成中的占位卡片 - 骨架屏风格 */
function PlaceholderCard({ index, progress }: { index: number; progress: number; key?: any }) {
  return (
    <div className="ig-placeholder" role="status" aria-label={`图片 ${index + 1} ${progress > 0 ? '生成中' : '排队中'}`}>
      <div className="relative w-12 h-12">
        <svg className="w-12 h-12 -rotate-90" viewBox="0 0 48 48">
          <circle cx="24" cy="24" r="20" fill="none" stroke="var(--ig-line)" strokeWidth="3" />
          <circle cx="24" cy="24" r="20" fill="none" stroke="var(--ig-accent)" strokeWidth="3" strokeLinecap="round"
            strokeDasharray={`${2 * Math.PI * 20}`}
            strokeDashoffset={`${2 * Math.PI * 20 * (1 - (progress || 0) / 100)}`}
            className="transition-all duration-700 ease-out" />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          {progress > 0 ? (
            <span>{progress}%</span>
          ) : (
            <Loader2 size={16} className="ig-spin" />
          )}
        </div>
      </div>
      <span>#{index + 1} {progress > 0 ? '生成中' : '排队中'}</span>
    </div>
  );
}

/** 全屏预览浮层 */
function Lightbox({ url, onClose, onEdit, editing }: { url: string; onClose: () => void; onEdit: () => void; editing: boolean }) {
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [onClose]);
  return (
    <div className="ig-lightbox" role="dialog" aria-modal="true" aria-label="图片预览" onClick={onClose}>
      <button type="button" aria-label="关闭预览" onClick={onClose} className="ig-lightbox-close" autoFocus><X size={21} /></button>
      <img src={url} alt="预览" onClick={(e) => e.stopPropagation()} />
      <div className="ig-lightbox-actions">
      <button type="button" disabled={editing} onClick={e => { e.stopPropagation(); onEdit(); }}><Pencil size={16} />继续改图</button>
      <button type="button" onClick={(e) => downloadImageFile(e, url, 'generated-image.png')}
        >
        <Download size={16} /> 下载原图
      </button>
      </div>
    </div>
  );
}

export default function ImageGenPage() {
  const guard = useAuthGuard();
  const [models, setModels] = useState<ImageModel[]>(getCachedImageModels);
  const [selectedModel, setSelectedModel] = useState(() => models[0]?.id || '');
  const selectedImageModel = models.find(m => m.id === selectedModel);
  const managedLimits = selectedImageModel?.routingLimits;
  const maxReferenceImages = imageReferenceLimit(selectedImageModel);
  const [generationMode, setGenerationMode] = useState<'text' | 'image'>('text');
  const [referenceImporting, setReferenceImporting] = useState(false);
  const referenceImportingRef = useRef(false);
  const [referenceNotice, setReferenceNotice] = useState('');
  const [editFocusRequest, setEditFocusRequest] = useState(0);
  const [prompt, setPrompt] = useState('');
  const [aspectRatio, setAspectRatio] = useState('1:1');
  const [managedQuality, setManagedQuality] = useState('');
  const [pidoiQuality, setPidoiQuality] = useState<'low' | 'high'>('high');
  const [mingFeiQuality, setMingFeiQuality] = useState<'low' | 'medium' | 'high'>('medium');
  const [mingFeiResolution, setMingFeiResolution] = useState<'1K' | '2K' | '4K'>('2K');
  const [imageCount, setImageCount] = useState(1);
  const [activeBatches, setActiveBatches] = useState<ActiveImageBatch[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [generatedImages, setGeneratedImages] = useState<string[]>([]);
  const [history, setHistory] = useState<GeneratedImage[]>([]);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [referenceImages, setReferenceImages] = useState<string[]>([]);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const batchControllersRef = useRef<Map<string, AbortController>>(new Map());
  const recoveringHistoryIdsRef = useRef<Set<number>>(new Set());
  const [recoveringHistoryIds, setRecoveringHistoryIds] = useState<Set<number>>(() => new Set());
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const continueEditing = async (url: string) => {
    if (referenceImportingRef.current) return;
    const target = selectedImageModel?.available && maxReferenceImages > 0 ? selectedImageModel
      : models.find(model => model.available && imageReferenceLimit(model) > 0);
    if (!target) { setError('暂无可用的图生图模型，请联系管理员配置渠道'); return; }
    referenceImportingRef.current = true;
    setReferenceImporting(true);
    setLightboxUrl(null);
    setError(null);
    try {
      const reference = await generatedImageReference(url);
      setSelectedModel(target.id);
      setReferenceImages([reference]);
      setGenerationMode('image');
      setPrompt('');
      setReferenceNotice(target.id === selectedModel ? '已带入原图，请填写修改要求。' : `已带入原图并切换至 ${target.name}，请填写修改要求。`);
      setEditFocusRequest(request => request + 1);
    } catch (error: any) { setError(error?.message || '原图读取失败，请重新上传'); }
    finally { referenceImportingRef.current = false; setReferenceImporting(false); }
  };

  // Wait until the reference preview is rendered before scrolling to the editor.
  useEffect(() => {
    if (!editFocusRequest) return;
    textareaRef.current?.focus();
    textareaRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [editFocusRequest]);

  useEffect(() => {
    fetchImageModels().then((nextModels) => {
      setModels(nextModels);
      setSelectedModel(current => nextModels.some(model => model.id === current) ? current : (nextModels[0]?.id || ''));
    }).catch(() => {});
    let cancelled = false;

    const refreshPersistedJobs = async (signal: AbortSignal) => {
      try {
        const res: any = await contentApi.getMyContents({ type: 'image', page: 1, pageSize: 20 }, signal);
        if (cancelled || signal.aborted) return;
        const items = res?.items || res?.data || [];
        const loadedHistory: GeneratedImage[] = [];
        const recoveredBatches: ActiveImageBatch[] = [];
        const existingUrls = new Set<string>();

        for (const item of items) {
          let metadata: Record<string, any> = {};
          try {
            metadata = typeof item.metadata === 'string' ? JSON.parse(item.metadata || '{}') : (item.metadata || {});
          } catch { /* ignore malformed legacy metadata */ }
          const promptText = item.inputText || item.title || '';
          const model = item.model || item.modelId || '';
          const createdAt = new Date(item.createdAt);
          const itemAspectRatio = metadata.aspectRatio || metadata.aspect_ratio || '';
          const storedImageUrls = Array.isArray(metadata.imageUrls) ? metadata.imageUrls : [];
          const imageUrls = storedImageUrls.filter(Boolean);
          const isProcessing = item.status === 'processing' || item.status === 'queued';

          if (isProcessing) {
            const count = Math.max(1, Math.min(4, Number(metadata.count) || 1));
            const images = new Array(count).fill('');
            storedImageUrls.slice(0, count).forEach((url: string, index: number) => { images[index] = url || ''; });
            const progresses = new Array(count).fill(0);
            if (Array.isArray(metadata.progresses)) {
              metadata.progresses.slice(0, count).forEach((value: unknown, index: number) => {
                progresses[index] = Math.max(0, Math.min(100, Number(value) || 0));
              });
            }
            recoveredBatches.push({
              id: `persisted-image-${item.id}`,
              contentId: Number(item.id),
              persisted: true,
              prompt: promptText,
              model,
              aspectRatio: itemAspectRatio,
              count,
              images,
              progresses,
              failedIndexes: Array.isArray(metadata.failedIndexes)
                ? metadata.failedIndexes.filter((value: unknown) => Number.isInteger(value))
                : [],
              statusMessage: metadata.progressText || '图片正在后台生成，刷新页面不会丢失',
            });
            continue;
          }

          const addHistory = (url: string, suffix: string) => {
            if (!url || existingUrls.has(url)) return;
            existingUrls.add(url);
            loadedHistory.push({
              id: `${item.id}_${suffix}`,
              prompt: promptText,
              imageUrl: url,
              model,
              createdAt,
              aspectRatio: itemAspectRatio,
            });
          };
          addHistory(item.resultUrl, 'main');
          imageUrls.forEach((url: string, index: number) => addHistory(url, String(index)));
        }

        setHistory(previous => {
          const next = [...loadedHistory];
          const urls = new Set(next.map(item => item.imageUrl));
          previous.forEach(item => { if (!urls.has(item.imageUrl)) next.push(item); });
          return next;
        });
        setActiveBatches(previous => {
          const live = previous.filter(batch => !batch.persisted);
          const liveContentIds = new Set(live.map(batch => batch.contentId).filter(Boolean));
          return [...live, ...recoveredBatches.filter(batch => !liveContentIds.has(batch.contentId))];
        });
        setHistoryTotal(Number(res?.total) || 0);
      } catch (error) { throw error; }
    };

    const stopPolling = startPolling(refreshPersistedJobs, 5_000);
    return () => {
      cancelled = true;
      stopPolling();
    };
  }, []);

  const loadMoreHistory = async () => {
    const nextPage = historyPage + 1;
    setHistoryLoading(true);
    try {
      const res: any = await contentApi.getMyContents({ type: 'image', page: nextPage, pageSize: 12 });
      const items = res?.items || res?.data || [];
      const loaded: GeneratedImage[] = [];
      const urls = new Set(history.map(item => item.imageUrl));
      for (const item of items) {
        const metadata = typeof item.metadata === 'string' ? (() => { try { return JSON.parse(item.metadata); } catch { return {}; } })() : (item.metadata || {});
        const add = (url: string, suffix: string) => {
          if (!url || urls.has(url)) return;
          urls.add(url);
          loaded.push({ id: `${item.id}_${suffix}`, prompt: item.inputText || item.title || '', imageUrl: url, model: item.model || item.modelId || '', createdAt: new Date(item.createdAt), aspectRatio: metadata.aspectRatio || '' });
        };
        add(item.resultUrl, 'main');
        if (Array.isArray(metadata.imageUrls)) metadata.imageUrls.forEach((url: string, index: number) => add(url, String(index)));
      }
      setHistory(prev => [...prev, ...loaded]);
      setHistoryPage(nextPage);
      setHistoryTotal(Number(res?.total) || 0);
    } finally {
      setHistoryLoading(false);
    }
  };

  const readFileAsDataURL = async (file: File): Promise<string> => {
    const normalized = await normalizeImageFile(file, {
      maxDimension: 2048,
      quality: 0.88,
      outputType: 'image/jpeg',
      maxInputBytes: 20 * 1024 * 1024,
    });
    return normalized.dataUrl;
  };

  const handleFileSelect = async (files: FileList | null) => {
    if (!files) return;
    if (referenceImportingRef.current) return;
    if (maxReferenceImages === 0) { setError('当前模型不支持图生图，请选择支持参考图的模型'); return; }
    const remaining = maxReferenceImages - referenceImages.length;
    if (remaining <= 0) { setError('最多上传 ' + maxReferenceImages + ' 张参考图'); return; }
    const validFiles = Array.from(files).filter(isSupportedImageFile);
    if (validFiles.length > remaining) { setError('该规格最多 ' + maxReferenceImages + ' 张参考图，请减少选中的图片'); return; }
    if (validFiles.length === 0) return;
    const oversized = validFiles.find(f => f.size > 20 * 1024 * 1024);
    if (oversized) { setError(`参考图 "${oversized.name}" 超过 20MB 上限`); return; }
    referenceImportingRef.current = true;
    setReferenceImporting(true);
    setError(null);
    try { const urls = await Promise.all(validFiles.map(readFileAsDataURL)); setReferenceImages(prev => [...prev, ...urls]); setGenerationMode('image'); setReferenceNotice(''); }
    catch (error: any) { setError(error?.message || '图片读取失败'); }
    finally { referenceImportingRef.current = false; setReferenceImporting(false); }
  };

  const removeRefImage = (index: number) => setReferenceImages(prev => prev.filter((_, i) => i !== index));

  // 全局拖拽 + Ctrl+V 粘贴上传参考图
  useImageDropPaste(handleFileSelect);

  useEffect(() => {
    if (!managedLimits) return;
    if (!managedLimits.qualities.includes(managedQuality)) setManagedQuality(managedLimits.qualities[0] || '');
    if (!managedLimits.resolutions.includes(mingFeiResolution)) setMingFeiResolution((managedLimits.resolutions[0] || '2K') as any);
    if (!managedLimits.ratios.includes(aspectRatio)) setAspectRatio(managedLimits.ratios[0] || '1:1');
    if (imageCount > managedLimits.maxOutputs) setImageCount(managedLimits.maxOutputs);
  }, [selectedModel, managedLimits, mingFeiResolution, aspectRatio, imageCount, managedQuality]);
  const handleGenerate = useCallback(() => {
    if (!prompt.trim()) return;
    if (referenceImporting) return;
    const batchReferences = generationMode === 'image' ? [...referenceImages] : [];
    if (generationMode === 'image' && maxReferenceImages === 0) { setError('当前模型不支持图生图，请选择支持参考图的模型'); return; }
    if (generationMode === 'image' && !batchReferences.length) { setError('请先上传需要修改的原图'); return; }
    if (batchReferences.length > maxReferenceImages) { setError(`当前模型最多支持 ${maxReferenceImages} 张参考图，请减少图片后重试`); return; }
    if (managedLimits && batchReferences.length < managedLimits.minImages) { setError('该规格至少需要 ' + managedLimits.minImages + ' 张参考图，请切换至图生图并上传'); return; }
    if (activeBatches.length >= MAX_CONCURRENT_BATCHES) {
      setError(`最多同时生成 ${MAX_CONCURRENT_BATCHES} 批图片，请等待任一批完成`);
      return;
    }
    if (!guard()) return;

    const batchId = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `image-batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const batchPrompt = prompt.trim();
    const batchModel = selectedModel;
    const batchAspectRatio = aspectRatio;
    const batchCount = imageCount;
    const batchQuality = managedLimits ? managedQuality || undefined : batchModel === 'gpt-image-2'
      ? pidoiQuality
      : batchModel === 'gpt-image-2-mingfei' ? mingFeiQuality : undefined;
    const batchResolution = batchModel === 'gpt-image-2-mingfei' ? mingFeiResolution : undefined;

    setActiveBatches(previous => [...previous, {
      id: batchId,
      prompt: batchPrompt,
      model: batchModel,
      aspectRatio: batchAspectRatio,
      count: batchCount,
      images: new Array(batchCount).fill(''),
      progresses: new Array(batchCount).fill(0),
      failedIndexes: [],
      statusMessage: `正在生成 ${batchCount} 张图片...`,
    }]);
    setError(null);

    const updateBatch = (updater: (batch: ActiveImageBatch) => ActiveImageBatch) => {
      setActiveBatches(previous => previous.map(batch => batch.id === batchId ? updater(batch) : batch));
    };

    const ctrl = generateImage(
      {
        prompt: batchPrompt,
        model: batchModel,
        aspect_ratio: batchAspectRatio,
        resolution: managedLimits ? managedLimits.resolutions.length === 1 ? managedLimits.resolutions[0] as '1K' | '2K' | '4K' : mingFeiResolution : batchModel === 'gpt-image-2'
          ? (batchQuality === 'high' ? '4K' : '1K')
          : batchResolution,
        quality: batchQuality,
        n: batchCount,
        reference_images: batchReferences.length > 0 ? batchReferences : undefined,
      },
      (event: ImageSSEEvent) => {
        switch (event.type) {
          case 'queue':
            updateBatch(batch => ({ ...batch, statusMessage: event.message || '图片任务排队中...' }));
            break;
          case 'status':
            updateBatch(batch => ({ ...batch, contentId: event.contentId || batch.contentId, statusMessage: event.message || '' }));
            break;
          case 'progress': {
            const idx = event.index ?? -1;
            if (idx >= 0) {
              updateBatch(batch => {
                const progresses = [...batch.progresses];
                progresses[idx] = event.progress || 0;
                return { ...batch, progresses };
              });
            }
            break;
          }
          case 'image_ready':
            if (event.imageUrl) {
              const idx = event.index ?? 0;
              updateBatch(batch => {
                const images = [...batch.images];
                const progresses = [...batch.progresses];
                images[idx] = event.imageUrl!;
                progresses[idx] = 100;
                return { ...batch, images, progresses };
              });
            }
            break;
          case 'image_error':
            setError(event.message || `图片 #${(event.index ?? 0) + 1} 生成失败`);
            if (event.index !== undefined) {
              updateBatch(batch => ({
                ...batch,
                failedIndexes: batch.failedIndexes.includes(event.index!)
                  ? batch.failedIndexes
                  : [...batch.failedIndexes, event.index!],
              }));
            }
            break;
          case 'complete': {
            const completedUrls = (event.imageUrls || []).filter(Boolean);
            if (completedUrls.length > 0) {
              setGeneratedImages(previous => [...previous, ...completedUrls]);
              setHistory(previous => [
                ...completedUrls.map(url => ({
                  id: `${Date.now()}-${Math.random()}`,
                  prompt: batchPrompt,
                  imageUrl: url,
                  model: batchModel,
                  createdAt: new Date(),
                  aspectRatio: batchAspectRatio,
                })),
                ...previous,
              ]);
            }
            batchControllersRef.current.delete(batchId);
            setActiveBatches(previous => previous.filter(batch => batch.id !== batchId));
            break;
          }
          case 'error':
            setError(event.message || '生成失败');
            batchControllersRef.current.delete(batchId);
            setActiveBatches(previous => previous.filter(batch => batch.id !== batchId));
            break;
        }
      },
    );
    batchControllersRef.current.set(batchId, ctrl);
  }, [prompt, selectedModel, aspectRatio, pidoiQuality, mingFeiQuality, mingFeiResolution, imageCount, activeBatches.length, referenceImages, guard, managedLimits, managedQuality, generationMode, maxReferenceImages, referenceImporting]);

  const handleCancelBatch = useCallback((batchId: string) => {
    batchControllersRef.current.get(batchId)?.abort();
    batchControllersRef.current.delete(batchId);
    setActiveBatches(previous => previous.filter(batch => batch.id !== batchId));
  }, []);

  const recoverHistoryImage = useCallback(async (historyItem: GeneratedImage) => {
    const contentId = Number.parseInt(String(historyItem.id).split('_')[0], 10);
    if (!Number.isSafeInteger(contentId) || contentId <= 0 || recoveringHistoryIdsRef.current.has(contentId)) return;
    recoveringHistoryIdsRef.current.add(contentId);
    setRecoveringHistoryIds(previous => new Set(previous).add(contentId));
    try {
      const recovered: any = await contentApi.recoverImage(contentId);
      const imageUrls = Array.isArray(recovered?.imageUrls) ? recovered.imageUrls.filter(Boolean) : [];
      const primaryUrl = recovered?.resultUrl || imageUrls[0] || '';
      if (!primaryUrl) throw new Error('上游未返回可用图片');
      setHistory(previous => previous.flatMap(item => {
        const [rawId, suffix = 'main'] = String(item.id).split('_');
        if (Number.parseInt(rawId, 10) !== contentId) return [item];
        const replacement = suffix === 'main' ? primaryUrl : imageUrls[Number.parseInt(suffix, 10)];
        return replacement ? [{ ...item, imageUrl: replacement, missing: false }] : [];
      }));
      setError(null);
    } catch (recoveryError: any) {
      setError(recoveryError?.message || '历史图片已失效，重新获取失败');
    } finally {
      recoveringHistoryIdsRef.current.delete(contentId);
      setRecoveringHistoryIds(previous => {
        const next = new Set(previous);
        next.delete(contentId);
        return next;
      });
    }
  }, []);

  const markHistoryImageMissing = useCallback((historyId: string) => {
    setHistory(previous => previous.map(item => item.id === historyId ? { ...item, missing: true } : item));
  }, []);

  const deleteHistoryRecord = useCallback(async (historyItem: GeneratedImage) => {
    const contentId = Number.parseInt(String(historyItem.id).split('_')[0], 10);
    if (!Number.isSafeInteger(contentId) || contentId <= 0) return;
    if (!window.confirm('确定要删除这条图片生成记录吗？')) return;
    try {
      await contentApi.delete(contentId);
      setHistory(previous => previous.filter(item => Number.parseInt(String(item.id).split('_')[0], 10) !== contentId));
    } catch {
      setError('删除失败');
    }
  }, []);

  useEffect(() => () => {
    batchControllersRef.current.forEach(controller => controller.abort());
    batchControllersRef.current.clear();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleGenerate(); } };

  const generatedImageUrls = new Set(generatedImages);
  const visibleHistory = history.filter(item => !generatedImageUrls.has(item.imageUrl));
  const hasCurrentWork = generatedImages.length > 0 || activeBatches.length > 0;
  const selectedMingFeiRate = models.find(model => model.id === 'gpt-image-2-mingfei')?.resolutionPrices?.[mingFeiResolution];

  const displayRate = selectedModel === 'gpt-image-2-mingfei' && Number.isFinite(selectedMingFeiRate)
    ? selectedMingFeiRate : selectedImageModel?.rate;
  const canGenerate = Boolean(prompt.trim() && !referenceImporting && activeBatches.length < MAX_CONCURRENT_BATCHES
    && selectedImageModel?.available && (generationMode === 'text' || (maxReferenceImages > 0 && referenceImages.length > 0 && referenceImages.length <= maxReferenceImages)));

  return (
    <div className="image-studio">
      <header className="ig-header"><h1>图片<span>{generatedImages.length + visibleHistory.length}</span></h1>{generatedImages.length > 0 && <button type="button" className="ig-text-button" onClick={() => setGeneratedImages([])}><RotateCcw size={14} />清空本次</button>}</header>
      <div className="ig-workspace">
        <section className="ig-gallery" aria-label="我的作品">
          <div className="ig-gallery-content">
            {generatedImages.length > 0 && <section className="ig-result-section"><h3>本次生成<span>{generatedImages.length} 张</span></h3><div className="ig-artwork-grid">{generatedImages.map((url, index) => <ImageCard key={url + index} url={url} index={index} onPreview={() => setLightboxUrl(url)} onEdit={() => void continueEditing(url)} editing={referenceImporting} />)}</div></section>}
            {activeBatches.map((batch, batchIndex) => <section key={batch.id} className="ig-batch"><header><div><h3>生成中 · 批次 {batchIndex + 1}</h3><p title={batch.prompt}>{batch.statusMessage || batch.prompt}</p></div>{batch.persisted || batch.contentId ? <span className="ig-processing"><Loader2 size={14} className="ig-spin" />后台处理中</span> : <button type="button" className="ig-text-button" onClick={() => handleCancelBatch(batch.id)}><Square size={13} />取消本批</button>}</header><div className="ig-artwork-grid">{batch.images.map((url, index) => url ? <ImageCard key={index} url={url} index={index} onPreview={() => setLightboxUrl(url)} onEdit={() => void continueEditing(url)} editing={referenceImporting} /> : batch.failedIndexes.includes(index) ? <div className="ig-failed" key={index}><AlertCircle size={24} /><span>图片 {index + 1} 生成失败</span></div> : <PlaceholderCard key={index} index={index} progress={batch.progresses[index] || 0} />)}</div></section>)}

            {visibleHistory.length > 0 && <section className="ig-result-section"><div className="ig-artwork-grid">{visibleHistory.map(item => <article className="ig-artwork" key={item.id}>
              {item.missing ? <div className="ig-missing"><AlertCircle size={25} /><strong>原文件暂时无法读取</strong><div><button type="button" className="ig-text-button" disabled={recoveringHistoryIds.has(Number.parseInt(item.id.split('_')[0], 10))} onClick={() => void recoverHistoryImage(item)}>{recoveringHistoryIds.has(Number.parseInt(item.id.split('_')[0], 10)) ? '获取中…' : '重新获取'}</button><button type="button" className="ig-text-button" onClick={() => void deleteHistoryRecord(item)}>删除</button></div></div>
                : <button type="button" className="ig-artwork-preview" aria-label="预览历史图片" onClick={() => setLightboxUrl(item.imageUrl)}><img src={item.imageUrl} alt="历史图片" loading="lazy" onError={() => markHistoryImageMissing(item.id)} /><span className="ig-preview-badge"><Maximize2 size={15} /></span></button>}
              {!item.missing && <div className="ig-artwork-footer"><button type="button" aria-label="继续改图" className="ig-edit" disabled={referenceImporting} onClick={() => void continueEditing(item.imageUrl)}><Pencil size={14} />改图</button><div className="ig-artwork-actions"><details className="ig-card-menu"><summary aria-label="更多操作" title="更多操作"><MoreHorizontal size={17} /></summary><div>
                {item.prompt && <button type="button" className="ig-icon-button" aria-label="套用提示词" title="套用提示词" onClick={() => { setPrompt(item.prompt); textareaRef.current?.focus(); }}><RotateCcw size={15} /></button>}
                <button type="button" className="ig-icon-button" aria-label="删除记录" title="删除记录" onClick={() => void deleteHistoryRecord(item)}><Trash2 size={15} /></button>
                </div></details><button type="button" className="ig-icon-button" aria-label="下载历史图片" title="下载原图" onClick={event => void downloadImageFile(event, item.imageUrl, 'generated-image-' + item.id + '.png')}><Download size={16} /></button>
              </div></div>}
            </article>)}</div>{historyPage * 12 < historyTotal && <button type="button" className="ig-load-more" disabled={historyLoading} onClick={() => void loadMoreHistory()}>{historyLoading ? '加载中…' : '加载更多作品'}<ChevronDown size={15} /></button>}</section>}

            {!hasCurrentWork && visibleHistory.length === 0 && <div className="ig-empty"><ImageIcon size={34} strokeWidth={1.1} /><span>还没有作品</span></div>}
          </div>
        </section>
        <form className="ig-composer" onSubmit={event => { event.preventDefault(); handleGenerate(); }}>
          <div className="ig-composer-top">
            <div className="ig-modes" role="group" aria-label="图片生成模式">
              <button type="button" aria-pressed={generationMode === 'text'} onClick={() => { setGenerationMode('text'); setError(null); setReferenceNotice(''); }}>文生图</button>
              <button type="button" aria-label="图生图 / 改图" aria-pressed={generationMode === 'image'} onClick={() => { setGenerationMode('image'); setError(null); setReferenceNotice(''); }}>图生图</button>
            </div>
            {activeBatches.length > 0 && <span className="ig-processing"><Loader2 size={13} className="ig-spin" />{activeBatches.length} 批进行中</span>}
          </div>
          <input ref={fileInputRef} type="file" accept={MOBILE_IMAGE_ACCEPT} multiple hidden onChange={event => { void handleFileSelect(event.target.files); event.target.value = ''; }} />
          {generationMode === 'image' && <section className="ig-original-section" aria-label="原图上传">
            <div className="ig-references">
              {referenceImages.map((image, index) => <div className="ig-reference" key={index}><img src={image} alt={'参考图 ' + (index + 1)} /><span className="ig-reference-number">{index + 1}</span><button type="button" className="ig-reference-remove" aria-label={'移除参考图 ' + (index + 1)} onClick={() => removeRefImage(index)}><X size={12} /></button></div>)}
              <button type="button" className="ig-upload" aria-label={'上传原图 (' + referenceImages.length + '/' + maxReferenceImages + ')'} title={'最多 ' + maxReferenceImages + ' 张，单张不超过 20 MB'} disabled={maxReferenceImages === 0 || referenceImporting || referenceImages.length >= maxReferenceImages} onClick={() => fileInputRef.current?.click()}><Plus size={20} /><span>{referenceImages.length ? '添加' : '原图'}</span></button>
            </div>
            {maxReferenceImages === 0 && <p className="ig-warning" role="status">当前模型仅支持文生图</p>}
            {referenceImages.length > maxReferenceImages && <p className="ig-warning" role="status">当前模型最多支持 {maxReferenceImages} 张参考图，请移除多余图片。</p>}
          </section>}
          <textarea id="ig-prompt" ref={textareaRef} value={prompt} onChange={event => setPrompt(event.target.value)} onKeyDown={handleKeyDown}
            aria-label={generationMode === 'image' ? '修改要求' : '图片描述'} rows={2} placeholder={generationMode === 'image' ? '想修改哪里？' : '描述你想要的画面…'} />
          {error && <div role="alert" className="ig-error"><AlertCircle size={16} /><span>{error}</span><button type="button" aria-label="关闭错误提示" onClick={() => setError(null)}><X size={14} /></button></div>}
          <div className="ig-toolbar">
            <SettingSelect label="生成模型" value={selectedModel} onChange={setSelectedModel} options={models.map(model => ({ value: model.id, label: model.name + (!model.available ? ' · 暂不可用' : imageReferenceLimit(model) === 0 ? ' · 仅文生图' : '') }))} />
            <SettingSelect label="画面比例" value={aspectRatio} onChange={setAspectRatio} options={managedLimits ? ASPECT_RATIOS.filter(ratio => managedLimits.ratios.includes(ratio.value)) : ASPECT_RATIOS} />
            <SettingSelect label="生成数量" value={imageCount} onChange={setImageCount} options={managedLimits ? COUNT_OPTIONS.filter(option => option.value <= managedLimits.maxOutputs) : COUNT_OPTIONS} />
            <details className="ig-advanced"><summary aria-label="画质设置" title="画质设置"><SlidersHorizontal size={17} /></summary><div className="ig-settings">
            {selectedModel === 'gpt-image-2' && !managedLimits && <SettingSelect label="输出画质" value={pidoiQuality} onChange={setPidoiQuality} options={PIDOI_QUALITY_OPTIONS} />}
            {Boolean(managedLimits?.qualities.length) && <SettingSelect label="生成质量" value={managedQuality} onChange={setManagedQuality} options={managedLimits!.qualities.map(quality => ({ value: quality, label: quality }))} />}
            {managedLimits?.resolutions.length === 1 && <div className="ig-fixed-setting"><span>输出分辨率</span><strong>{managedLimits.resolutions[0]}</strong></div>}
            {managedLimits && managedLimits.resolutions.length > 1 && <SettingSelect label="输出分辨率" value={mingFeiResolution} onChange={setMingFeiResolution} options={managedLimits.resolutions.map(resolution => ({ value: resolution, label: resolution }))} />}
            {selectedModel === 'gpt-image-2-mingfei' && !managedLimits && <><SettingSelect label="生成质量" value={mingFeiQuality} onChange={setMingFeiQuality} options={MINGFEI_QUALITY_OPTIONS} /><SettingSelect label="输出分辨率" value={mingFeiResolution} onChange={setMingFeiResolution} options={MINGFEI_RESOLUTION_OPTIONS} /></>}
              {!managedLimits && !['gpt-image-2','gpt-image-2-mingfei'].includes(selectedModel) && <span className="ig-default-quality">默认画质</span>}
            </div></details>
            <div className="ig-submit-section">{displayRate !== undefined && <span className="ig-estimate" title="预计费用">¥{(Number(displayRate) * imageCount).toFixed(2)}</span>}
              <button type="submit" className="ig-submit" disabled={!canGenerate} aria-label={activeBatches.length >= MAX_CONCURRENT_BATCHES ? '已达到并发批次上限' : generationMode === 'image' ? '开始改图' : '开始生成图片'} title="Enter 生成"><ArrowUpRight size={20} /><span>生成</span></button>
            </div>
          </div>
          <span className="ig-sr-only" role="status">{referenceImporting ? '正在读取参考图' : referenceNotice}</span>
        </form>
      </div>
      {lightboxUrl && <Lightbox url={lightboxUrl} onClose={() => setLightboxUrl(null)} onEdit={() => void continueEditing(lightboxUrl)} editing={referenceImporting} />}
    </div>
  );
}

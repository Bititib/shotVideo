import { generationProblemSummary } from '../../../../shared/generationMessages';
import { modelAvailabilityMessage } from '../../../../shared/upstreamAvailability';
import { startPolling } from '../../utils/polling';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Image as ImageIcon, ArrowUpRight, Pencil, Plus, ChevronDown, SlidersHorizontal, Square, Download, RotateCcw, Loader2, AlertCircle, Monitor, Smartphone, RectangleHorizontal, X, Maximize2, Trash2 } from 'lucide-react';
import './ImageGenPage.css';
import { ImageThumbnail } from '../../components/MediaPreview';
import { downloadGeneratedImage, fetchImageModels, generateImage, generatedImageReference, getCachedImageModels, imageReferenceLimit, type ImageGenerateParams, type ImageModel, type ImageSSEEvent } from '../../api/imageGen';
import { contentApi } from '../../api/content';
import { useImageDropPaste } from '../../hooks/useImageDropPaste';
import { useAuthGuard } from '../../hooks/useAuthGuard';
import { useAuthStore } from '../../stores/authStore';
import { isSupportedImageFile, MOBILE_IMAGE_ACCEPT, normalizeImageFile } from '../../utils/imageNormalization';
import { formatBeijingTime } from '../../../../shared/time';

interface GeneratedImage {
  id: string;
  prompt: string;
  imageUrl: string;
  model: string;
  createdAt: Date;
  aspectRatio: string;
  missing?: boolean;
  galleryId?: string;
  slotIndex?: number;
  count?: number;
  requestParams?: ImageGenerateParams;
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
  createdAt: Date;
  galleryId?: string;
  phase?: 'queued' | 'processing' | 'checking' | 'review' | 'failed';
  prompt: string;
  model: string;
  aspectRatio: string;
  count: number;
  images: string[];
  progresses: number[];
  failedIndexes: number[];
  statusMessage: string;
  requestParams?: ImageGenerateParams;
}

const MAX_CONCURRENT_BATCHES = 4;

const HISTORY_PAGE_SIZE = 20;
const GALLERY_FILTERS = [
  { value: 'all', label: '全部' }, { value: 'processing', label: '生成中' },
  { value: 'completed', label: '成功' }, { value: 'failed', label: '失败' },
  { value: 'review', label: '待核实' },
] as const;
type GalleryFilter = typeof GALLERY_FILTERS[number]['value'];

// SQLite timestamps are UTC even when the serialized value has no timezone.
function parseImageCreatedAt(value: string) {
  const normalized = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d+)?$/.test(value || '')
    ? value.replace(' ', 'T') + 'Z' : value;
  const date = new Date(normalized);
  return Number.isFinite(date.getTime()) ? date : new Date(0);
}

function parseImageRecords(items: any[]) {
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
    const createdAt = parseImageCreatedAt(item.createdAt);
    const itemAspectRatio = metadata.aspectRatio || metadata.aspect_ratio || '';
    const storedImageUrls = Array.isArray(metadata.imageUrls) ? metadata.imageUrls : [];
    const imageUrls = storedImageUrls.filter(Boolean);
    const isReview = metadata.requiresReview || item.status === 'review';
    const isFailed = ['failed', 'error', 'cancelled'].includes(item.status);
    const isProcessing = item.status === 'processing' || item.status === 'queued';
    const overdue = metadata.imageProtocol !== 'pidoi-async-v1' && isProcessing && createdAt.getTime() > 0
      && Date.now() - createdAt.getTime() > Math.max(30 * 60_000, Number(metadata.requestTimeoutMs || 0) + 60_000);

    if (isProcessing || isReview || isFailed) {
      const count = Math.max(1, Math.min(4, Number(metadata.count) || 1));
      const images = new Array(count).fill('');
      storedImageUrls.slice(0, count).forEach((url: string, index: number) => { images[index] = url || ''; });
      const taskProgress = typeof metadata.progress === 'number' && Number.isFinite(metadata.progress)
        ? Math.max(0, Math.min(99, metadata.progress)) : 0;
      const progresses = new Array(count).fill(taskProgress);
      if (Array.isArray(metadata.progresses)) {
        metadata.progresses.slice(0, count).forEach((value: unknown, index: number) => {
          progresses[index] = Math.max(0, Math.min(100, Number(value) || 0));
        });
      }
      images.forEach((url, index) => { if (url) progresses[index] = 100; });
      recoveredBatches.push({
        id: `persisted-image-${item.id}`,
        contentId: Number(item.id),
        persisted: true,
        createdAt,
        galleryId: String(item.id),
        phase: isReview ? 'review' : isFailed ? 'failed' : overdue ? 'checking' : item.status === 'queued' ? 'queued' : 'processing',
        prompt: promptText,
        model,
        aspectRatio: itemAspectRatio,
        count,
        images,
        progresses,
        failedIndexes: Array.isArray(metadata.failedIndexes)
          ? metadata.failedIndexes.filter((value: unknown) => Number.isInteger(value))
          : [],
        statusMessage: isReview ? (metadata.failureReason || metadata.error || metadata.progressText || '结果待管理员核实，请勿重复提交')
          : isFailed ? (metadata.failureReason || metadata.error || metadata.progressText || '图片生成失败，请在生成记录中查看详情')
          : overdue ? '等待时间较长，后台尚未确认成功或失败，请联系管理员核实该任务'
          : metadata.progressText || '图片正在后台生成，刷新页面不会丢失',
      });
      continue;
    }

    const addHistory = (url: string, suffix: string) => {
      if (!url || existingUrls.has(`${item.id}:${url}`)) return;
      existingUrls.add(`${item.id}:${url}`);
      loadedHistory.push({
        id: `${item.id}_${suffix}`,
        galleryId: String(item.id),
        slotIndex: suffix === 'main' ? 0 : Number(suffix),
        count: Math.max(1, Number(metadata.count) || imageUrls.length),
        prompt: promptText,
        imageUrl: url,
        model,
        createdAt,
        aspectRatio: itemAspectRatio,
      });
    };
    storedImageUrls.forEach((url: string, index: number) => addHistory(url, String(index)));
    if (!imageUrls.length) addHistory(item.resultUrl, 'main');
  }

  return { loadedHistory, recoveredBatches };
}
function SettingSelect({ label, value, options, onChange }: { label: string; value: string | number; options: { value: string | number; label: string }[]; onChange: (value: any) => void }) {
  return (
    <label className="ig-field"><span>{label}</span><div className="ig-select-wrap">
      <select aria-label={label} value={value} onChange={e => onChange(typeof value === 'number' ? Number(e.target.value) : e.target.value)}>
        {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select><ChevronDown size={15} aria-hidden="true" />
    </div></label>
  );
}

/** 生成中的占位卡片 - 骨架屏风格 */
const batchPhaseLabel = (phase?: ActiveImageBatch['phase']) => ({ queued: '排队中', processing: '生成中', checking: '核实中', review: '待核实', failed: '失败' })[phase || 'processing'];

function PlaceholderCard({ index, progress, phase }: { index: number; progress: number; phase?: ActiveImageBatch['phase']; key?: any }) {
  const label = batchPhaseLabel(phase);
  if (phase === 'review' || phase === 'checking' || phase === 'failed') return <div className="ig-failed" role="status"><AlertCircle size={24} /><span>图片 {index + 1} {label}</span></div>;
  return (
    <div className="ig-placeholder" role="status" aria-label={`图片 ${index + 1} ${label}`}>
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
      <span>#{index + 1} {label}</span>
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
  const pricingUserId = useAuthStore(state => state.user?.id);
  const [models, setModels] = useState<ImageModel[]>(getCachedImageModels);
  const [selectedModel, setSelectedModel] = useState(() => models[0]?.id || '');
  const selectedImageModel = models.find(m => m.id === selectedModel);
  // Refresh availability only; never submit or replay a generation automatically.
  useEffect(() => {
    let cancelled = false;
    const refresh = () => { fetchImageModels(true).then(data => { if (!cancelled) setModels(data); }).catch(() => {}); };
    const interval = window.setInterval(refresh, 15_000);
    const deadline = selectedImageModel?.retryAt;
    const timer = deadline && deadline > Date.now() ? window.setTimeout(refresh, deadline - Date.now() + 100) : undefined;
    window.addEventListener('focus', refresh);
    return () => { cancelled = true; window.clearInterval(interval); window.clearTimeout(timer); window.removeEventListener('focus', refresh); };
  }, [selectedImageModel?.retryAt]);
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
  const activeBatchesRef = useRef(activeBatches);
  activeBatchesRef.current = activeBatches;
  const activeBatchCount = activeBatches.filter(batch => batch.phase !== 'failed' && batch.phase !== 'review').length;
  const [error, setError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState('');
  const [busyRecords, setBusyRecords] = useState<Set<string>>(() => new Set());
  const busyRecordsRef = useRef(new Set<string>());
  const deletedContentIdsRef = useRef(new Set<number>());
  const [galleryFilter, setGalleryFilter] = useState<GalleryFilter>('all');
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
    let cancelled = false;
    setModels(getCachedImageModels());
    fetchImageModels().then((nextModels) => {
      if (cancelled) return;
      setModels(nextModels);
      setSelectedModel(current => nextModels.some(model => model.id === current) ? current : (nextModels[0]?.id || ''));
    }).catch(() => {});

    const refreshPersistedJobs = async (signal: AbortSignal) => {
      try {
        const res: any = await contentApi.getMyContents({ type: 'image', page: 1, pageSize: HISTORY_PAGE_SIZE }, signal);
        if (cancelled || signal.aborted) return;
        const items: any[] = [...(res?.items || res?.data || [])].filter(item => !deletedContentIdsRef.current.has(Number(item.id)));
        const visibleIds = new Set(items.map(item => Number(item.id)));
        const trackedIds = [...new Set<number>(activeBatchesRef.current.filter(batch => batch.phase !== 'failed').map(batch => batch.contentId).filter((id): id is number => Boolean(id) && !visibleIds.has(id) && !deletedContentIdsRef.current.has(id!)))];
        const details = await Promise.allSettled(trackedIds.map(id => contentApi.getById(id, signal)));
        if (cancelled || signal.aborted) return;
        const missingIds = new Set<number>();
        details.forEach((result, index) => {
          if (result.status === 'fulfilled' && result.value?.id && !deletedContentIdsRef.current.has(Number(result.value.id))) items.push(result.value);
          else missingIds.add(trackedIds[index]);
        });
        const returnedIds = new Set(items.map(item => Number(item.id)));
        const { loadedHistory, recoveredBatches } = parseImageRecords(items);

        setHistory(previous => {
          const next = loadedHistory.filter(item => !deletedContentIdsRef.current.has(Number(item.id.split('_')[0])))
            .map(item => {
              const saved = previous.find(saved => saved.id === item.id)
                || previous.find(saved => saved.imageUrl === item.imageUrl && (!/^\d+_/.test(saved.id) || saved.id.split('_')[0] === item.id.split('_')[0]));
              const batch = activeBatchesRef.current.find(batch => batch.contentId === Number(item.id.split('_')[0]));
              return { ...item, requestParams: saved?.requestParams || batch?.requestParams,
                missing: saved?.imageUrl === item.imageUrl ? saved.missing : false,
                createdAt: saved?.createdAt || batch?.createdAt || item.createdAt,
                galleryId: saved?.galleryId || batch?.galleryId || item.galleryId };
            });
          const urls = new Set(next.map(item => item.imageUrl));
          previous.forEach(item => {
            const contentId = Number(item.id.split('_')[0]);
            if (!returnedIds.has(contentId) && (contentId > 0 || !urls.has(item.imageUrl)) && !deletedContentIdsRef.current.has(contentId)) next.push(item);
          });
          return next;
        });
        // Database state also reconciles live streams: their terminal event may have been lost.
        for (const batch of activeBatchesRef.current) {
          const item = items.find(item => Number(item.id) === batch.contentId);
          if (item && (!['processing', 'queued'].includes(item.status) || recoveredBatches.find(next => next.contentId === batch.contentId)?.phase === 'review')) {
            batchControllersRef.current.get(batch.id)?.abort();
            batchControllersRef.current.delete(batch.id);
          }
        }
        setActiveBatches(previous => {
          const seen = new Set<number>();
          const next = previous.flatMap(batch => {
            if (batch.contentId && deletedContentIdsRef.current.has(batch.contentId)) return [];
            if (!batch.contentId || !returnedIds.has(batch.contentId)) return [{ ...batch,
              ...(batch.contentId && missingIds.has(batch.contentId) ? { phase: 'checking' as const, statusMessage: '暂时无法读取任务状态，正在重试核实，请勿重复提交' } : {}) }];
            seen.add(batch.contentId);
            const recovered = recoveredBatches.find(item => item.contentId === batch.contentId);
            return recovered ? [{ ...recovered, id: batch.id, createdAt: batch.createdAt, galleryId: batch.galleryId, requestParams: batch.requestParams }] : [];
          });
          return [...next, ...recoveredBatches.filter(batch => !seen.has(batch.contentId!) && !deletedContentIdsRef.current.has(batch.contentId!))];
        });
        setHistoryTotal(Number(res?.total) || 0);
      } catch (error) {
        if (!cancelled && !signal.aborted) setActiveBatches(previous => previous.map(batch =>
          batch.phase === 'failed' || batch.phase === 'review' ? batch : { ...batch, phase: 'checking', statusMessage: '暂时无法读取任务状态，正在重试核实，请勿重复提交' }));
        throw error;
      }
    };

    const stopPolling = startPolling(refreshPersistedJobs, 5_000);
    return () => {
      cancelled = true;
      stopPolling();
      batchControllersRef.current.forEach(controller => controller.abort());
      batchControllersRef.current.clear();
    };
  }, [pricingUserId]);

  const loadMoreHistory = async () => {
    const nextPage = historyPage + 1;
    setHistoryLoading(true);
    try {
      const res: any = await contentApi.getMyContents({ type: 'image', page: nextPage, pageSize: HISTORY_PAGE_SIZE });
      const items = res?.items || res?.data || [];
      const { loadedHistory, recoveredBatches } = parseImageRecords(items);
      setHistory(previous => {
        const ids = new Set(previous.map(item => item.id));
        return [...previous, ...loadedHistory.filter(item => !ids.has(item.id))]
          .filter(item => !deletedContentIdsRef.current.has(Number(item.id.split('_')[0])));
      });
      setActiveBatches(previous => {
        const ids = new Set(previous.map(item => item.contentId));
        return [...previous, ...recoveredBatches.filter(item => !ids.has(item.contentId))]
          .filter(item => !deletedContentIdsRef.current.has(item.contentId!));
      });
      setHistoryPage(nextPage);
      setHistoryTotal(Number(res?.total) || 0);
    } catch (error: any) {
      setError(error?.message || '加载记录失败，请稍后重试');
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
    if (managedLimits.outputsPerTask) setImageCount(managedLimits.outputsPerTask);
    else if (imageCount > managedLimits.maxOutputs) setImageCount(managedLimits.maxOutputs);
  }, [selectedModel, managedLimits, mingFeiResolution, aspectRatio, imageCount, managedQuality]);
  const handleGenerate = useCallback(() => {
    if (!prompt.trim()) return;
    if (referenceImporting) return;
    const batchReferences = generationMode === 'image' ? [...referenceImages] : [];
    if (generationMode === 'image' && maxReferenceImages === 0) { setError('当前模型不支持图生图，请选择支持参考图的模型'); return; }
    if (generationMode === 'image' && !batchReferences.length) { setError('请先上传需要修改的原图'); return; }
    if (batchReferences.length > maxReferenceImages) { setError(`当前模型最多支持 ${maxReferenceImages} 张参考图，请减少图片后重试`); return; }
    if (managedLimits && batchReferences.length < managedLimits.minImages) { setError('该规格至少需要 ' + managedLimits.minImages + ' 张参考图，请切换至图生图并上传'); return; }
    if (activeBatchCount >= MAX_CONCURRENT_BATCHES) {
      setError(`最多同时生成 ${MAX_CONCURRENT_BATCHES} 批图片，请等待任一批完成`);
      return;
    }
    if (!guard()) return;

    const batchId = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `image-batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const batchCreatedAt = new Date();
    const batchPrompt = prompt.trim();
    const batchModel = selectedModel;
    const batchAspectRatio = aspectRatio;
    const batchCount = managedLimits?.outputsPerTask || imageCount;
    const batchQuality = managedLimits ? managedQuality || undefined : batchModel === 'gpt-image-2'
      ? pidoiQuality
      : batchModel === 'gpt-image-2-mingfei' ? mingFeiQuality : undefined;
    const batchResolution = batchModel === 'gpt-image-2-mingfei' ? mingFeiResolution : undefined;

    const requestParams: ImageGenerateParams = {
      prompt: batchPrompt, model: batchModel, aspect_ratio: batchAspectRatio,
      resolution: managedLimits ? managedLimits.resolutions.length === 1 ? managedLimits.resolutions[0] as '1K' | '2K' | '4K' : mingFeiResolution : batchModel === 'gpt-image-2' ? (batchQuality === 'high' ? '4K' : '1K') : batchResolution,
      quality: batchQuality as ImageGenerateParams['quality'], n: batchCount,
      reference_images: batchReferences.length > 0 ? batchReferences : undefined,
    };
    setActiveBatches(previous => [...previous, {
      id: batchId,
      galleryId: batchId,
      createdAt: batchCreatedAt,
      prompt: batchPrompt,
      model: batchModel,
      aspectRatio: batchAspectRatio,
      count: batchCount,
      images: new Array(batchCount).fill(''),
      progresses: new Array(batchCount).fill(0),
      failedIndexes: [],
      statusMessage: `正在生成 ${batchCount} 张图片...`,
      requestParams,
    }]);
    setError(null);
    setActionNotice('');

    setGalleryFilter('all');

    const updateBatch = (updater: (batch: ActiveImageBatch) => ActiveImageBatch) => {
      setActiveBatches(previous => previous.map(batch => batch.id === batchId ? updater(batch) : batch));
    };

    let submittedContentId: number | undefined;
    const ctrl = generateImage(
      requestParams,
      (event: ImageSSEEvent) => {
        if (event.contentId) submittedContentId = event.contentId;
        switch (event.type) {
          case 'queue':
            updateBatch(batch => ({ ...batch, phase: event.status === 'processing' ? 'processing' : 'queued', statusMessage: event.message || '图片任务排队中...' }));
            break;
          case 'disconnected':
            updateBatch(batch => ({ ...batch, contentId: event.contentId || batch.contentId, phase: batch.contentId || event.contentId ? 'checking' : 'review', statusMessage: event.message || '连接已断开，请到生成记录核实结果' }));
            break;
          case 'content_id':
          case 'status':
            updateBatch(batch => ({ ...batch, contentId: event.contentId || batch.contentId, persisted: event.background || batch.persisted, phase: 'processing', statusMessage: event.message || batch.statusMessage }));
            if (event.background) batchControllersRef.current.delete(batchId);
            break;
          case 'progress': {
            if (typeof event.progress !== 'number' || !Number.isFinite(event.progress)) break;
            const progress = Math.max(0, Math.min(100, event.progress));
            updateBatch(batch => {
              const progresses = [...batch.progresses];
              // MJ reports one task's progress for all native outputs, without an image index.
              const indexes = event.index === undefined ? progresses.map((_, index) => index) : [event.index];
              for (const index of indexes) {
                if (Number.isInteger(index) && index >= 0 && index < progresses.length
                  && !batch.images[index] && !batch.failedIndexes.includes(index)) progresses[index] = progress;
              }
              return { ...batch, phase: 'processing', progresses };
            });
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
                statusMessage: event.message || batch.statusMessage,
                failedIndexes: batch.failedIndexes.includes(event.index!)
                  ? batch.failedIndexes
                  : [...batch.failedIndexes, event.index!],
              }));
            }
            break;
          case 'complete': {
            const completedUrls = (event.imageUrls || []).filter(Boolean);
            if (completedUrls.length > 0) {
              setHistory(previous => [
                ...completedUrls.map((url, index) => ({
                  id: submittedContentId ? `${submittedContentId}_${index}` : `local-${batchId}_${index}`,
                  prompt: batchPrompt,
                  imageUrl: url,
                  model: batchModel,
                  createdAt: batchCreatedAt,
                  galleryId: batchId,
                  slotIndex: index,
                  count: completedUrls.length,
                  aspectRatio: batchAspectRatio,
                  requestParams,
                })),
                ...previous.filter(item => !completedUrls.includes(item.imageUrl)),
              ]);
            }
            batchControllersRef.current.delete(batchId);
            setActiveBatches(previous => previous.filter(batch => batch.id !== batchId));
            break;
          }
          case 'error':
            setError(event.message || '生成失败');
            batchControllersRef.current.delete(batchId);
            updateBatch(batch => ({ ...batch, phase: batch.contentId ? 'checking' : 'failed', statusMessage: event.message || '生成失败' }));
            break;
        }
      },
    );
    batchControllersRef.current.set(batchId, ctrl);
  }, [prompt, selectedModel, aspectRatio, pidoiQuality, mingFeiQuality, mingFeiResolution, imageCount, activeBatchCount, referenceImages, guard, managedLimits, managedQuality, generationMode, maxReferenceImages, referenceImporting]);

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

  const prepareRegeneration = async (record: ActiveImageBatch | GeneratedImage) => {
    const key = record.id;
    if (busyRecordsRef.current.has(key)) return;
    busyRecordsRef.current.add(key);
    setBusyRecords(new Set(busyRecordsRef.current));
    try {
      const contentId = 'contentId' in record ? record.contentId : /^\d+_/.test(record.id) ? Number(record.id.split('_')[0]) : undefined;
      let params = 'requestParams' in record ? record.requestParams : undefined;
      let unknownReferences = false;
      if (!params) {
        const detail = contentId ? await contentApi.getById(contentId) : undefined;
        const meta = typeof detail?.metadata === 'string' ? JSON.parse(detail.metadata || '{}') : detail?.metadata || {};
        const references = meta.reference_images || meta.referenceImages;
        unknownReferences = !Array.isArray(references);
        params = {
          prompt: detail?.inputText || detail?.title || record.prompt,
          model: detail?.modelId || detail?.model || record.model,
          aspect_ratio: meta.aspectRatio || meta.aspect_ratio || record.aspectRatio || '1:1',
          n: Number(meta.count) || ('count' in record ? record.count : 1),
          resolution: meta.resolution, quality: meta.quality,
          reference_images: Array.isArray(references) ? references.filter((source: unknown): source is string => typeof source === 'string' && Boolean(source)) : [],
        };
      }
      const nextModels = await fetchImageModels(true);
      setModels(nextModels);
      const target = nextModels.find(model => model.id === params!.model);
      if (!target?.available) throw new Error(modelAvailabilityMessage(target) || '原模型暂不可用，请选择可用模型后重新生成');
      setSelectedModel(target.id);
      setPrompt(params.prompt);
      setAspectRatio(params.aspect_ratio || '1:1');
      setImageCount(Math.max(1, Math.min(4, Number(params.n) || 1)));
      if (params.resolution) setMingFeiResolution(params.resolution);
      if (params.quality) { setManagedQuality(params.quality); setMingFeiQuality(params.quality); }
      if (target.id === 'gpt-image-2') setPidoiQuality(params.quality === 'low' || params.resolution === '1K' ? 'low' : 'high');
      const references = params.reference_images || [];
      setReferenceImages(references);
      setGenerationMode(references.length || target.routingLimits?.minImages ? 'image' : 'text');
      setError(null);
      setActionNotice(`已恢复原任务参数，确认后点击“生成”创建新任务，将按当前价格计费。${unknownReferences ? '历史记录未保存参考图；如原任务为图生图，请切换图生图并重新上传。' : ''}`);
      setEditFocusRequest(request => request + 1);
    } catch (error: any) { setError(error?.message || '读取原任务失败，请稍后重试'); }
    finally { busyRecordsRef.current.delete(key); setBusyRecords(new Set(busyRecordsRef.current)); }
  };

  const deleteImageRecord = useCallback(async (record: ActiveImageBatch | GeneratedImage) => {
    const contentId = 'contentId' in record ? record.contentId : /^\d+_/.test(record.id) ? Number(record.id.split('_')[0]) : undefined;
    const key = record.id;
    if (busyRecordsRef.current.has(key)) return;
    if (!window.confirm((record.count || 1) > 1 ? `确定删除这条任务及其全部 ${record.count} 张图片记录吗？` : '确定要删除这条图片生成记录吗？')) return;
    busyRecordsRef.current.add(key);
    setBusyRecords(new Set(busyRecordsRef.current));
    try {
      if (contentId) {
        await contentApi.delete(contentId);
        deletedContentIdsRef.current.add(contentId);
        setHistoryTotal(previous => Math.max(0, previous - 1));
      }
      setHistory(previous => previous.filter(item => item.id !== key && (!contentId || Number(item.id.split('_')[0]) !== contentId)));
      batchControllersRef.current.get(key)?.abort();
      batchControllersRef.current.delete(key);
      setActiveBatches(previous => previous.filter(batch => batch.id !== key && (!contentId || batch.contentId !== contentId)));
      setError(null);
    } catch (error: any) { setError(error?.message || '删除失败，请稍后重试'); }
    finally { busyRecordsRef.current.delete(key); setBusyRecords(new Set(busyRecordsRef.current)); }
  }, [history]);

  useEffect(() => () => {
    batchControllersRef.current.forEach(controller => controller.abort());
    batchControllersRef.current.clear();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleGenerate(); } };

  const activeContentIds = new Set(activeBatches.map(batch => batch.contentId).filter(Boolean));
  const galleryCards = [
    ...activeBatches.flatMap(batch => batch.images.map((url, index) => ({
      key: `${batch.galleryId || batch.contentId || batch.id}_${index}`,
      record: batch as ActiveImageBatch | GeneratedImage, batch, image: undefined as GeneratedImage | undefined,
      index, count: batch.count, url, contentId: batch.contentId,
      status: (url ? 'completed' : batch.phase === 'failed' || batch.failedIndexes.includes(index) ? 'failed'
        : batch.phase === 'review' || batch.phase === 'checking' ? 'review' : 'processing') as GalleryFilter,
    }))),
    ...history.filter(item => !activeContentIds.has(Number(item.id.split('_')[0]))).map(item => ({
      key: `${item.galleryId || item.id.split('_')[0]}_${item.slotIndex ?? 0}`,
      record: item as ActiveImageBatch | GeneratedImage, batch: undefined as ActiveImageBatch | undefined, image: item,
      index: item.slotIndex ?? 0, count: item.count || 1, url: item.imageUrl,
      contentId: /^\d+_/.test(item.id) ? Number(item.id.split('_')[0]) : undefined,
      status: 'completed' as GalleryFilter,
    })),
  ].sort((a, b) => b.record.createdAt.getTime() - a.record.createdAt.getTime()
    || (b.contentId || 0) - (a.contentId || 0) || a.index - b.index || a.key.localeCompare(b.key));
  const visibleCards = galleryCards.filter(card => galleryFilter === 'all' || card.status === galleryFilter);
  const selectedMingFeiRate = models.find(model => model.id === 'gpt-image-2-mingfei')?.resolutionPrices?.[mingFeiResolution];

  const displayRate = selectedModel === 'gpt-image-2-mingfei' && Number.isFinite(selectedMingFeiRate)
    ? selectedMingFeiRate : selectedImageModel?.rate;
  const canGenerate = Boolean(prompt.trim() && !referenceImporting && activeBatchCount < MAX_CONCURRENT_BATCHES
    && selectedImageModel?.available && (generationMode === 'text' || (maxReferenceImages > 0 && referenceImages.length > 0 && referenceImages.length <= maxReferenceImages)));

  return (
    <div className="image-studio">
      <header className="ig-header"><h1>图片<span>{galleryCards.length}</span></h1><span className="ig-sort-hint">最新提交在前</span></header>
      <div className="ig-workspace">
        <section className="ig-gallery" aria-label="我的作品">
          <div className="ig-gallery-filters" role="group" aria-label="生成记录筛选">
            {GALLERY_FILTERS.map(filter => <button key={filter.value} type="button" aria-pressed={galleryFilter === filter.value}
              onClick={() => setGalleryFilter(filter.value)}>{filter.label}<span>{filter.value === 'all' ? galleryCards.length : galleryCards.filter(card => card.status === filter.value).length}</span></button>)}
          </div>
          <div className="ig-gallery-content">
            <div className="ig-artwork-grid ig-unified-grid">
              {visibleCards.map(({ key, record, batch, image, index, count, url, contentId, status }) => {
                const canManage = !batch || batch.phase === 'failed';
                const statusLabel = image?.missing ? '文件待恢复' : status === 'completed' ? '成功' : batchPhaseLabel(batch?.phase === 'checking' ? 'checking' : status === 'failed' ? 'failed' : batch?.phase);
                return <article className="ig-artwork ig-task-card" key={key} data-task-id={contentId || record.id} data-status={status} aria-label={`${contentId ? '任务 #' + contentId : '本次任务'} · 图片 ${index + 1}`}>
                  <header className="ig-task-heading"><span className={`ig-task-status ig-task-status-${image?.missing ? 'review' : status}`}>{statusLabel}</span><span>{count > 1 ? `第 ${index + 1} / ${count} 张` : '1 张'}</span></header>
                  {image?.missing ? <div className="ig-missing"><AlertCircle size={25} /><strong>原文件暂时无法读取</strong><button type="button" className="ig-text-button" disabled={recoveringHistoryIds.has(contentId!)} onClick={() => void recoverHistoryImage(image)}>{recoveringHistoryIds.has(contentId!) ? '获取中…' : '重新获取'}</button></div>
                    : url ? <button type="button" className="ig-artwork-preview" aria-label="预览图片" onClick={() => setLightboxUrl(url)}><ImageThumbnail src={url} alt={image ? '历史图片' : `生成图片 ${index + 1}`} loading="lazy" onError={image ? () => markHistoryImageMissing(image.id) : undefined} /><span className="ig-preview-badge"><Maximize2 size={15} /></span></button>
                    : <PlaceholderCard index={index} progress={batch?.progresses[index] || 0} phase={status === 'failed' ? 'failed' : batch?.phase} />}
                  <div className="ig-task-info">
                    <p className="ig-task-prompt" title={record.prompt}>{record.prompt || '未填写描述'}</p>
                    <div className="ig-task-meta"><span>{contentId ? `任务 #${contentId}` : '本次任务'}</span><time dateTime={record.createdAt.toISOString()} title="北京时间">{record.createdAt.getTime() ? formatBeijingTime(record.createdAt, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '时间未记录'}</time></div>
                    <p className="ig-task-detail" title={batch?.statusMessage ? generationProblemSummary(batch.statusMessage) : record.model}>{batch && !url ? generationProblemSummary(batch.statusMessage) : `${models.find(model => model.id === record.model)?.name || record.model} · ${record.aspectRatio || '默认比例'}`}</p>
                  </div>
                  <div className="ig-record-actions" aria-label={`任务 ${contentId || record.id} 操作`}>
                    {url && !image?.missing && <><button type="button" aria-label="继续改图" className="ig-text-button" disabled={referenceImporting} onClick={() => void continueEditing(url)}><Pencil size={14} />改图</button><button type="button" className="ig-text-button" aria-label="下载图片" onClick={event => void downloadImageFile(event, url, `generated-image-${contentId || record.id}-${index + 1}.png`)}><Download size={14} />下载</button></>}
                    {canManage && <><button type="button" className="ig-text-button ig-regenerate" title={count > 1 ? '套用整批生成参数' : '套用生成参数'} disabled={busyRecords.has(record.id) || referenceImporting} onClick={() => void prepareRegeneration(record)}><RotateCcw size={14} />重新生成</button><button type="button" className="ig-text-button ig-delete" disabled={busyRecords.has(record.id)} onClick={() => void deleteImageRecord(record)}><Trash2 size={14} />删除</button></>}
                    {batch && !canManage && !batch.contentId && !batch.persisted && <button type="button" className="ig-text-button" onClick={() => handleCancelBatch(batch.id)}><Square size={13} />取消本批</button>}
                    {batch && !canManage && !url && (batch.contentId || batch.persisted) && <span className="ig-task-wait">{status === 'review' ? '结果待核实，请勿重复提交' : '后台生成中，可继续提交其他任务'}</span>}
                  </div>
                </article>;
              })}
            </div>
            {visibleCards.length === 0 && <div className="ig-empty"><ImageIcon size={34} strokeWidth={1.1} /><span>{galleryCards.length ? '已加载记录中暂无此状态的图片' : '还没有作品'}</span></div>}
            {historyPage * HISTORY_PAGE_SIZE < historyTotal && <button type="button" className="ig-load-more" disabled={historyLoading} onClick={() => void loadMoreHistory()}>{historyLoading ? '加载中…' : '加载更多记录'}<ChevronDown size={15} /></button>}
          </div>
        </section>
        <form className="ig-composer" onSubmit={event => { event.preventDefault(); handleGenerate(); }}>
          <div className="ig-composer-top">
            <div className="ig-modes" role="group" aria-label="图片生成模式">
              <button type="button" aria-pressed={generationMode === 'text'} onClick={() => { setGenerationMode('text'); setError(null); setReferenceNotice(''); }}>文生图</button>
              <button type="button" aria-label="图生图 / 改图" aria-pressed={generationMode === 'image'} onClick={() => { setGenerationMode('image'); setError(null); setReferenceNotice(''); }}>图生图</button>
            </div>
            {activeBatchCount > 0 && <span className="ig-processing"><Loader2 size={13} className="ig-spin" />{activeBatchCount} 批进行中</span>}
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
          {!selectedImageModel?.available && selectedImageModel && <p role="status" className="ig-error">{modelAvailabilityMessage(selectedImageModel)}</p>}
          {error && <div role="alert" className="ig-error"><AlertCircle size={16} /><span>{generationProblemSummary(error)}</span><button type="button" aria-label="关闭错误提示" onClick={() => setError(null)}><X size={14} /></button></div>}
          {actionNotice && <p className="ig-action-notice" role="status">{actionNotice}</p>}
          <div className="ig-toolbar">
            <SettingSelect label="生成模型" value={selectedModel} onChange={setSelectedModel} options={models.map(model => ({ value: model.id, label: model.name + (!model.available ? ' · 暂不可用' : imageReferenceLimit(model) === 0 ? ' · 仅文生图' : '') }))} />
            <SettingSelect label="画面比例" value={aspectRatio} onChange={setAspectRatio} options={managedLimits ? managedLimits.ratios.map(ratio => ({ value: ratio, label: ratio })) : ASPECT_RATIOS} />
            {managedLimits?.outputsPerTask ? <div className="ig-fixed-setting"><span>每次出图</span><strong>按实际结果 · 按次计费</strong></div> : <SettingSelect label="生成数量" value={imageCount} onChange={setImageCount} options={managedLimits ? COUNT_OPTIONS.filter(option => option.value <= managedLimits.maxOutputs) : COUNT_OPTIONS} />}
            <details className="ig-advanced"><summary aria-label="画质设置" title="画质设置"><SlidersHorizontal size={17} /></summary><div className="ig-settings">
            {selectedModel === 'gpt-image-2' && !managedLimits && <SettingSelect label="输出画质" value={pidoiQuality} onChange={setPidoiQuality} options={PIDOI_QUALITY_OPTIONS} />}
            {Boolean(managedLimits?.qualities.length) && <SettingSelect label="生成质量" value={managedQuality} onChange={setManagedQuality} options={managedLimits!.qualities.map(quality => ({ value: quality, label: quality }))} />}
            {managedLimits?.resolutions.length === 1 && <div className="ig-fixed-setting"><span>输出分辨率</span><strong>{managedLimits.resolutions[0]}</strong></div>}
            {managedLimits && managedLimits.resolutions.length > 1 && <SettingSelect label="输出分辨率" value={mingFeiResolution} onChange={setMingFeiResolution} options={managedLimits.resolutions.map(resolution => ({ value: resolution, label: resolution }))} />}
            {selectedModel === 'gpt-image-2-mingfei' && !managedLimits && <><SettingSelect label="生成质量" value={mingFeiQuality} onChange={setMingFeiQuality} options={MINGFEI_QUALITY_OPTIONS} /><SettingSelect label="输出分辨率" value={mingFeiResolution} onChange={setMingFeiResolution} options={MINGFEI_RESOLUTION_OPTIONS} /></>}
              {!managedLimits && !['gpt-image-2','gpt-image-2-mingfei'].includes(selectedModel) && <span className="ig-default-quality">默认画质</span>}
            </div></details>
            <div className="ig-submit-section">{displayRate !== undefined && <span className="ig-estimate" title="预计费用">¥{(Number(displayRate) * (managedLimits?.outputsPerTask ? 1 : imageCount)).toFixed(2)}</span>}
              <button type="submit" className="ig-submit" disabled={!canGenerate} aria-label={activeBatchCount >= MAX_CONCURRENT_BATCHES ? '已达到并发批次上限' : generationMode === 'image' ? '开始改图' : '开始生成图片'} title="Enter 生成"><ArrowUpRight size={20} /><span>生成</span></button>
            </div>
          </div>
          <span className="ig-sr-only" role="status">{referenceImporting ? '正在读取参考图' : referenceNotice}</span>
        </form>
      </div>
      {lightboxUrl && <Lightbox url={lightboxUrl} onClose={() => setLightboxUrl(null)} onEdit={() => void continueEditing(lightboxUrl)} editing={referenceImporting} />}
    </div>
  );
}

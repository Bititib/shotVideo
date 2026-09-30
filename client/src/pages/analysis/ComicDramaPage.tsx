import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown, ArrowUp, Bot, Check, ChevronDown, ChevronRight, Circle, Clapperboard, Download, FileText, Image as ImageIcon,
  Loader2, Lock, PackageOpen, Pencil, Plus, Play, RotateCcw, Save, Sparkles, Square, Trash2, Unlock, Upload, Users, Video, WandSparkles, X,
} from 'lucide-react';
import { analysisApi, type ComicDramaBlueprint, type ComicDramaEpisodeSummary, type ComicDramaSeriesPlan, type ComicDramaShot } from '../../api/analysis';
import { fetchImageModels, generateImage, type ImageModel } from '../../api/imageGen';
import { fetchVideoModels, generateVideo, type VideoModel } from '../../api/video';
import { useAuthGuard } from '../../hooks/useAuthGuard';

type TaskStatus = 'pending' | 'running' | 'done' | 'error';
type QualityReport = { score: number; consistencyPassed: boolean; summary: string; issues: string[]; correctedPrompt: string };
type AssetTask = { id: string; name: string; kind: '角色' | '场景' | '道具'; prompt: string; status: TaskStatus; url?: string; error?: string; attempts?: number; qualityScore?: number; qualityReport?: QualityReport; aliases?: string[]; variant?: string; locked?: boolean };
type ShotTask = { id: string; sceneNumber: number; sceneTitle: string; shot: ComicDramaShot; status: TaskStatus; imageUrl?: string; videoUrl?: string; error?: string; attempts?: number; videoAttempts?: number; qualityScore?: number; qualityReport?: QualityReport; videoQualityScore?: number; videoQualityReport?: QualityReport };
type PipelineKind = 'assets' | 'storyboards' | 'videos';

const SAMPLE_SCRIPT = `第1场 夜 内 老旧公寓
林晚抱着一个纸箱站在门口。屋内传来玻璃碎裂声。
林晚：谁在里面？
门忽然打开，失踪三年的哥哥林川站在阴影里，手上握着一枚发光的旧怀表。
林川：别开灯。他们能看见光。
走廊尽头的感应灯一盏接一盏熄灭。林晚后退一步，纸箱里的全家福掉在地上。
林晚：你到底惹了什么人？
林川抬眼，怀表的指针开始倒转。
林川：不是人。`;

const statusText: Record<TaskStatus, string> = { pending: '待生成', running: '生成中', done: '已完成', error: '需重试' };

function TaskBadge({ status }: { status: TaskStatus }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] ${status === 'done' ? 'bg-emerald-500/10 text-emerald-400' : status === 'running' ? 'bg-cyan-500/10 text-cyan-300' : status === 'error' ? 'bg-red-500/10 text-red-400' : 'bg-white/5 text-zinc-500'}`}>
      {status === 'done' ? <Check className="h-3 w-3" /> : status === 'running' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Circle className="h-2.5 w-2.5" />}
      {statusText[status]}
    </span>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return <button type="button" role="switch" aria-checked={checked} onClick={onChange} className={`relative h-5 w-9 rounded-full transition ${checked ? 'bg-cyan-500' : 'bg-zinc-700'}`}><span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition ${checked ? 'left-[18px]' : 'left-0.5'}`} /></button>;
}

export default function ComicDramaPage() {
  const { requireAuth } = useAuthGuard();
  const [script, setScript] = useState('');
  const [inputMode, setInputMode] = useState<'episode' | 'series'>('episode');
  const [targetEpisodeDuration, setTargetEpisodeDuration] = useState(90);
  const [requestedEpisodeCount, setRequestedEpisodeCount] = useState('');
  const [seriesPlan, setSeriesPlan] = useState<ComicDramaSeriesPlan | null>(null);
  const [creatingSeries, setCreatingSeries] = useState(false);
  const [blueprint, setBlueprint] = useState<ComicDramaBlueprint | null>(null);
  const [projectId, setProjectId] = useState<number | null>(null);
  const projectIdRef = useRef<number | null>(null);
  const [projectTitle, setProjectTitle] = useState('');
  const [episodes, setEpisodes] = useState<ComicDramaEpisodeSummary[]>([]);
  const [seriesOverview, setSeriesOverview] = useState<any>(null);
  const [batchAnalyzing, setBatchAnalyzing] = useState(false);
  const [selectedEpisodeIds, setSelectedEpisodeIds] = useState<Set<number>>(new Set());
  const [overviewExpanded, setOverviewExpanded] = useState(true);
  const [episodeId, setEpisodeId] = useState<number | null>(null);
  const episodeIdRef = useRef<number | null>(null);
  const [episodeNumber, setEpisodeNumber] = useState(1);
  const [managedScope, setManagedScope] = useState<'current' | 'all'>('current');
  const projectStateRef = useRef<any>({});
  const [editingAssetKey, setEditingAssetKey] = useState('');
  const [assetDraft, setAssetDraft] = useState<AssetTask | null>(null);
  const [editingShot, setEditingShot] = useState<ShotTask | null>(null);
  const assetUploadRef = useRef<HTMLInputElement>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportScope, setExportScope] = useState<'current' | 'all'>('current');
  const [exportSummary, setExportSummary] = useState<{ total: number; completed: number; unapproved: number; running: number; missing: number } | null>(null);
  const [includeUnapproved, setIncludeUnapproved] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [recentProjects, setRecentProjects] = useState<Array<{ id: number; title: string; status: string; updatedAt: string; episodeCount?: number }>>([]);
  const [assets, setAssets] = useState<AssetTask[]>([]);
  const [sharedAssets, setSharedAssets] = useState<AssetTask[]>([]);
  const [shots, setShots] = useState<ShotTask[]>([]);
  const assetsRef = useRef<AssetTask[]>([]);
  const shotsRef = useRef<ShotTask[]>([]);
  const [analysisModels, setAnalysisModels] = useState<{ modelId: string; displayName: string }[]>([]);
  const [imageModels, setImageModels] = useState<ImageModel[]>([]);
  const [videoModels, setVideoModels] = useState<VideoModel[]>([]);
  const [analysisModel, setAnalysisModel] = useState('');
  const [imageModel, setImageModel] = useState('');
  const [videoModel, setVideoModel] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [running, setRunning] = useState(false);
  const [managed, setManaged] = useState(false);
  const [error, setError] = useState('');
  const [expandedScene, setExpandedScene] = useState<number | null>(1);
  const [selected, setSelected] = useState<Record<PipelineKind, boolean>>({ assets: true, storyboards: true, videos: true });
  const [qualityEnabled, setQualityEnabled] = useState(true);
  const [qualityRetries, setQualityRetries] = useState(1);
  const stopRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const saveChainRef = useRef<Promise<unknown>>(Promise.resolve());

  const openEpisode = async (project: any, targetEpisodeId: number) => {
    const episode = await analysisApi.getComicDramaEpisode(project.id, targetEpisodeId);
    const savedState = episode.state || {};
    setEpisodeId(episode.id); episodeIdRef.current = episode.id;
    setEpisodeNumber(episode.episodeNumber || 1);
    localStorage.setItem(`comic-drama-active-episode-${project.id}`, String(episode.id));
    setScript(episode.script || '');
    setBlueprint(episode.blueprint?.scenes ? episode.blueprint : null);
    setQualityEnabled(savedState.qualityEnabled !== false);
    setQualityRetries(Number(savedState.qualityRetries ?? 1));
    if (savedState.selected) setSelected(savedState.selected);
    const taskMap = new Map<string, any>((episode.tasks || []).map((task: any) => [`${task.kind}:${task.entityKey}`, task]));
    const projectAssets = new Map<string, AssetTask>((projectStateRef.current.sharedAssets || []).map((asset: AssetTask) => [`${asset.kind}:${asset.name}`, asset]));
    const restoredAssets = (Array.isArray(savedState.assets) ? savedState.assets : []).map((item: AssetTask) => {
      const task = taskMap.get(`asset:${item.id}`); if (!task) return item;
      const status: TaskStatus = task.status === 'review_required' ? 'error' : task.status === 'skipped' || task.status === 'queued' ? 'pending' : task.status;
      const shared = projectAssets.get(`${item.kind}:${item.name}`);
      return { ...item, status: shared?.url ? 'done' : status, url: shared?.url || task.resultUrl || item.url, attempts: task.attempts, qualityScore: shared?.qualityScore ?? task.qualityScore, qualityReport: shared?.qualityReport || task.qualityReport };
    });
    const restoredShots = (Array.isArray(savedState.shots) ? savedState.shots : []).map((item: ShotTask) => {
      const storyboard = taskMap.get(`storyboard:${item.id}`); const video = taskMap.get(`video:${item.id}`);
      return { ...item, status: storyboard?.status === 'running' || video?.status === 'running' ? 'running' : ['error', 'review_required'].includes(storyboard?.status) || ['error', 'review_required'].includes(video?.status) ? 'error' : item.status, imageUrl: storyboard?.resultUrl || item.imageUrl, videoUrl: video?.resultUrl || item.videoUrl, attempts: storyboard?.attempts, videoAttempts: video?.attempts, qualityScore: storyboard?.qualityScore, qualityReport: storyboard?.qualityReport, videoQualityScore: video?.qualityScore, videoQualityReport: video?.qualityReport };
    });
    assetsRef.current = restoredAssets; shotsRef.current = restoredShots;
    setAssets(restoredAssets); setShots(restoredShots);
    const sharedByKey = new Map<string, AssetTask>((projectStateRef.current.sharedAssets || []).map((asset: AssetTask) => [`${asset.kind}:${asset.name}`, asset]));
    let sharedChanged = false;
    for (const asset of restoredAssets) {
      const key = `${asset.kind}:${asset.name}`;
      const existing = sharedByKey.get(key);
      if (!existing || (asset.url && existing.url !== asset.url)) { sharedByKey.set(key, asset.url ? asset : existing || asset); sharedChanged = true; }
    }
    if (sharedChanged) {
      projectStateRef.current = { ...projectStateRef.current, activeEpisodeId: episode.id, sharedAssets: [...sharedByKey.values()] };
      analysisApi.saveComicDramaProjectState(project.id, projectStateRef.current).catch(() => {});
    }
    setSharedAssets([...sharedByKey.values()]);
    setExpandedScene(episode.blueprint?.scenes?.[0]?.sceneNumber ?? null);
    return episode;
  };

  const loadProject = async (id: number) => {
    const project = await analysisApi.getComicDramaProject(id);
    setInputMode('episode'); setSeriesPlan(null);
    setProjectId(project.id); projectIdRef.current = project.id;
    setProjectTitle(project.title || '未命名漫剧');
    setEpisodes(project.episodes || []);
    setSeriesOverview(project.overview || null);
    projectStateRef.current = project.state || {};
    localStorage.setItem('comic-drama-active-project', String(project.id));
    const remembered = Number(localStorage.getItem(`comic-drama-active-episode-${project.id}`) || project.state?.activeEpisodeId || 0);
    const target = project.episodes?.some((episode: any) => episode.id === remembered) ? remembered : project.episodes?.[0]?.id;
    if (target) await openEpisode(project, target);
    return project;
  };

  const activeAnalysisCount = episodes.filter(episode => ['analysis_queued', 'analyzing'].includes(episode.status)).length;

  useEffect(() => {
    Promise.allSettled([analysisApi.getAvailableModels(), fetchImageModels(), fetchVideoModels()]).then(([a, i, v]) => {
      if (a.status === 'fulfilled') { setAnalysisModels(a.value); setAnalysisModel(a.value[0]?.modelId || ''); }
      if (i.status === 'fulfilled') { const list = i.value.filter(m => m.available); setImageModels(list); setImageModel(list[0]?.id || ''); }
      if (v.status === 'fulfilled') { const list = v.value.filter(m => m.available); setVideoModels(list); setVideoModel(list[0]?.id || ''); }
    });
    if (localStorage.getItem('token')) analysisApi.listComicDramaProjects().then(setRecentProjects).catch(() => {});
  }, []);

  useEffect(() => {
    const savedId = Number(localStorage.getItem('comic-drama-active-project') || 0);
    if (!savedId || !localStorage.getItem('token')) return;
    let cancelled = false;
    (async () => {
      try {
        let project = await loadProject(savedId);
        if (['queued', 'producing'].includes(project.status)) { setRunning(true); setManaged(true); }
        while (!cancelled && ['queued', 'producing'].includes(project.status)) {
          await new Promise(resolve => setTimeout(resolve, 2_000));
          if (!cancelled) project = await loadProject(savedId);
        }
        if (!cancelled) { setRunning(false); setManaged(false); }
      } catch { localStorage.removeItem('comic-drama-active-project'); }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!projectId || !episodeId || blueprint) return;
    const timer = window.setTimeout(() => {
      analysisApi.saveComicDramaEpisodeDraft(projectId, episodeId, { script }).catch(() => {});
    }, 800);
    return () => window.clearTimeout(timer);
  }, [script, projectId, episodeId, blueprint]);

  useEffect(() => {
    if (!projectId || !activeAnalysisCount || batchAnalyzing) return;
    let cancelled = false;
    setBatchAnalyzing(true);
    (async () => {
      try {
        let project: any;
        do {
          await new Promise(resolve => setTimeout(resolve, 1500));
          if (cancelled) return;
          project = await analysisApi.getComicDramaProject(projectId);
          setEpisodes(project.episodes || []); setSeriesOverview(project.overview || null);
        } while (!cancelled && project.episodes?.some((episode: ComicDramaEpisodeSummary) => ['analysis_queued', 'analyzing'].includes(episode.status)));
        const active = project?.episodes?.find((episode: ComicDramaEpisodeSummary) => episode.id === episodeIdRef.current);
        if (!cancelled && !blueprint && active && !['draft', 'analysis_failed'].includes(active.status)) await openEpisode(project, active.id);
      } catch (e: any) { if (!cancelled) setError(e.message || '读取批量分析进度失败'); }
      finally { if (!cancelled) setBatchAnalyzing(false); }
    })();
    return () => { cancelled = true; };
  }, [projectId, activeAnalysisCount]);

  const updateAssets = (next: AssetTask[]) => { assetsRef.current = next; setAssets(next); };
  const updateShots = (next: ShotTask[]) => { shotsRef.current = next; setShots(next); };
  const persist = (nextAssets = assetsRef.current, nextShots = shotsRef.current, status = 'producing') => {
    if (!projectIdRef.current || !episodeIdRef.current) return;
    const id = projectIdRef.current; const activeEpisodeId = episodeIdRef.current;
    const sharedByKey = new Map<string, AssetTask>();
    for (const asset of projectStateRef.current.sharedAssets || []) sharedByKey.set(`${asset.kind}:${asset.name}`, asset);
    for (const asset of nextAssets) {
      const key = `${asset.kind}:${asset.name}`; const previous = sharedByKey.get(key);
      sharedByKey.set(key, { ...(previous || {}), ...asset, url: asset.url || previous?.url } as AssetTask);
    }
    const projectState = { ...projectStateRef.current, activeEpisodeId, sharedAssets: [...sharedByKey.values()] };
    projectStateRef.current = projectState;
    setSharedAssets(projectState.sharedAssets);
    saveChainRef.current = saveChainRef.current.catch(() => undefined).then(async () => {
      await analysisApi.saveComicDramaEpisodeState(id, activeEpisodeId, { assets: nextAssets, shots: nextShots, qualityEnabled, qualityRetries, selected, imageModel, videoModel, analysisModel }, status);
      await analysisApi.saveComicDramaProjectState(id, projectState);
    });
  };
  const patchAsset = (id: string, patch: Partial<AssetTask>) => { const next = assetsRef.current.map(item => item.id === id ? { ...item, ...patch } : item); updateAssets(next); persist(next, shotsRef.current); };
  const patchShot = (id: string, patch: Partial<ShotTask>) => { const next = shotsRef.current.map(item => item.id === id ? { ...item, ...patch } : item); updateShots(next); persist(assetsRef.current, next); };

  const counts = useMemo(() => ({
    assets: { done: assets.filter(x => x.status === 'done').length, total: assets.length },
    storyboards: { done: shots.filter(x => !!x.imageUrl).length, total: shots.length },
    videos: { done: shots.filter(x => !!x.videoUrl).length, total: shots.length },
  }), [assets, shots]);
  const totalDone = counts.assets.done + counts.storyboards.done + counts.videos.done;
  const totalTasks = counts.assets.total + counts.storyboards.total + counts.videos.total;
  const reviewedImages = [...assets, ...shots].filter(item => item.qualityScore !== undefined);
  const passedImages = reviewedImages.filter(item => (item.qualityScore || 0) >= 75).length;
  const reviewedVideos = shots.filter(item => item.videoQualityScore !== undefined);
  const passedVideos = reviewedVideos.filter(item => (item.videoQualityScore || 0) >= 75).length;

  const switchEpisode = async (targetId: number) => {
    if (!projectIdRef.current || running || targetId === episodeIdRef.current) return;
    setError('');
    const project = await analysisApi.getComicDramaProject(projectIdRef.current);
    await openEpisode(project, targetId);
  };

  const createEpisode = async () => {
    if (!projectIdRef.current || running) return;
    setError('');
    try {
      const episode = await analysisApi.createComicDramaEpisode(projectIdRef.current);
      const project = await analysisApi.getComicDramaProject(projectIdRef.current);
      setEpisodes(project.episodes || []); setSeriesOverview(project.overview || null);
      await openEpisode(project, episode.id);
    } catch (e: any) { setError(e.message || '新建剧集失败'); }
  };

  const batchAnalyzeEpisodes = async (failedOnly = false) => {
    if (!requireAuth() || !projectIdRef.current || batchAnalyzing) return;
    const eligible = episodes.filter(episode => failedOnly ? episode.status === 'analysis_failed' : ['draft', 'analysis_failed'].includes(episode.status));
    const selectedEligible = eligible.filter(episode => selectedEpisodeIds.has(episode.id));
    const targets = selectedEligible.length ? selectedEligible : eligible;
    if (!targets.length) { setError(failedOnly ? '当前没有分析失败的剧集。' : '当前没有待分析的剧集。'); return; }
    setBatchAnalyzing(true); setError('');
    try {
      await analysisApi.analyzeComicDramaEpisodes(projectIdRef.current, { episodeIds: targets.map(episode => episode.id), modelId: analysisModel || undefined });
      let project: any;
      do {
        await new Promise(resolve => setTimeout(resolve, 1500));
        project = await analysisApi.getComicDramaProject(projectIdRef.current!);
        setEpisodes(project.episodes || []); setSeriesOverview(project.overview || null);
      } while (project.episodes?.some((episode: ComicDramaEpisodeSummary) => ['analysis_queued', 'analyzing'].includes(episode.status)));
      setSelectedEpisodeIds(new Set());
      const active = project.episodes?.find((episode: ComicDramaEpisodeSummary) => episode.id === episodeIdRef.current);
      if (!blueprint && active && !['draft', 'analysis_failed'].includes(active.status)) await openEpisode(project, active.id);
    } catch (e: any) { setError(e.message || '批量分析失败，请重试'); }
    finally { setBatchAnalyzing(false); }
  };

  const beginEditAsset = (asset: AssetTask) => {
    setEditingAssetKey(`${asset.kind}:${asset.name}`);
    setAssetDraft({ ...asset, aliases: [...(asset.aliases || [])], variant: asset.variant || '基础造型' });
  };

  const saveAssetDraft = async () => {
    if (!assetDraft || !projectIdRef.current) return;
    const nextShared = sharedAssets.map(asset => `${asset.kind}:${asset.name}` === editingAssetKey ? { ...asset, ...assetDraft } : asset);
    const currentAsset = assetsRef.current.find(asset => `${asset.kind}:${asset.name}` === editingAssetKey);
    if (currentAsset) {
      const nextAssets = assetsRef.current.map(asset => `${asset.kind}:${asset.name}` === editingAssetKey ? { ...assetDraft, id: asset.id } : asset);
      updateAssets(nextAssets); persist(nextAssets, shotsRef.current, 'planned');
    } else {
      projectStateRef.current = { ...projectStateRef.current, sharedAssets: nextShared };
      setSharedAssets(nextShared);
      await analysisApi.saveComicDramaProjectState(projectIdRef.current, projectStateRef.current);
    }
    setSharedAssets(nextShared); setEditingAssetKey(''); setAssetDraft(null);
  };

  const uploadAssetImage = async (file?: File) => {
    if (!file || !assetDraft) return;
    setError('');
    try {
      const result = await analysisApi.uploadComicDramaAsset(file);
      setAssetDraft({ ...assetDraft, url: result.url, status: 'done' });
    } catch (e: any) { setError(e.message || '资产图片上传失败'); }
  };

  const addShot = (sceneNumber: number, sceneTitle: string) => {
    const sceneShots = shotsRef.current.filter(item => item.sceneNumber === sceneNumber);
    const previous = sceneShots[sceneShots.length - 1];
    const next: ShotTask = {
      id: `${sceneNumber}-custom-${Date.now()}`, sceneNumber, sceneTitle, status: 'pending',
      shot: { shotNumber: sceneShots.length + 1, duration: 5, shotSize: '中景', camera: '固定机位', action: '描述本镜头的单一动作', dialogue: '', characters: [], imagePrompt: '', videoPrompt: '', continuityStart: previous?.shot.continuityEnd || '', continuityEnd: '' },
    };
    const all = [...shotsRef.current, next]; updateShots(all); persist(assetsRef.current, all, 'planned'); setEditingShot(next);
  };

  const saveShotDraft = () => {
    if (!editingShot) return;
    const next = shotsRef.current.map(item => item.id === editingShot.id ? { ...editingShot, status: editingShot.imageUrl ? editingShot.status : 'pending' as const } : item);
    updateShots(next); persist(assetsRef.current, next, 'planned'); setEditingShot(null);
  };

  const moveShot = (id: string, direction: -1 | 1) => {
    const next = [...shotsRef.current]; const index = next.findIndex(item => item.id === id); if (index < 0) return;
    const sameSceneIndexes = next.map((item, i) => item.sceneNumber === next[index].sceneNumber ? i : -1).filter(i => i >= 0);
    const sceneIndex = sameSceneIndexes.indexOf(index); const target = sameSceneIndexes[sceneIndex + direction]; if (target === undefined) return;
    [next[index], next[target]] = [next[target], next[index]];
    sameSceneIndexes.forEach((position, i) => { next[position] = { ...next[position], shot: { ...next[position].shot, shotNumber: i + 1 } }; });
    updateShots(next); persist(assetsRef.current, next, 'planned');
  };

  const deleteShot = (id: string) => {
    if (!window.confirm('确定删除这个镜头吗？该镜头已生成的图片和视频记录也会移除。')) return;
    const removed = shotsRef.current.find(item => item.id === id); const next = shotsRef.current.filter(item => item.id !== id);
    const sameScene = next.filter(item => item.sceneNumber === removed?.sceneNumber);
    const renumbered = next.map(item => item.sceneNumber === removed?.sceneNumber ? { ...item, shot: { ...item.shot, shotNumber: sameScene.findIndex(shot => shot.id === item.id) + 1 } } : item);
    updateShots(renumbered); persist(assetsRef.current, renumbered, 'planned');
  };

  const loadExportSummary = async (scope: 'current' | 'all') => {
    if (!projectIdRef.current) return;
    setExportScope(scope); setExportSummary(null); setError('');
    try { setExportSummary(await analysisApi.getComicDramaExportSummary(projectIdRef.current, scope === 'current' ? episodeIdRef.current || undefined : undefined)); }
    catch (e: any) { setError(e.message || '读取视频导出状态失败'); }
  };

  const openExport = () => {
    setExportOpen(true); setIncludeUnapproved(false); void loadExportSummary('current');
  };

  const exportVideos = async () => {
    if (!projectIdRef.current || !episodeIdRef.current || exporting) return;
    setExporting(true); setError('');
    try {
      const result = await analysisApi.exportComicDramaVideos(projectIdRef.current, { episodeId: episodeIdRef.current, scope: exportScope, includeUnapproved });
      window.location.assign(result.url);
      setExportOpen(false);
    } catch (e: any) { setError(e.message || '视频打包失败'); }
    finally { setExporting(false); }
  };

  const renumberPlan = (episodes: ComicDramaSeriesPlan['episodes']) => episodes.map((episode, index) => ({ ...episode, episodeNumber: index + 1, characterCount: episode.script.length }));
  const updatePlanEpisode = (index: number, patch: Partial<ComicDramaSeriesPlan['episodes'][number]>) => {
    if (!seriesPlan) return; setSeriesPlan({ ...seriesPlan, episodes: renumberPlan(seriesPlan.episodes.map((episode, i) => i === index ? { ...episode, ...patch } : episode)) });
  };
  const movePlanEpisode = (index: number, direction: -1 | 1) => {
    if (!seriesPlan) return; const target = index + direction; if (target < 0 || target >= seriesPlan.episodes.length) return;
    const episodes = [...seriesPlan.episodes]; [episodes[index], episodes[target]] = [episodes[target], episodes[index]]; setSeriesPlan({ ...seriesPlan, episodes: renumberPlan(episodes) });
  };
  const splitPlanEpisode = (index: number) => {
    if (!seriesPlan) return; const episode = seriesPlan.episodes[index]; const middle = Math.floor(episode.script.length / 2);
    let boundary = episode.script.indexOf('\n', middle); if (boundary < 20 || episode.script.length - boundary < 20) boundary = middle;
    const first = episode.script.slice(0, boundary).trim(); const second = episode.script.slice(boundary).trim();
    if (first.length < 20 || second.length < 20) { setError('这一集内容太短，无法继续拆分。'); return; }
    const episodes = [...seriesPlan.episodes]; episodes.splice(index, 1, { ...episode, title: `${episode.title}（上）`, script: first, characterCount: first.length }, { ...episode, title: `${episode.title}（下）`, summary: '', hook: episode.hook, script: second, characterCount: second.length });
    setSeriesPlan({ ...seriesPlan, episodes: renumberPlan(episodes) });
  };
  const mergePlanEpisode = (index: number) => {
    if (!seriesPlan || index <= 0) return; const previous = seriesPlan.episodes[index - 1]; const current = seriesPlan.episodes[index];
    const mergedScript = `${previous.script.trim()}\n\n${current.script.trim()}`;
    if (mergedScript.length > 50000) { setError('合并后超过单集 5 万字限制，请先调整原文。'); return; }
    const episodes = [...seriesPlan.episodes]; episodes.splice(index - 1, 2, { ...previous, title: previous.title.replace(/（上）$/, ''), summary: [previous.summary, current.summary].filter(Boolean).join('；'), hook: current.hook || previous.hook, script: mergedScript, characterCount: mergedScript.length });
    setSeriesPlan({ ...seriesPlan, episodes: renumberPlan(episodes) });
  };
  const createSeries = async () => {
    if (!seriesPlan || creatingSeries || !requireAuth()) return;
    if (seriesPlan.episodes.some(episode => episode.script.trim().length < 20 || episode.script.length > 50000)) { setError('每集剧本必须在 20 到 50,000 字之间。'); return; }
    setCreatingSeries(true); setError('');
    try {
      const project = await analysisApi.createComicDramaSeries({ title: seriesPlan.title, originalScript: script, plan: seriesPlan });
      setSeriesPlan(null); setInputMode('episode'); await loadProject(project.id);
      analysisApi.listComicDramaProjects().then(setRecentProjects).catch(() => {});
    } catch (e: any) { setError(e.message || '批量创建剧集失败'); }
    finally { setCreatingSeries(false); }
  };

  const analyze = async () => {
    if (!requireAuth()) return;
    const minimum = inputMode === 'series' ? 200 : 20;
    const maximum = inputMode === 'series' ? 500000 : 50000;
    if (script.trim().length < minimum) { setError(`请先粘贴${inputMode === 'series' ? '整部' : '单集'}剧本，至少 ${minimum} 个字。`); return; }
    if (script.length > maximum) { setError(`剧本不能超过 ${maximum.toLocaleString()} 字。`); return; }
    setAnalyzing(true); setError('');
    try {
      if (inputMode === 'series' && !projectIdRef.current) {
        const plan = await analysisApi.planComicDramaSeries(script.trim(), { targetDuration: targetEpisodeDuration, requestedEpisodes: requestedEpisodeCount ? Number(requestedEpisodeCount) : undefined, modelId: analysisModel || undefined });
        setSeriesPlan(plan); return;
      }
      const result = projectIdRef.current && episodeIdRef.current
        ? await analysisApi.analyzeComicDramaEpisode(projectIdRef.current, episodeIdRef.current, script.trim(), analysisModel || undefined)
        : await analysisApi.analyzeComicDramaScript(script.trim(), analysisModel || undefined);
      setBlueprint(result);
      const newProjectId = result.projectId || projectIdRef.current || null;
      const newEpisodeId = result.episodeId || episodeIdRef.current || null;
      setProjectId(newProjectId); projectIdRef.current = newProjectId;
      setEpisodeId(newEpisodeId); episodeIdRef.current = newEpisodeId;
      if (newProjectId) localStorage.setItem('comic-drama-active-project', String(newProjectId));
      if (newProjectId && newEpisodeId) localStorage.setItem(`comic-drama-active-episode-${newProjectId}`, String(newEpisodeId));
      const sharedByKey = new Map<string, AssetTask>((projectStateRef.current.sharedAssets || []).map((asset: AssetTask) => [`${asset.kind}:${asset.name}`, asset]));
      const proposedAssets: AssetTask[] = [
        ...result.characters.map((x, i) => ({ id: `character-${i}`, name: x.name, kind: '角色' as const, prompt: `${result.visualStyle}。${x.assetPrompt}`, status: 'pending' as const })),
        ...result.scenes.map((x, i) => ({ id: `scene-${i}`, name: x.title, kind: '场景' as const, prompt: `${result.visualStyle}。${x.assetPrompt}`, status: 'pending' as const })),
        ...result.props.map((x, i) => ({ id: `prop-${i}`, name: x.name, kind: '道具' as const, prompt: `${result.visualStyle}。${x.assetPrompt}`, status: 'pending' as const })),
      ];
      const nextAssets = proposedAssets.map(asset => {
        const shared = [...sharedByKey.values()].find(candidate => candidate.kind === asset.kind && (candidate.name === asset.name || candidate.aliases?.includes(asset.name)));
        if (!shared) return asset;
        return { ...asset, name: shared.name, aliases: shared.aliases, variant: shared.variant, locked: shared.locked, prompt: shared.prompt || asset.prompt, status: shared.url ? 'done' as const : asset.status, url: shared.url, qualityScore: shared.qualityScore, qualityReport: shared.qualityReport };
      });
      const nextShots = result.scenes.flatMap(scene => scene.shots.map((shot, i) => ({ id: `${scene.sceneNumber}-${shot.shotNumber || i + 1}`, sceneNumber: scene.sceneNumber, sceneTitle: scene.title, shot, status: 'pending' as const })));
      updateAssets(nextAssets); updateShots(nextShots); setExpandedScene(result.scenes[0]?.sceneNumber ?? null);
      if (newProjectId && newEpisodeId) {
        await analysisApi.saveComicDramaEpisodeState(newProjectId, newEpisodeId, { assets: nextAssets, shots: nextShots, qualityEnabled, qualityRetries, selected, imageModel, videoModel, analysisModel }, 'planned');
        for (const asset of nextAssets) {
          const key = `${asset.kind}:${asset.name}`;
          if (!sharedByKey.has(key)) sharedByKey.set(key, asset);
        }
        projectStateRef.current = { ...projectStateRef.current, activeEpisodeId: newEpisodeId, sharedAssets: [...sharedByKey.values()] };
        setSharedAssets(projectStateRef.current.sharedAssets);
        await analysisApi.saveComicDramaProjectState(newProjectId, projectStateRef.current);
        const project = await analysisApi.getComicDramaProject(newProjectId);
        setProjectTitle(project.title || result.title); setEpisodes(project.episodes || []);
      }
    } catch (e: any) { setError(e.message || '剧本分析失败，请重试'); }
    finally { setAnalyzing(false); }
  };

  const imageOnce = (prompt: string, referenceImages: string[] = []) => new Promise<string>((resolve, reject) => {
    abortRef.current = generateImage({ prompt, model: imageModel || undefined, aspect_ratio: '9:16', n: 1, reference_images: referenceImages.slice(0, 4) }, event => {
      if (event.type === 'complete' && event.imageUrls?.[0]) resolve(event.imageUrls[0]);
      else if (event.type === 'image_ready' && event.imageUrl) resolve(event.imageUrl);
      else if (event.type === 'error') reject(new Error(event.message || '图片生成失败'));
    });
  });

  const videoOnce = (task: ShotTask) => new Promise<string>((resolve, reject) => {
    const model = videoModels.find(m => m.id === videoModel);
    const allowed = model?.allowedSeconds?.length ? model.allowedSeconds : [5, 10];
    const duration = allowed.reduce((best, n) => Math.abs(n - task.shot.duration) < Math.abs(best - task.shot.duration) ? n : best, allowed[0] || 5);
    const prompt = [task.shot.videoPrompt, `开始状态：${task.shot.continuityStart || '承接上一镜'}`, `结束状态：${task.shot.continuityEnd || '动作完整收束'}`].join('。');
    abortRef.current = generateVideo({ prompt, model: videoModel || undefined, aspect_ratio: '9:16', video_length: duration, reference_images: task.imageUrl ? [task.imageUrl] : [] }, event => {
      if (event.type === 'complete' && event.videoUrl) resolve(event.videoUrl);
      else if (event.type === 'error') reject(new Error(event.message || '视频生成失败'));
    });
  });

  const imageWithQuality = async (prompt: string, kind: string, name: string, references: string[] = []) => {
    let activePrompt = prompt;
    let lastUrl = '';
    let report: QualityReport | undefined;
    const maxAttempts = qualityEnabled ? qualityRetries + 1 : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      lastUrl = await imageOnce(activePrompt, references);
      if (!qualityEnabled) return { url: lastUrl, attempts: attempt };
      try {
        report = await analysisApi.reviewComicDramaImage({ imageUrl: lastUrl, kind, name, expectedPrompt: prompt, visualStyle: blueprint?.visualStyle || '', modelId: analysisModel || undefined });
      } catch (reviewError: any) {
        return { url: lastUrl, attempts: attempt, report: { score: 0, consistencyPassed: false, summary: `质检暂不可用：${reviewError.message}`, issues: [], correctedPrompt: activePrompt } as QualityReport };
      }
      if (report.consistencyPassed && report.score >= 75) return { url: lastUrl, attempts: attempt, report };
      activePrompt = report.correctedPrompt || activePrompt;
    }
    return { url: lastUrl, attempts: maxAttempts, report };
  };

  const generateNext = async (kind: PipelineKind, retryErrors = true): Promise<boolean> => {
    if (kind === 'assets') {
      const task = assetsRef.current.find(x => x.status === 'pending') || (retryErrors ? assetsRef.current.find(x => x.status === 'error') : undefined);
      if (!task) return false;
      patchAsset(task.id, { status: 'running', error: undefined });
      try { const result = await imageWithQuality(task.prompt, task.kind, task.name); patchAsset(task.id, { status: 'done', url: result.url, attempts: result.attempts, qualityScore: result.report?.score, qualityReport: result.report }); }
      catch (e: any) { patchAsset(task.id, { status: 'error', error: e.message }); if (stopRef.current) return false; }
      return true;
    }
    if (kind === 'storyboards') {
      const task = shotsRef.current.find(x => !x.imageUrl && x.status === 'pending') || (retryErrors ? shotsRef.current.find(x => !x.imageUrl && x.status === 'error') : undefined);
      if (!task) return false;
      patchShot(task.id, { status: 'running', error: undefined });
      const refs = assetsRef.current.filter(a => a.url && (a.kind === '角色' || a.kind === '场景')).map(a => a.url!)
      try { const result = await imageWithQuality(`${blueprint?.visualStyle}。${task.shot.imagePrompt}。连续性要求：${task.shot.continuityStart || '承接上一镜结束状态'}`, '分镜', `${task.sceneTitle} 镜头${task.shot.shotNumber}`, refs); patchShot(task.id, { status: 'done', imageUrl: result.url, attempts: result.attempts, qualityScore: result.report?.score, qualityReport: result.report }); }
      catch (e: any) { patchShot(task.id, { status: 'error', error: e.message }); if (stopRef.current) return false; }
      return true;
    }
    const task = shotsRef.current.find(x => !x.videoUrl && (x.status === 'pending' || x.status === 'done')) || (retryErrors ? shotsRef.current.find(x => !x.videoUrl && x.status === 'error') : undefined);
    if (!task) return false;
    patchShot(task.id, { status: 'running', error: undefined });
    try {
      const videoUrl = await videoOnce(task); let report: QualityReport | undefined;
      let reviewUnavailable = false;
      if (qualityEnabled) {
        try { report = await analysisApi.reviewComicDramaVideo({ videoUrl, name: `${task.sceneTitle} 镜头${task.shot.shotNumber}`, expectedPrompt: task.shot.videoPrompt, continuityStart: task.shot.continuityStart, continuityEnd: task.shot.continuityEnd, visualStyle: blueprint?.visualStyle || '', modelId: analysisModel || undefined }); }
        catch (reviewError: any) { reviewUnavailable = true; report = { score: 0, consistencyPassed: false, summary: `视频已生成，质检暂不可用：${reviewError.message}`, issues: [], correctedPrompt: task.shot.videoPrompt }; }
      }
      const passed = !qualityEnabled || reviewUnavailable || (!!report?.consistencyPassed && report.score >= 75);
      patchShot(task.id, { status: passed ? 'done' : 'error', videoUrl, videoAttempts: (task.videoAttempts || 0) + 1, videoQualityScore: reviewUnavailable ? undefined : report?.score, videoQualityReport: report, error: passed ? undefined : report?.summary || '视频质检未通过' });
    }
    catch (e: any) { patchShot(task.id, { status: 'error', error: e.message }); if (stopRef.current) return false; }
    return true;
  };

  const run = async (automation: boolean) => {
    if (!requireAuth() || running) return;
    if (!imageModel && (selected.assets || selected.storyboards)) { setError('当前账号没有可用的图片模型。'); return; }
    if (!videoModel && selected.videos) { setError('当前账号没有可用的视频模型。'); return; }
    setRunning(true); setManaged(automation); setError(''); stopRef.current = false;
    try {
      const order: PipelineKind[] = ['assets', 'storyboards', 'videos'];
      if (automation && projectIdRef.current && episodeIdRef.current) {
        const id = projectIdRef.current;
        await analysisApi.startComicDramaManaged(id, episodeIdRef.current, { assets: assetsRef.current, shots: shotsRef.current, selected, qualityEnabled, qualityRetries, imageModel, videoModel, analysisModel }, managedScope);
        while (!stopRef.current) {
          await new Promise(resolve => setTimeout(resolve, 2_000));
          const project = await loadProject(id);
          if (!['queued', 'producing'].includes(project.status)) break;
        }
      } else if (automation) {
        for (const kind of order) {
          if (!selected[kind]) continue;
          while (!stopRef.current && await generateNext(kind, false)) { /* task queue */ }
        }
      } else {
        for (const kind of order) {
          if (selected[kind] && await generateNext(kind)) break;
        }
      }
    } finally { setRunning(false); setManaged(false); abortRef.current = null; }
  };

  const stop = () => { stopRef.current = true; abortRef.current?.abort(); if (projectIdRef.current && managed) analysisApi.stopComicDramaManaged(projectIdRef.current).catch(() => {}); setRunning(false); setManaged(false); };
  const reset = () => { stop(); setBlueprint(null); setSeriesPlan(null); setInputMode('episode'); setProjectId(null); projectIdRef.current = null; setProjectTitle(''); setEpisodes([]); setSeriesOverview(null); setSelectedEpisodeIds(new Set()); setEpisodeId(null); episodeIdRef.current = null; projectStateRef.current = {}; localStorage.removeItem('comic-drama-active-project'); updateAssets([]); setSharedAssets([]); updateShots([]); setScript(''); setError(''); };
  const onFile = async (file?: File) => { if (!file) return; if (file.size > 5 * 1024 * 1024) { setError('文本文件请控制在 5MB 以内。'); return; } const text = await file.text(); const maximum = inputMode === 'series' ? 500000 : 50000; if (text.length > maximum) { setError(`当前模式最多支持 ${maximum.toLocaleString()} 字。`); return; } setScript(text); };
  const episodeTabs = projectId && episodes.length > 0 ? (
    <div className="border-b border-white/10 bg-[#0c0f13]/80 px-5 py-3 md:px-8">
      <div className="mx-auto flex max-w-7xl items-center gap-2 overflow-x-auto">
        <span className="mr-1 shrink-0 text-[10px] uppercase tracking-wider text-zinc-600">剧集</span>
        {episodes.map(episode => {
          const active = episode.id === episodeId;
          const progress = episode.taskCount ? Math.round(episode.doneCount / episode.taskCount * 100) : 0;
          return <button key={episode.id} onClick={() => switchEpisode(episode.id).catch(e => setError(e.message))} disabled={running} className={`shrink-0 rounded-xl border px-3 py-2 text-left transition ${active ? 'border-cyan-400/40 bg-cyan-400/10 text-cyan-200' : 'border-white/10 bg-white/[0.02] text-zinc-400 hover:bg-white/5'}`}><span className="block text-xs font-medium">第{episode.episodeNumber}集</span><span className="mt-0.5 block text-[9px] opacity-60">{episode.status === 'draft' ? '待分析' : `${progress}%`}</span></button>;
        })}
        <button onClick={createEpisode} disabled={running} className="flex shrink-0 items-center gap-1.5 rounded-xl border border-dashed border-white/15 px-3 py-2 text-xs text-zinc-500 hover:border-cyan-400/30 hover:text-cyan-300 disabled:opacity-40"><Plus className="h-3.5 w-3.5" />新增一集</button>
      </div>
    </div>
  ) : null;

  const seriesDashboard = projectId && episodes.length > 0 ? (() => {
    const eligible = episodes.filter(episode => ['draft', 'analysis_failed'].includes(episode.status));
    const failed = episodes.filter(episode => episode.status === 'analysis_failed');
    const analyzed = seriesOverview?.episodes?.analyzed ?? episodes.filter(episode => !['draft', 'analysis_queued', 'analyzing', 'analysis_failed'].includes(episode.status)).length;
    const totals = ['asset', 'storyboard', 'video'].reduce((sum, kind) => {
      const item = seriesOverview?.[kind] || { total: 0, done: 0, running: 0, failed: 0, pending: 0 };
      return { total: sum.total + item.total, done: sum.done + item.done, running: sum.running + item.running, failed: sum.failed + item.failed };
    }, { total: 0, done: 0, running: 0, failed: 0 });
    const productionPercent = totals.total ? Math.round(totals.done / totals.total * 100) : 0;
    const statusLabel: Record<string, string> = { draft: '待分析', analysis_queued: '排队中', analyzing: '分析中', analysis_failed: '分析失败', planned: '待制作', queued: '待生成', producing: '生成中', done: '已完成', paused: '已暂停' };
    const toggleAll = () => setSelectedEpisodeIds(current => {
      const allSelected = eligible.length > 0 && eligible.every(episode => current.has(episode.id));
      return allSelected ? new Set() : new Set(eligible.map(episode => episode.id));
    });
    return <section className="border-b border-white/10 bg-[#0b0e12] px-5 py-4 md:px-8"><div className="mx-auto max-w-7xl rounded-2xl border border-white/10 bg-[#101318] p-4"><div className="flex flex-wrap items-center justify-between gap-3"><button onClick={() => setOverviewExpanded(value => !value)} className="flex items-center gap-3 text-left"><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-cyan-400/10"><Clapperboard className="h-4 w-4 text-cyan-300" /></span><span><span className="block text-sm font-semibold">全剧制作进度</span><span className="mt-0.5 block text-[10px] text-zinc-500">已分析 {analyzed}/{episodes.length} 集 · 素材制作 {productionPercent}%</span></span>{overviewExpanded ? <ChevronDown className="h-4 w-4 text-zinc-600" /> : <ChevronRight className="h-4 w-4 text-zinc-600" />}</button><div className="flex flex-wrap gap-2">{eligible.length > 0 && <button onClick={toggleAll} disabled={batchAnalyzing || running} className="rounded-lg border border-white/10 px-3 py-2 text-[10px] text-zinc-400 disabled:opacity-40">{eligible.every(episode => selectedEpisodeIds.has(episode.id)) ? '取消选择' : '选择全部待分析'}</button>}{failed.length > 0 && <button onClick={() => batchAnalyzeEpisodes(true)} disabled={batchAnalyzing || running} className="flex items-center gap-1.5 rounded-lg border border-red-400/20 bg-red-400/5 px-3 py-2 text-[10px] text-red-300 disabled:opacity-40"><RotateCcw className="h-3 w-3" />重试失败 {failed.length} 集</button>}<button onClick={() => batchAnalyzeEpisodes(false)} disabled={!eligible.length || batchAnalyzing || running} className="flex items-center gap-1.5 rounded-lg bg-cyan-400 px-4 py-2 text-xs font-semibold text-zinc-950 disabled:opacity-40">{batchAnalyzing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <WandSparkles className="h-3.5 w-3.5" />}{batchAnalyzing ? '正在批量分析…' : `批量分析${selectedEpisodeIds.size ? ` ${selectedEpisodeIds.size} 集` : '全部剧集'}`}</button></div></div>{overviewExpanded && <><div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-5">{[[`剧本分析`,`${analyzed}/${episodes.length}`],[`资产图`,`${seriesOverview?.asset?.done || 0}/${seriesOverview?.asset?.total || 0}`],[`分镜图`,`${seriesOverview?.storyboard?.done || 0}/${seriesOverview?.storyboard?.total || 0}`],[`视频镜头`,`${seriesOverview?.video?.done || 0}/${seriesOverview?.video?.total || 0}`],[`异常任务`,String(totals.failed)]].map(([label,value], index) => <div key={label} className="rounded-xl bg-white/[0.025] p-3"><p className={`text-lg font-semibold ${index===4 && totals.failed ? 'text-red-400' : 'text-zinc-200'}`}>{value}</p><p className="mt-1 text-[10px] text-zinc-600">{label}</p></div>)}</div><div className="mt-3 max-h-64 space-y-2 overflow-y-auto pr-1">{episodes.map(episode => { const selectable = ['draft','analysis_failed'].includes(episode.status); const episodeTotal = episode.taskCount || 0; const episodePercent = episodeTotal ? Math.round((episode.doneCount || 0) / episodeTotal * 100) : 0; return <div key={episode.id} className={`grid items-center gap-2 rounded-xl border px-3 py-2.5 md:grid-cols-[28px_1fr_90px_repeat(3,90px)] ${episode.id===episodeId ? 'border-cyan-400/30 bg-cyan-400/[0.04]' : 'border-white/5 bg-black/20'}`}><div>{selectable && <input type="checkbox" checked={selectedEpisodeIds.has(episode.id)} onChange={() => setSelectedEpisodeIds(current => { const next = new Set(current); next.has(episode.id) ? next.delete(episode.id) : next.add(episode.id); return next; })} className="accent-cyan-400" />}</div><button onClick={() => switchEpisode(episode.id).catch(e => setError(e.message))} disabled={running || batchAnalyzing} className="min-w-0 text-left disabled:opacity-60"><p className="truncate text-xs text-zinc-200">第{episode.episodeNumber}集 · {episode.title}</p><p className={`mt-1 text-[9px] ${episode.status==='analysis_failed'?'text-red-400':episode.status==='analyzing'?'text-cyan-300':'text-zinc-600'}`}>{statusLabel[episode.status] || episode.status}{episode.analysisError ? ` · ${episode.analysisError}` : ''}</p></button><div className="text-right text-[10px] text-zinc-500">{episodeTotal ? `${episodePercent}%` : '未开始'}</div>{(['asset','storyboard','video'] as const).map(kind => { const progress = episode.progress?.[kind]; return <div key={kind} className="hidden text-right text-[10px] text-zinc-500 md:block">{progress ? `${progress.done}/${progress.total}` : '0/0'}</div>; })}</div>; })}</div></>}</div></section>;
  })() : null;

  if (seriesPlan) return (
    <div className="comic-drama-page min-h-full bg-transparent text-white">
      <div className="mx-auto max-w-6xl px-5 py-8 md:px-10">
        <div className="flex flex-wrap items-start justify-between gap-4"><div><div className="mb-3 inline-flex items-center gap-2 rounded-full border border-cyan-400/20 bg-cyan-400/5 px-3 py-1 text-xs text-cyan-300"><Clapperboard className="h-3.5 w-3.5" />分集方案确认</div><h1 className="text-2xl font-semibold">确认后批量建立剧集</h1><p className="mt-2 text-sm text-zinc-500">AI 只规划段落边界；下方剧本文字均来自用户原文，可在创建前调整。</p></div><div className="flex gap-2"><button onClick={() => setSeriesPlan(null)} className="rounded-xl border border-white/10 px-4 py-2 text-xs text-zinc-300">返回修改原文</button><button onClick={createSeries} disabled={creatingSeries || !seriesPlan.episodes.length} className="flex items-center gap-2 rounded-xl bg-cyan-400 px-5 py-2 text-xs font-semibold text-zinc-950 disabled:opacity-40">{creatingSeries ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}{creatingSeries ? '正在创建…' : `确认并创建 ${seriesPlan.episodes.length} 集`}</button></div></div>
        <section className="mt-6 rounded-2xl border border-white/10 bg-[#101318] p-5"><div className="grid gap-4 md:grid-cols-[1fr_180px_180px]"><label className="text-[10px] text-zinc-500">项目名称<input value={seriesPlan.title} onChange={e => setSeriesPlan({...seriesPlan,title:e.target.value})} className="mt-1 w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-zinc-200 outline-none" /></label><div className="rounded-xl bg-white/[0.025] p-3"><p className="text-[10px] text-zinc-600">原文总字数</p><p className="mt-1 text-lg font-semibold text-zinc-200">{seriesPlan.totalCharacters.toLocaleString()}</p></div><div className="rounded-xl bg-white/[0.025] p-3"><p className="text-[10px] text-zinc-600">规划集数</p><p className="mt-1 text-lg font-semibold text-cyan-300">{seriesPlan.episodes.length} 集</p></div></div><div className="mt-4 grid gap-3 md:grid-cols-2"><label className="text-[10px] text-zinc-500">一句话故事<input value={seriesPlan.logline} onChange={e => setSeriesPlan({...seriesPlan,logline:e.target.value})} className="mt-1 w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-xs text-zinc-200 outline-none" /></label><label className="text-[10px] text-zinc-500">全剧视觉方向<input value={seriesPlan.visualStyle} onChange={e => setSeriesPlan({...seriesPlan,visualStyle:e.target.value})} className="mt-1 w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-xs text-zinc-200 outline-none" /></label></div></section>
        <div className="mt-5 space-y-3">{seriesPlan.episodes.map((episode,index) => <details key={`${episode.episodeNumber}-${index}`} className="group rounded-2xl border border-white/10 bg-[#101318]" open={index===0}><summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-4"><span className="rounded-lg bg-cyan-400/10 px-2 py-1 text-xs text-cyan-300">第{index+1}集</span><div className="min-w-0 flex-1"><p className="truncate text-sm text-zinc-200">{episode.title}</p><p className="mt-1 truncate text-[10px] text-zinc-600">{episode.characterCount.toLocaleString()} 字 · 约 {episode.estimatedDuration} 秒 · 悬念：{episode.hook || '待补充'}</p></div><ChevronDown className="h-4 w-4 text-zinc-600 transition group-open:rotate-180" /></summary><div className="border-t border-white/5 p-4"><div className="grid gap-3 md:grid-cols-2"><label className="text-[10px] text-zinc-500">集名<input value={episode.title} onChange={e => updatePlanEpisode(index,{title:e.target.value})} className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs text-zinc-200" /></label><label className="text-[10px] text-zinc-500">结尾悬念<input value={episode.hook} onChange={e => updatePlanEpisode(index,{hook:e.target.value})} className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs text-zinc-200" /></label></div><label className="mt-3 block text-[10px] text-zinc-500">本集梗概<textarea value={episode.summary} onChange={e => updatePlanEpisode(index,{summary:e.target.value})} className="mt-1 min-h-16 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs leading-5 text-zinc-200" /></label><label className="mt-3 block text-[10px] text-zinc-500">本集原文<textarea value={episode.script} onChange={e => updatePlanEpisode(index,{script:e.target.value})} className="mt-1 min-h-52 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs leading-6 text-zinc-300 outline-none" /></label><div className="mt-3 flex flex-wrap gap-2"><button disabled={index===0} onClick={() => movePlanEpisode(index,-1)} className="flex items-center gap-1 rounded-lg border border-white/10 px-2.5 py-1.5 text-[10px] text-zinc-400 disabled:opacity-30"><ArrowUp className="h-3 w-3" />上移</button><button disabled={index===seriesPlan.episodes.length-1} onClick={() => movePlanEpisode(index,1)} className="flex items-center gap-1 rounded-lg border border-white/10 px-2.5 py-1.5 text-[10px] text-zinc-400 disabled:opacity-30"><ArrowDown className="h-3 w-3" />下移</button><button onClick={() => splitPlanEpisode(index)} className="rounded-lg border border-white/10 px-2.5 py-1.5 text-[10px] text-zinc-400">拆成两集</button><button disabled={index===0} onClick={() => mergePlanEpisode(index)} className="rounded-lg border border-white/10 px-2.5 py-1.5 text-[10px] text-zinc-400 disabled:opacity-30">合并到上一集</button></div></div></details>)}</div>
        {error && <div className="mt-4 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</div>}
      </div>
    </div>
  );

  if (!blueprint) return (
    <div className="comic-drama-page min-h-full bg-transparent text-white">
      {episodeTabs}
      {seriesDashboard}
      <div className="mx-auto max-w-6xl px-5 py-8 md:px-10 md:py-12">
        <div className="mb-9 flex items-start justify-between gap-6">
          <div><div className="mb-3 inline-flex items-center gap-2 rounded-full border border-cyan-400/20 bg-cyan-400/5 px-3 py-1 text-xs text-cyan-300"><Sparkles className="h-3.5 w-3.5" /> {projectId ? `${projectTitle} · 第${episodeNumber}集` : 'AI 漫剧流水线'}</div><h1 className="text-3xl font-semibold tracking-tight">{projectId ? `录入第${episodeNumber}集剧本` : inputMode==='series' ? '导入整部剧本并自动分集' : '把剧本变成可生产的镜头'}</h1><p className="mt-3 max-w-2xl text-sm leading-6 text-zinc-400">{inputMode==='series' && !projectId ? '系统先规划每集边界、剧情推进与结尾悬念，由你确认后一次性创建全部剧集；原文不会被 AI 改写。' : '粘贴一集剧本，自动提取角色与场景、拆解分镜、准备图片和视频提示词。'}</p></div>
          <div className="hidden h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.03] md:flex"><Clapperboard className="h-6 w-6 text-cyan-300" /></div>
        </div>
        {recentProjects.length > 0 && <div className="mb-5 flex items-center gap-2 overflow-x-auto pb-1"><span className="shrink-0 text-xs text-zinc-500">最近项目</span>{recentProjects.slice(0, 6).map(project => <button key={project.id} onClick={() => loadProject(project.id).catch(e => setError(e.message))} className="shrink-0 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2 text-left hover:bg-white/5"><span className="block max-w-40 truncate text-xs text-zinc-300">{project.title}</span><span className="mt-0.5 block text-[9px] text-zinc-600">{project.episodeCount || 1} 集 · {project.status}</span></button>)}</div>}
        {!projectId && <div className="mb-5 grid max-w-md grid-cols-2 rounded-xl border border-white/10 bg-[#101318] p-1"><button onClick={() => { setInputMode('episode'); setError(''); }} className={`rounded-lg px-4 py-2.5 text-xs ${inputMode==='episode'?'bg-cyan-400/10 text-cyan-300':'text-zinc-500'}`}>单集剧本</button><button onClick={() => { setInputMode('series'); setError(''); }} className={`rounded-lg px-4 py-2.5 text-xs ${inputMode==='series'?'bg-cyan-400/10 text-cyan-300':'text-zinc-500'}`}>整部剧本自动分集</button></div>}
        <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
          <section className="rounded-3xl border border-white/10 bg-[#101318] p-5 shadow-2xl shadow-black/30">
            <div className="mb-3 flex items-center justify-between"><label className="flex items-center gap-2 text-sm font-medium"><FileText className="h-4 w-4 text-cyan-300" />{inputMode==='series' && !projectId ? '整部剧本内容' : '单集剧本内容'}</label><span className="text-xs text-zinc-600">{script.length.toLocaleString()} / {(inputMode==='series' && !projectId ? 500000 : 50000).toLocaleString()} 字</span></div>
            <textarea value={script} maxLength={inputMode==='series' && !projectId ? 500000 : 50000} onChange={e => setScript(e.target.value)} placeholder={inputMode==='series' && !projectId ? '粘贴整部剧本，系统将规划集数和每集边界，不会改写原文……' : '粘贴一集剧本，支持场次、人物、动作和台词……'} className="min-h-[430px] w-full resize-none rounded-2xl border border-white/10 bg-black/30 p-5 text-sm leading-7 text-zinc-200 outline-none transition placeholder:text-zinc-700 focus:border-cyan-400/40 focus:ring-2 focus:ring-cyan-400/10" />
            {inputMode==='series' && !projectId && <div className="mt-3 grid gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-3 sm:grid-cols-2"><label className="text-[10px] text-zinc-500">每集目标时长<select value={targetEpisodeDuration} onChange={e => setTargetEpisodeDuration(Number(e.target.value))} className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs text-zinc-300"><option value={60}>约 60 秒</option><option value={90}>约 90 秒</option><option value={120}>约 120 秒</option><option value={180}>约 180 秒</option></select></label><label className="text-[10px] text-zinc-500">期望集数（可选）<input type="number" min={1} max={100} value={requestedEpisodeCount} onChange={e => setRequestedEpisodeCount(e.target.value)} placeholder="自动判断" className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs text-zinc-300" /></label></div>}
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3"><div className="flex gap-2"><button onClick={() => fileRef.current?.click()} className="flex items-center gap-2 rounded-xl border border-white/10 px-3 py-2 text-xs text-zinc-300 hover:bg-white/5"><Upload className="h-3.5 w-3.5" />导入 TXT / MD</button>{inputMode==='episode' && <button onClick={() => setScript(SAMPLE_SCRIPT)} className="rounded-xl px-3 py-2 text-xs text-zinc-500 hover:text-zinc-300">填入示例</button>}<input ref={fileRef} type="file" accept=".txt,.md,text/plain,text/markdown" className="hidden" onChange={e => { onFile(e.target.files?.[0]); e.target.value = ''; }} /></div><button onClick={analyze} disabled={analyzing || script.trim().length < (inputMode==='series' && !projectId ? 200 : 20)} className="flex items-center gap-2 rounded-xl bg-cyan-400 px-5 py-2.5 text-sm font-semibold text-zinc-950 transition hover:bg-cyan-300 disabled:opacity-40">{analyzing ? <Loader2 className="h-4 w-4 animate-spin" /> : <WandSparkles className="h-4 w-4" />}{analyzing ? (inputMode==='series'?'正在规划分集…':'正在读剧本…') : (inputMode==='series' && !projectId ? '生成分集方案' : '自动分析剧本')}</button></div>
          </section>
          <aside className="space-y-4"><div className="rounded-3xl border border-white/10 bg-[#101318] p-5"><h2 className="mb-5 text-sm font-semibold">分析后自动得到</h2>{[[Users,'角色与道具资产','固定人物外观，保持跨镜一致'],[ImageIcon,'场景与分镜图','按场次逐镜生成，可逐张确认'],[Video,'视频镜头','继承分镜首帧，逐段生成视频']].map(([Icon,title,desc],i) => <div key={String(title)} className="relative flex gap-3 pb-6 last:pb-0"><div className="relative z-10 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-cyan-400/10 text-cyan-300"><Icon className="h-4 w-4" /></div>{i < 2 && <div className="absolute left-[17px] top-9 h-[calc(100%-36px)] w-px bg-white/10" />}<div><p className="text-sm text-zinc-200">{title as string}</p><p className="mt-1 text-xs leading-5 text-zinc-500">{desc as string}</p></div></div>)}</div><div className="rounded-2xl border border-amber-400/15 bg-amber-400/[0.04] p-4 text-xs leading-5 text-amber-100/60">生成图片和视频会产生实际调用费用。系统只在你点击“生成下一步”或“开始智能托管”后执行。</div>{analysisModels.length > 0 && <select value={analysisModel} onChange={e => setAnalysisModel(e.target.value)} className="w-full rounded-xl border border-white/10 bg-[#101318] px-3 py-2.5 text-xs text-zinc-300 outline-none">{analysisModels.map(m => <option key={m.modelId} value={m.modelId}>{m.displayName}</option>)}</select>}</aside>
        </div>{error && <div className="mt-4 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</div>}
      </div>
    </div>
  );

  return (
    <div className="comic-drama-page min-h-full bg-transparent text-white">
      <header className="sticky top-0 z-20 border-b border-white/10 bg-[#090b0e]/90 px-5 py-4 backdrop-blur-xl md:px-8"><div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4"><div className="flex min-w-0 items-center gap-3"><button onClick={reset} className="rounded-lg p-2 text-zinc-500 hover:bg-white/5 hover:text-white"><RotateCcw className="h-4 w-4" /></button><div className="min-w-0"><h1 className="truncate text-base font-semibold">{projectTitle || blueprint.title} · 第{episodeNumber}集</h1><p className="mt-0.5 text-xs text-zinc-500">{blueprint.genre} · {blueprint.scenes.length} 场 · {shots.length} 镜 · 约 {blueprint.estimatedDuration} 秒</p></div></div><div className="flex items-center gap-2"><button onClick={openExport} className="flex items-center gap-2 rounded-xl border border-white/10 px-4 py-2 text-xs text-zinc-200 hover:bg-white/5"><PackageOpen className="h-3.5 w-3.5" />导出视频</button>{running ? <button onClick={stop} className="flex items-center gap-2 rounded-xl border border-red-400/20 bg-red-400/10 px-4 py-2 text-xs text-red-300"><Square className="h-3.5 w-3.5" />停止{managed ? '托管' : '生成'}</button> : <><button onClick={() => run(false)} className="flex items-center gap-2 rounded-xl border border-white/10 px-4 py-2 text-xs text-zinc-200 hover:bg-white/5"><Play className="h-3.5 w-3.5" />生成下一步</button><button onClick={() => run(true)} className="flex items-center gap-2 rounded-xl bg-cyan-400 px-4 py-2 text-xs font-semibold text-zinc-950 hover:bg-cyan-300"><Bot className="h-4 w-4" />开始智能托管</button></>}</div></div></header>
      {episodeTabs}
      {seriesDashboard}
      <main className="mx-auto grid max-w-7xl gap-5 px-5 py-6 lg:grid-cols-[310px_1fr] md:px-8">
        <aside className="space-y-4">
          <div className="rounded-2xl border border-white/10 bg-[#101318] p-4">
            <div className="flex items-center justify-between gap-3">
              <div><p className="text-sm font-medium">视觉质检 Agent</p><p className="mt-1 text-[10px] text-zinc-600">图片 {passedImages}/{reviewedImages.length} · 视频 {passedVideos}/{reviewedVideos.length}{projectId ? ` · 项目 #${projectId}` : ''}</p></div>
              <Toggle checked={qualityEnabled} onChange={() => { setQualityEnabled(value => !value); setTimeout(() => persist(), 0); }} />
            </div>
            {qualityEnabled && <div className="mt-3 flex items-center justify-between border-t border-white/5 pt-3"><span className="text-xs text-zinc-500">不通过自动重生</span><select value={qualityRetries} onChange={e => { const value = Number(e.target.value); setQualityRetries(value); }} className="min-h-0 rounded-lg border border-white/10 bg-black/30 px-2 py-1 text-xs text-zinc-300"><option value={0}>不重生</option><option value={1}>最多 1 次</option><option value={2}>最多 2 次</option></select></div>}
          </div>
          <div className="rounded-2xl border border-white/10 bg-[#101318] p-4"><div className="mb-3 flex items-center justify-between"><span className="text-sm font-medium">制作进度</span><span className="text-xs text-cyan-300">{totalTasks ? Math.round(totalDone / totalTasks * 100) : 0}%</span></div><div className="h-1.5 overflow-hidden rounded-full bg-white/5"><div style={{width: `${totalTasks ? totalDone / totalTasks * 100 : 0}%`}} className="h-full rounded-full bg-cyan-400 transition-all" /></div><p className="mt-3 text-xs text-zinc-500">已完成 {totalDone} / {totalTasks} 个生成任务</p></div>
          <div className="rounded-2xl border border-white/10 bg-[#101318] p-4"><div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-medium">智能托管范围</h2><span className="text-[10px] text-zinc-600">可随时停止</span></div><div className="mb-2 grid grid-cols-2 rounded-lg bg-black/30 p-1"><button onClick={() => setManagedScope('current')} className={`rounded-md px-2 py-1.5 text-[10px] ${managedScope === 'current' ? 'bg-white/10 text-white' : 'text-zinc-600'}`}>仅第{episodeNumber}集</button><button onClick={() => setManagedScope('all')} className={`rounded-md px-2 py-1.5 text-[10px] ${managedScope === 'all' ? 'bg-white/10 text-white' : 'text-zinc-600'}`}>全部已分析剧集</button></div>{([{key:'assets',title:'资产图',desc:`角色、场景、道具 ${counts.assets.done}/${counts.assets.total}`,icon:Users},{key:'storyboards',title:'分镜图',desc:`逐镜首帧 ${counts.storyboards.done}/${counts.storyboards.total}`,icon:ImageIcon},{key:'videos',title:'视频镜头',desc:`逐段视频 ${counts.videos.done}/${counts.videos.total}`,icon:Video}] as const).map(item => <div key={item.key} className="flex items-center gap-3 border-b border-white/5 py-3 last:border-0"><div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/5"><item.icon className="h-4 w-4 text-zinc-400" /></div><div className="flex-1"><p className="text-xs text-zinc-200">{item.title}</p><p className="mt-0.5 text-[10px] text-zinc-600">{item.desc}</p></div><Toggle checked={selected[item.key]} onChange={() => setSelected(x => ({...x,[item.key]:!x[item.key]}))} /></div>)}</div>
          <div className="space-y-2 rounded-2xl border border-white/10 bg-[#101318] p-4"><label className="text-[10px] uppercase tracking-wider text-zinc-600">图片模型</label><select value={imageModel} onChange={e => setImageModel(e.target.value)} className="w-full rounded-lg border border-white/10 bg-black/30 px-2.5 py-2 text-xs text-zinc-300 outline-none">{imageModels.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select><label className="block pt-2 text-[10px] uppercase tracking-wider text-zinc-600">视频模型</label><select value={videoModel} onChange={e => setVideoModel(e.target.value)} className="w-full rounded-lg border border-white/10 bg-black/30 px-2.5 py-2 text-xs text-zinc-300 outline-none">{videoModels.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></div>
          <div className="rounded-2xl border border-white/10 bg-[#101318] p-4"><p className="text-xs font-medium text-zinc-300">故事梗概</p><p className="mt-2 text-xs leading-5 text-zinc-500">{blueprint.logline}</p><p className="mt-4 text-xs font-medium text-zinc-300">统一视觉</p><p className="mt-2 text-xs leading-5 text-zinc-500">{blueprint.visualStyle}</p></div>
        </aside>
        <div className="space-y-5">
          <section className="rounded-2xl border border-white/10 bg-[#101318] p-5">
            <div className="mb-4 flex items-center justify-between"><div><div className="flex items-center gap-2"><h2 className="text-sm font-semibold">全剧共享资产库</h2><span className="rounded-full bg-cyan-400/10 px-2 py-0.5 text-[9px] text-cyan-300">项目级</span></div><p className="mt-1 text-xs text-zinc-600">定稿、锁定或替换一次，所有剧集同步引用</p></div><span className="text-xs text-zinc-500">{sharedAssets.filter(asset => asset.url).length}/{sharedAssets.length}</span></div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{sharedAssets.map(asset => <button type="button" onClick={() => beginEditAsset(asset)} key={`${asset.kind}:${asset.name}`} className="overflow-hidden rounded-xl border border-white/10 bg-black/20 text-left transition hover:border-cyan-400/30"><div className="relative aspect-[4/3] bg-white/[0.02]">{asset.url ? <img src={asset.url} className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center"><ImageIcon className="h-7 w-7 text-zinc-800" /></div>}<span className="absolute right-2 top-2 rounded-lg bg-black/70 p-1.5 text-zinc-300">{asset.locked ? <Lock className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}</span></div><div className="p-3"><div className="flex items-center justify-between gap-2"><div><span className="mr-2 text-[10px] text-cyan-400">{asset.kind}</span><span className="text-xs text-zinc-200">{asset.name}</span></div><TaskBadge status={asset.status} /></div><p className="mt-1 text-[10px] text-zinc-600">{asset.variant || '基础造型'}{asset.aliases?.length ? ` · 别名 ${asset.aliases.join('、')}` : ''}</p></div></button>)}</div>
            {assetDraft && <div className="mt-4 rounded-xl border border-cyan-400/20 bg-cyan-400/[0.03] p-4"><div className="mb-4 flex items-center justify-between"><div><p className="text-sm font-medium">编辑 {assetDraft.kind} · {assetDraft.name}</p><p className="mt-1 text-[10px] text-zinc-600">修改后应用到整部剧</p></div><button onClick={() => { setAssetDraft(null); setEditingAssetKey(''); }} className="p-1 text-zinc-500"><X className="h-4 w-4" /></button></div><div className="grid gap-3 md:grid-cols-2"><label className="text-[10px] text-zinc-500">造型版本<input value={assetDraft.variant || ''} onChange={e => setAssetDraft({...assetDraft, variant:e.target.value})} className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs text-zinc-200 outline-none" placeholder="基础造型 / 战损 / 夜行服" /></label><label className="text-[10px] text-zinc-500">角色别名<input value={(assetDraft.aliases || []).join('，')} onChange={e => setAssetDraft({...assetDraft, aliases:e.target.value.split(/[，,]/).map(x => x.trim()).filter(Boolean)})} className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs text-zinc-200 outline-none" placeholder="晚晚，女主" /></label></div><label className="mt-3 block text-[10px] text-zinc-500">统一资产提示词<textarea value={assetDraft.prompt} onChange={e => setAssetDraft({...assetDraft,prompt:e.target.value})} className="mt-1 min-h-24 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs leading-5 text-zinc-200 outline-none" /></label><div className="mt-3 flex flex-wrap items-center gap-2"><button onClick={() => setAssetDraft({...assetDraft,locked:!assetDraft.locked})} className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-xs text-zinc-300">{assetDraft.locked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}{assetDraft.locked ? '已锁定形象' : '锁定形象'}</button><button onClick={() => assetUploadRef.current?.click()} className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-xs text-zinc-300"><Upload className="h-3.5 w-3.5" />上传定稿图</button><input ref={assetUploadRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={e => { uploadAssetImage(e.target.files?.[0]); e.target.value=''; }} /><button onClick={saveAssetDraft} className="ml-auto flex items-center gap-1.5 rounded-lg bg-cyan-400 px-4 py-2 text-xs font-semibold text-zinc-950"><Save className="h-3.5 w-3.5" />保存到全剧</button></div></div>}
          </section>
          <section className="rounded-2xl border border-white/10 bg-[#101318] p-5">
            <div className="mb-4"><h2 className="text-sm font-semibold">分镜导演台</h2><p className="mt-1 text-xs text-zinc-600">可编辑、增删和排序镜头；修改会同步到托管任务</p></div>
            <div className="space-y-3">{blueprint.scenes.map(scene => { const sceneShots = shots.filter(x => x.sceneNumber === scene.sceneNumber); const open = expandedScene === scene.sceneNumber; return <div key={scene.sceneNumber} className="overflow-hidden rounded-xl border border-white/10"><div className="flex items-center bg-black/20 pr-3"><button onClick={() => setExpandedScene(open ? null : scene.sceneNumber)} className="flex flex-1 items-center gap-3 px-4 py-3 text-left">{open ? <ChevronDown className="h-4 w-4 text-zinc-500" /> : <ChevronRight className="h-4 w-4 text-zinc-500" />}<span className="rounded-md bg-cyan-400/10 px-2 py-1 text-[10px] text-cyan-300">场 {scene.sceneNumber}</span><div className="flex-1"><p className="text-xs text-zinc-200">{scene.title}</p><p className="mt-0.5 text-[10px] text-zinc-600">{scene.location} · {scene.time} · {sceneShots.length} 镜</p></div></button><button onClick={() => addShot(scene.sceneNumber, scene.title)} className="flex items-center gap-1 rounded-lg border border-white/10 px-2.5 py-1.5 text-[10px] text-zinc-400 hover:text-cyan-300"><Plus className="h-3 w-3" />新增镜头</button></div>{open && <div className="divide-y divide-white/5">{sceneShots.map((task,index) => <div key={task.id} className="grid gap-4 p-4 md:grid-cols-[150px_1fr]"><div className="aspect-[9/16] overflow-hidden rounded-lg bg-black/40">{task.videoUrl ? <video src={task.videoUrl} controls className="h-full w-full object-cover" /> : task.imageUrl ? <img src={task.imageUrl} className="h-full w-full object-cover" /> : <div className="flex h-full flex-col items-center justify-center gap-2 text-zinc-700"><Clapperboard className="h-6 w-6" /><span className="text-[10px]">分镜 {task.shot.shotNumber}</span></div>}</div><div><div className="flex flex-wrap items-center gap-2"><span className="text-xs font-medium text-zinc-200">镜头 {task.shot.shotNumber}</span><span className="text-[10px] text-zinc-500">{task.shot.duration}s · {task.shot.shotSize} · {task.shot.camera}</span>{task.videoQualityScore !== undefined && <span className={`rounded px-1.5 py-0.5 text-[9px] ${task.videoQualityScore >= 75 ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>视频质检 {task.videoQualityScore}</span>}<div className="ml-auto flex items-center gap-1">{task.videoUrl && <a href={`/api/video/download?url=${encodeURIComponent(task.videoUrl)}&filename=${encodeURIComponent(`E${String(episodeNumber).padStart(2,'0')}_S${String(task.sceneNumber).padStart(2,'0')}_C${String(task.shot.shotNumber).padStart(2,'0')}.mp4`)}`} download onClick={e => e.stopPropagation()} className="rounded p-1 text-zinc-500 hover:bg-white/5 hover:text-cyan-300" title="下载视频"><Download className="h-3.5 w-3.5" /></a>}<button disabled={index===0} onClick={() => moveShot(task.id,-1)} className="rounded p-1 text-zinc-500 hover:bg-white/5 disabled:opacity-20"><ArrowUp className="h-3.5 w-3.5" /></button><button disabled={index===sceneShots.length-1} onClick={() => moveShot(task.id,1)} className="rounded p-1 text-zinc-500 hover:bg-white/5 disabled:opacity-20"><ArrowDown className="h-3.5 w-3.5" /></button><button onClick={() => setEditingShot({...task,shot:{...task.shot}})} className="rounded p-1 text-zinc-500 hover:bg-white/5 hover:text-cyan-300"><Pencil className="h-3.5 w-3.5" /></button><button onClick={() => deleteShot(task.id)} className="rounded p-1 text-zinc-500 hover:bg-red-500/10 hover:text-red-400"><Trash2 className="h-3.5 w-3.5" /></button><TaskBadge status={task.status} /></div></div><p className="mt-3 text-xs leading-5 text-zinc-400">{task.shot.action}</p>{task.shot.dialogue && <p className="mt-2 rounded-lg border-l-2 border-cyan-400/40 bg-cyan-400/[0.03] px-3 py-2 text-xs text-cyan-100/70">{task.shot.dialogue}</p>}<div className="mt-3 grid gap-2 xl:grid-cols-2"><div className="rounded-lg bg-white/[0.025] p-3"><p className="mb-1 text-[10px] text-zinc-600">开始状态</p><p className="line-clamp-2 text-[10px] leading-4 text-zinc-500">{task.shot.continuityStart || '未设置'}</p></div><div className="rounded-lg bg-white/[0.025] p-3"><p className="mb-1 text-[10px] text-zinc-600">结束状态</p><p className="line-clamp-2 text-[10px] leading-4 text-zinc-500">{task.shot.continuityEnd || '未设置'}</p></div></div>{task.error && <p className="mt-2 text-[10px] text-red-400">{task.error}</p>}</div></div>)}</div>}</div>; })}</div>
            {editingShot && <div className="mt-4 rounded-xl border border-cyan-400/20 bg-cyan-400/[0.03] p-4"><div className="mb-4 flex items-center justify-between"><p className="text-sm font-medium">编辑镜头 {editingShot.shot.shotNumber}</p><button onClick={() => setEditingShot(null)} className="text-zinc-500"><X className="h-4 w-4" /></button></div><div className="grid gap-3 md:grid-cols-3"><label className="text-[10px] text-zinc-500">时长（秒）<input type="number" min={1} max={30} value={editingShot.shot.duration} onChange={e => setEditingShot({...editingShot,shot:{...editingShot.shot,duration:Number(e.target.value)}})} className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs text-zinc-200" /></label><label className="text-[10px] text-zinc-500">景别<input value={editingShot.shot.shotSize} onChange={e => setEditingShot({...editingShot,shot:{...editingShot.shot,shotSize:e.target.value}})} className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs text-zinc-200" /></label><label className="text-[10px] text-zinc-500">机位/运镜<input value={editingShot.shot.camera} onChange={e => setEditingShot({...editingShot,shot:{...editingShot.shot,camera:e.target.value}})} className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs text-zinc-200" /></label></div>{([['action','动作与表演'],['dialogue','台词'],['imagePrompt','分镜提示词'],['videoPrompt','视频提示词'],['continuityStart','开始状态'],['continuityEnd','结束状态']] as const).map(([key,label]) => <label key={key} className="mt-3 block text-[10px] text-zinc-500">{label}<textarea value={String(editingShot.shot[key] || '')} onChange={e => setEditingShot({...editingShot,shot:{...editingShot.shot,[key]:e.target.value}})} className="mt-1 min-h-16 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs leading-5 text-zinc-200 outline-none" /></label>)}<div className="mt-4 flex justify-end"><button onClick={saveShotDraft} className="flex items-center gap-1.5 rounded-lg bg-cyan-400 px-4 py-2 text-xs font-semibold text-zinc-950"><Save className="h-3.5 w-3.5" />保存镜头</button></div></div>}
          </section>
          {error && <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</div>}
        </div>
      </main>
      {exportOpen && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onMouseDown={e => { if (e.target === e.currentTarget) setExportOpen(false); }}><div className="w-full max-w-lg rounded-2xl border border-white/10 bg-[#11151a] p-5 shadow-2xl"><div className="flex items-start justify-between"><div><h2 className="text-base font-semibold">导出视频素材</h2><p className="mt-1 text-xs text-zinc-500">仅导出 MP4/WebM/MOV 视频，不包含图片、剧本或项目数据</p></div><button onClick={() => setExportOpen(false)} className="rounded p-1 text-zinc-500 hover:bg-white/5"><X className="h-4 w-4" /></button></div><div className="mt-5 grid grid-cols-2 rounded-xl bg-black/30 p-1"><button onClick={() => loadExportSummary('current')} className={`rounded-lg px-3 py-2 text-xs ${exportScope==='current'?'bg-white/10 text-white':'text-zinc-500'}`}>当前第{episodeNumber}集</button><button onClick={() => loadExportSummary('all')} className={`rounded-lg px-3 py-2 text-xs ${exportScope==='all'?'bg-white/10 text-white':'text-zinc-500'}`}>全剧视频</button></div>{exportSummary ? <><div className="mt-4 grid grid-cols-4 gap-2">{[['可导出',exportSummary.completed,'text-emerald-400'],['未生成',exportSummary.missing,'text-zinc-400'],['未通过',exportSummary.unapproved,'text-red-400'],['生成中',exportSummary.running,'text-cyan-300']].map(([label,value,color]) => <div key={String(label)} className="rounded-xl border border-white/5 bg-white/[0.025] p-3 text-center"><p className={`text-lg font-semibold ${color}`}>{value as number}</p><p className="mt-1 text-[10px] text-zinc-600">{label as string}</p></div>)}</div><label className="mt-4 flex cursor-pointer items-center justify-between rounded-xl border border-white/10 px-4 py-3"><div><p className="text-xs text-zinc-300">包含质检未通过视频</p><p className="mt-1 text-[10px] text-zinc-600">默认关闭，建议先重新生成失败镜头</p></div><Toggle checked={includeUnapproved} onChange={() => setIncludeUnapproved(value => !value)} /></label><div className="mt-5 flex items-center justify-between"><p className="text-xs text-zinc-500">将导出 {exportSummary.completed + (includeUnapproved ? exportSummary.unapproved : 0)} 个视频</p><button onClick={exportVideos} disabled={exporting || exportSummary.completed + (includeUnapproved ? exportSummary.unapproved : 0) === 0} className="flex items-center gap-2 rounded-xl bg-cyan-400 px-5 py-2.5 text-xs font-semibold text-zinc-950 disabled:opacity-40">{exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}{exporting ? '正在打包…' : '下载 ZIP'}</button></div></> : <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-cyan-300" /></div>}</div></div>}
    </div>
  );
}

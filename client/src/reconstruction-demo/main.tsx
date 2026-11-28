import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, useMatch, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Clapperboard,
  Download,
  Edit3,
  FileText,
  Film,
  Image as ImageIcon,
  Layers,
  Link2,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Save,
  Sparkles,
  Trash2,
  UploadCloud,
  Users,
  Wand2,
  X,
  Zap,
} from 'lucide-react';
import './style.css';

type AnalysisConfiguration = { selected: { mode: string; channelId?: number; model?: string }; notice?: string };
type Asset = { id: string; status: string; confirmed: boolean; file: string | null; error?: string; input: Record<string, any>; created?: string };
type Role = { id: string; name: string; appearance: string; kind?: 'person' | 'product' };
type Shot = {
  id: string;
  start: number;
  end: number;
  title: string;
  characters: string[];
  scene?: string;
  action?: string;
  speaker?: string;
  audio?: string;
  camera?: string;
  framePrompt: string;
  videoPrompt: string;
  caption: string;
};
type SlotMap = { role: Record<string, Asset>; frame: Record<string, Asset>; video: Record<string, Asset> };
type Project = {
  id: string;
  title: string;
  source: string;
  style: string;
  aspectRatio?: string;
  audioMode?: string;
  hasSource?: boolean;
  plan: { title: string; hook?: string; continuity?: string; scriptText?: string; characters: Role[]; shots: Shot[]; duration: number } | null;
  assets: SlotMap;
  versions: { role: Record<string, Asset[]>; frame: Record<string, Asset[]>; video: Record<string, Asset[]> };
  analysis: Asset | null;
  film: Asset | null;
  cost: number | null;
  taskCount: number;
};
type Style = { id: string; name: string; image: string; description: string };
type GenModel = { id: string; name: string; tag: string; description: string; counts: number[]; defaultCount: number; resolutions?: string[]; allowedSeconds?: number[]; rate?: number; resolutionPrices?: Record<string, number>; real?: boolean };
type CameraMovement = { id: string; name: string; short: string; promptHint: string };
type AspectRatioOption = { id: string; name: string; width: number; height: number; description: string };
type AudioModeOption = { id: string; name: string; description: string };
type ModelCatalog = {
  image: GenModel[];
  video: GenModel[];
  cameraMovements?: CameraMovement[];
  aspectRatios?: AspectRatioOption[];
  audioModes?: AudioModeOption[];
  simulated?: boolean;
  notice?: string;
};
type GenSettings = { model: string; count: number; resolution?: string };

const FAILED = ['failed', 'needs_review', 'result_error'];

type StepSlug = 'script' | 'characters' | 'frames' | 'videos' | 'film' | 'overview';

const root = '/app/video-reconstruction';
const projectUrl = (id: string, step: StepSlug = 'script') => `${root}/project/${id}/${step}`;

const isWorking = (asset?: Asset | null) => asset?.status === 'queued' || asset?.status === 'running';

async function api<T>(endpoint: string, body?: object | FormData, methodOverride?: string): Promise<T> {
  const method = methodOverride || (body === undefined ? 'GET' : 'POST');
  const token = typeof window !== 'undefined' ? window.localStorage?.getItem('token') : null;
  const headers: Record<string, string> = {};
  if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch('/demo' + endpoint, {
    method,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function formatPlainScript(plan: NonNullable<Project['plan']>): string {
  const castLine = plan.characters.map(c => c.name).join('、') || '无固定人物';
  const lines: string[] = [
    `《${plan.title}》`,
    `时长：${plan.duration.toFixed(1)} 秒 ｜ 镜头数：${plan.shots.length} 场 ｜ 人物：${castLine}`,
  ];
  if (plan.hook) lines.push(`故事梗概：${plan.hook}`);
  if (plan.continuity) lines.push(`场景氛围：${plan.continuity}`);
  lines.push('');

  plan.shots.forEach((s, idx) => {
    const scene = s.scene || (plan.continuity ? plan.continuity.split('，')[0] : `场景 ${s.id}`);
    const cast = s.characters.map(cid => plan.characters.find(c => c.id === cid)?.name).filter(Boolean).join('、') || '空镜';
    const action = s.action || `${s.framePrompt}${s.videoPrompt ? ' ' + s.videoPrompt : ''}`;
    const speaker = s.speaker && s.speaker !== '无对白' ? s.speaker : '旁白';
    const audio = s.audio || '环境氛围音与轻缓背景配乐';
    lines.push(`【第 ${idx + 1} 场｜${s.start}s–${s.end}s｜${s.title}｜${scene}】`);
    lines.push(`出镜：${cast}`);
    lines.push(`画面：${action}`);
    lines.push(s.caption ? `${speaker}：“${s.caption}”` : '对白：（无对白）');
    lines.push(`音效：${audio}`);
    if (idx < plan.shots.length - 1) lines.push('');
  });
  return lines.join('\n');
}

function Lightbox({ media, close }: { media: { file: string; video?: boolean; caption?: string }; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return (
    <dialog ref={ref} onCancel={e => { e.preventDefault(); close(); }} onClick={e => { if (e.target === ref.current) close(); }}>
      <button className="lightbox-close" aria-label="关闭预览" onClick={close}><X size={18} /></button>
      {media.video ? (
        <video src={media.file} controls autoPlay playsInline>
          {media.caption && <track src={media.caption} kind="captions" label="字幕" srcLang="zh" default />}
        </video>
      ) : (
        <img src={media.file} alt="素材预览" />
      )}
    </dialog>
  );
}

export function VideoReconstructionApp({ embedded = false }: { embedded?: boolean } = {}) {
  const navigate = useNavigate();
  const matchStep = useMatch(root + '/project/:id/:step');
  const matchBase = useMatch(root + '/project/:id');
  const id = matchStep?.params.id || matchBase?.params.id;
  const rawStep = matchStep?.params.step as StepSlug | undefined;
  const currentStepSlug: StepSlug =
    rawStep === 'script' || rawStep === 'characters' || rawStep === 'frames' || rawStep === 'videos' || rawStep === 'film' || rawStep === 'overview'
      ? rawStep
      : 'script';

  const [analysisConfig, setAnalysisConfig] = useState<AnalysisConfiguration | null>(null);
  const realAnalysis = analysisConfig?.selected.mode === 'real';
  const [project, setProject] = useState<Project | null>(null);
  const [history, setHistory] = useState<{ id: string; name: string }[]>([]);
  const [styles, setStyles] = useState<Style[]>([]);
  const [modelCatalog, setModelCatalog] = useState<ModelCatalog | null>(null);
  const [imageSettings, setImageSettings] = useState<GenSettings>({ model: 'jimeng-image-3', count: 4 });
  const [videoSettings, setVideoSettings] = useState<GenSettings>({ model: 'kling-2-1', count: 1, resolution: '720p' });
  const [imported, setImported] = useState<Project | null>(null);
  const [importTab, setImportTab] = useState<'video' | 'script'>('video');
  const [directScriptTitle, setDirectScriptTitle] = useState('');
  const [directScriptText, setDirectScriptText] = useState('');
  const [directScriptAspect, setDirectScriptAspect] = useState<'9:16' | '16:9' | '1:1'>('9:16');
  const scriptFileInput = useRef<HTMLInputElement>(null);
  const [selectedStyle, setSelectedStyle] = useState('cel-anime');
  const [link, setLink] = useState('https://sample.local/rainy-letter.mp4');
  const [busy, setBusy] = useState('');
  const [autoStage, setAutoStage] = useState<{ step: number; text: string } | null>(null);
  const [slotBusy, setSlotBusy] = useState<Record<string, boolean>>({});
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<{ file: string; video?: boolean; caption?: string } | null>(null);
  const [prompts, setPrompts] = useState<Record<string, string>>({});
  const [shotCameras, setShotCameras] = useState<Record<string, string>>({});
  const [scriptDraft, setScriptDraft] = useState<{
    projectId: string;
    title: string;
    hook: string;
    continuity: string;
    scriptText: string;
    shots: Record<string, { title: string; scene: string; action: string; speaker: string; caption: string; audio: string }>;
  } | null>(null);
  const [scriptViewMode, setScriptViewMode] = useState<'screenplay' | 'table'>('screenplay');
  const [rewriteTheme, setRewriteTheme] = useState('');
  const [scriptCopied, setScriptCopied] = useState(false);
  const [scriptDirty, setScriptDirty] = useState(false);
  const [scriptSavedNotice, setScriptSavedNotice] = useState(false);
  const [activeNavStep, setActiveNavStep] = useState<number>(1);
  const [showAddRole, setShowAddRole] = useState(false);
  const [newRoleName, setNewRoleName] = useState('');
  const [newRoleAppearance, setNewRoleAppearance] = useState('');
  const [newRoleShots, setNewRoleShots] = useState<string[]>([]);
  const [showUploadProduct, setShowUploadProduct] = useState(false);
  const [productName, setProductName] = useState('');
  const [productAppearance, setProductAppearance] = useState('');
  const [productShots, setProductShots] = useState<string[]>([]);
  const [productFile, setProductFile] = useState<File | null>(null);
  const [productPreviewUrl, setProductPreviewUrl] = useState<string>('');
  const productFileInput = useRef<HTMLInputElement>(null);

  const operation = useRef(false);
  const autoRunning = useRef(false);
  const shotCameraProjectRef = useRef<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void api<AnalysisConfiguration>('/analysis-configuration').then(setAnalysisConfig).catch(e => setError(e.message));
    void api<Style[]>('/styles').then(list => {
      setStyles(list);
      if (list[0]) setSelectedStyle(list[0].id);
    }).catch(e => setError(e.message));
    void api<ModelCatalog>('/generation-models').then(cat => {
      setModelCatalog(cat);
      if (cat.image[0]) setImageSettings(prev => (cat.image.some(m => m.id === prev.model) ? prev : { model: cat.image[0].id, count: cat.image[0].defaultCount }));
      if (cat.video[0]) setVideoSettings(prev => (cat.video.some(m => m.id === prev.model) ? prev : { model: cat.video[0].id, count: cat.video[0].defaultCount, resolution: cat.video[0].resolutions?.[0] || '720p' }));
    }).catch(e => setError(e.message));
    void api<{ id: string; name: string }[]>('/projects').then(setHistory).catch(e => setError(e.message));
  }, [id]);

  useEffect(() => {
    if (!id) { setProject(null); return; }
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const state = await api<Project>('/projects/' + id);
        if (live) setProject(state);
      } catch (e) {
        if (live) setError((e as Error).message);
      }
      if (live) timer = setTimeout(poll, 600);
    }
    void poll();
    return () => { live = false; clearTimeout(timer); };
  }, [id]);

  useEffect(() => {
    if (!project?.plan) return;
    setPrompts(prev => {
      const next = { ...prev };
      for (const r of project.plan!.characters) {
        if (next[`role:${r.id}`] === undefined) next[`role:${r.id}`] = r.appearance;
      }
      for (const s of project.plan!.shots) {
        if (next[`frame:${s.id}`] === undefined) next[`frame:${s.id}`] = s.framePrompt;
        if (next[`video:${s.id}`] === undefined) next[`video:${s.id}`] = s.videoPrompt;
      }
      return next;
    });
    if (shotCameraProjectRef.current !== project.id) {
      shotCameraProjectRef.current = project.id;
      const initialCameras: Record<string, string> = {};
      for (const s of project.plan!.shots) {
        const existingCam = project.assets?.video?.[s.id]?.input?.camera;
        initialCameras[s.id] = (existingCam && existingCam !== 'auto') ? existingCam : (s.camera || existingCam || 'auto');
      }
      setShotCameras(initialCameras);
    }
    setScriptDraft(prev => {
      if (prev && prev.projectId === project.id) return prev;
      const shotsMap: Record<string, { title: string; scene: string; action: string; speaker: string; caption: string; audio: string }> = {};
      for (const s of project.plan!.shots) {
        shotsMap[s.id] = {
          title: s.title,
          scene: s.scene || (project.plan!.continuity ? project.plan!.continuity.split('，')[0] : `场景 ${s.id}`),
          action: s.action || `${s.framePrompt}${s.videoPrompt ? ' ' + s.videoPrompt : ''}`,
          speaker: s.speaker || (s.caption ? '旁白' : '无对白'),
          caption: s.caption || '',
          audio: s.audio || '环境氛围音与轻缓背景配乐',
        };
      }
      setScriptDirty(false);
      setScriptSavedNotice(false);
      return {
        projectId: project.id,
        title: project.plan!.title || '',
        hook: project.plan!.hook || '',
        continuity: project.plan!.continuity || '',
        scriptText: project.plan!.scriptText || formatPlainScript(project.plan!),
        shots: shotsMap,
      };
    });
  }, [project?.id, Boolean(project?.plan)]);

  async function run(label: string, action: () => Promise<void>) {
    if (operation.current) return;
    operation.current = true;
    setBusy(label);
    setError('');
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      operation.current = false;
      setBusy('');
    }
  }

  function openImported(state: Project) {
    setImported(state);
    setHistory(old => [{ id: state.id, name: state.title }, ...old.filter(item => item.id !== state.id)]);
  }

  async function generateAndAutoConfirm(
    projectId: string,
    kind: 'role' | 'frame' | 'video' | 'film',
    slot: string,
    promptText: string,
    options: { count?: number; audioMode?: string; force?: boolean; camera?: string } = {},
  ): Promise<Project> {
    const key = `${kind}:${slot}`;
    setSlotBusy(prev => ({ ...prev, [key]: true }));
    setEditingKey(current => (current === key ? null : current));
    try {
      const endpoint = `/projects/${projectId}/${kind}/${slot}`;
      if (kind === 'film') {
        await api(`${endpoint}/generate`, {
          prompt: promptText,
          audioMode: options.audioMode || project?.audioMode || 'original',
          force: Boolean(options.force),
          requestKey: crypto.randomUUID(),
        });
        for (let i = 0; i < 240; i++) {
          await sleep(350);
          const current = await api<Project>(`/projects/${projectId}`);
          setProject(current);
          const asset = current.film;
          if (!asset) continue;
          if (FAILED.includes(asset.status)) throw new Error(asset.error || '成片合成失败');
          if (asset.status === 'completed') return current;
        }
        throw new Error('合成等待超时，请刷新页面查看');
      }

      const settings = kind === 'video' ? videoSettings : imageSettings;
      const count = options.count ?? settings.count;
      const fallbackCamera = project?.assets?.video?.[slot]?.input?.camera ?? project?.plan?.shots?.find(s => s.id === slot)?.camera;
      const cameraId = kind === 'video' ? (options.camera ?? shotCameras[slot] ?? fallbackCamera ?? 'auto') : undefined;
      const camObj = kind === 'video' ? modelCatalog?.cameraMovements?.find(c => c.id === cameraId) : undefined;
      const effectivePrompt =
        kind === 'video' && camObj && camObj.id !== 'auto' && camObj.promptHint && !promptText.includes(camObj.name)
          ? `【${camObj.name}】${promptText}`
          : promptText;
      const body = {
        prompt: effectivePrompt,
        model: settings.model,
        count,
        ...(kind === 'video' ? { resolution: videoSettings.resolution, camera: cameraId } : {}),
      };
      await api(`${endpoint}/quote`, body);
      const reply = await api<Project & { taskIds: string[] }>(`${endpoint}/generate`, { ...body, requestKey: crypto.randomUUID() });
      setProject(reply);
      const ids = reply.taskIds;

      for (let i = 0; i < 160 + ids.length * 80; i++) {
        await sleep(350);
        const current = await api<Project>(`/projects/${projectId}`);
        setProject(current);
        const mine = (current.versions[kind][slot] || []).filter(item => ids.includes(item.id));
        if (mine.length < ids.length || mine.some(item => isWorking(item))) continue;
        const done = mine.filter(item => item.status === 'completed');
        const failed = mine.filter(item => FAILED.includes(item.status));
        if (!done.length) throw new Error(failed[0]?.error || '生成失败，请调整提示词后重试');
        if (failed.length) setError(`${failed.length} 个候选生成失败：${failed[0].error || '未返回原因'}`);
        // Market convention: the first draw is selected automatically; later re-draws wait for the user to pick.
        const hasSelection = (current.versions[kind][slot] || []).some(item => item.confirmed && item.status === 'completed');
        if (!hasSelection) {
          const confirmed = await api<Project>(`${endpoint}/confirm`, { taskId: done[0].id });
          setProject(confirmed);
          return confirmed;
        }
        return current;
      }
      throw new Error('生成等待超时，请刷新页面查看');
    } finally {
      setSlotBusy(prev => ({ ...prev, [key]: false }));
    }
  }

  async function ensureBreakdown(projectId: string, styleId?: string): Promise<Project> {
    let current = await api<Project>(`/projects/${projectId}`);
    if (styleId && current.style !== styleId) {
      current = await api<Project>(`/projects/${projectId}/style`, { style: styleId });
    }
    if (!current.plan) {
      if (!current.analysis || current.analysis.status === 'failed') {
        await api<Project>(`/projects/${projectId}/analysis/main/generate`, {
          requestKey: 'analysis-' + projectId,
          expectedAnalysis: analysisConfig?.selected,
        });
      }
      for (let i = 0; i < 120; i++) {
        await sleep(400);
        current = await api<Project>(`/projects/${projectId}`);
        setProject(current);
        if (current.plan) break;
        if (current.analysis?.status === 'failed') {
          throw new Error(current.analysis.error || '视频拉片拆解失败');
        }
      }
    }
    if (!current.plan) throw new Error('视频拉片超时');
    return current;
  }

  async function runAutoPilot(targetProjectId: string, styleId?: string) {
    if (autoRunning.current) return;
    autoRunning.current = true;
    setError('');
    try {
      setAutoStage({ step: 1, text: '1/5 拆解参考视频分镜与角色…' });
      let current = await ensureBreakdown(targetProjectId, styleId);
      const plan = current.plan!;

      for (let i = 0; i < plan.characters.length; i++) {
        const r = plan.characters[i];
        if (!current.assets.role[r.id]?.confirmed) {
          setAutoStage({ step: 2, text: `2/5 生成角色立绘：${r.name} (${i + 1}/${plan.characters.length})…` });
          const p = prompts[`role:${r.id}`] ?? r.appearance;
          current = await generateAndAutoConfirm(targetProjectId, 'role', r.id, p, { count: 1 });
        }
      }

      for (let i = 0; i < plan.shots.length; i++) {
        const s = plan.shots[i];
        if (!current.assets.frame[s.id]?.confirmed) {
          setAutoStage({ step: 3, text: `3/5 生成分镜首帧：镜头 ${s.id} (${i + 1}/${plan.shots.length})…` });
          const p = prompts[`frame:${s.id}`] ?? s.framePrompt;
          current = await generateAndAutoConfirm(targetProjectId, 'frame', s.id, p, { count: 1 });
        }
      }

      for (let i = 0; i < plan.shots.length; i++) {
        const s = plan.shots[i];
        if (!current.assets.video[s.id]?.confirmed) {
          setAutoStage({ step: 4, text: `4/5 生成分镜视频：镜头 ${s.id} (${i + 1}/${plan.shots.length})…` });
          const p = prompts[`video:${s.id}`] ?? s.videoPrompt;
          const camera = shotCameras[s.id] ?? current.assets?.video?.[s.id]?.input?.camera ?? s.camera ?? 'auto';
          current = await generateAndAutoConfirm(targetProjectId, 'video', s.id, p, { count: 1, camera });
        }
      }

      if (current.film?.status !== 'completed') {
        setAutoStage({ step: 5, text: '5/5 合成最终成片与字幕…' });
        current = await generateAndAutoConfirm(targetProjectId, 'film', 'main', '');
      }

      setAutoStage(null);
    } catch (e) {
      setError((e as Error).message);
      setAutoStage(null);
    } finally {
      autoRunning.current = false;
    }
  }

  async function startFromImport(autoMode: boolean) {
    if (!imported) return;
    const targetId = imported.id;
    navigate(projectUrl(targetId, autoMode ? 'overview' : 'script'));
    if (autoMode) {
      void runAutoPilot(targetId, selectedStyle);
    } else {
      await run('正在拆解视频分镜', async () => {
        await ensureBreakdown(targetId, selectedStyle);
      });
    }
  }

  async function runBatchKind(kind: 'role' | 'frame' | 'video') {
    if (!project?.plan) return;
    await run(
      kind === 'role' ? '正在批量生成角色立绘' : kind === 'frame' ? '正在批量生成分镜首帧' : '正在批量生成分镜视频',
      async () => {
        let current = project;
        if (kind === 'role') {
          for (const r of current.plan!.characters) {
            current = await generateAndAutoConfirm(current.id, 'role', r.id, prompts[`role:${r.id}`] ?? r.appearance);
          }
        } else if (kind === 'frame') {
          for (const s of current.plan!.shots) {
            current = await generateAndAutoConfirm(current.id, 'frame', s.id, prompts[`frame:${s.id}`] ?? s.framePrompt);
          }
        } else {
          for (const s of current.plan!.shots) {
            const camera = shotCameras[s.id] ?? current.assets?.video?.[s.id]?.input?.camera ?? s.camera ?? 'auto';
            current = await generateAndAutoConfirm(current.id, 'video', s.id, prompts[`video:${s.id}`] ?? s.videoPrompt, { camera });
          }
        }
      },
    );
  }

  const plan = project?.plan;
  const rolesReadyCount = plan ? plan.characters.filter(r => project?.assets.role[r.id]?.confirmed).length : 0;
  const framesReadyCount = plan ? plan.shots.filter(s => project?.assets.frame[s.id]?.confirmed).length : 0;
  const videosReadyCount = plan ? plan.shots.filter(s => project?.assets.video[s.id]?.confirmed).length : 0;
  const allVideosReady = Boolean(plan && videosReadyCount === plan.shots.length);
  const filmReady = project?.film?.status === 'completed' && Boolean(project.film.file);
  const anyAssetGenerated = Boolean(
    project && (Object.values(project.assets.role).length || Object.values(project.assets.frame).length),
  );
  const anyFrameOrVideoGenerated = Boolean(
    project && (Object.values(project.assets.frame).length || Object.values(project.assets.video).length),
  );
  const currentRatioObj = (modelCatalog?.aspectRatios || []).find(r => r.id === (project?.aspectRatio || '9:16')) || {
    id: project?.aspectRatio || '9:16',
    name: project?.aspectRatio === '16:9' ? '16:9 横屏' : project?.aspectRatio === '1:1' ? '1:1 方屏' : '9:16 竖屏',
    width: project?.aspectRatio === '16:9' ? 1280 : project?.aspectRatio === '1:1' ? 960 : 720,
    height: project?.aspectRatio === '16:9' ? 720 : project?.aspectRatio === '1:1' ? 960 : 1280,
  };

  const roleNames = (shot: Shot) =>
    shot.characters.map(cid => plan?.characters.find(r => r.id === cid)?.name).filter(Boolean).join('、') || '空镜';

  const isOverview = currentStepSlug === 'overview';
  const showScript = isOverview || currentStepSlug === 'script';
  const showCharacters = isOverview || currentStepSlug === 'characters';
  const showFrames = isOverview || currentStepSlug === 'frames';
  const showVideos = isOverview || currentStepSlug === 'videos';
  const showFilm = isOverview || currentStepSlug === 'film';
  const showStoryboard = showFrames || showVideos;

  function jumpToStep(stepNum: number) {
    setActiveNavStep(stepNum);
    if (stepNum === 1) {
      navigate(root);
      return;
    }
    if (!id) return;
    const slugMap: Record<number, StepSlug> = {
      2: 'script',
      3: 'characters',
      4: 'frames',
      5: 'videos',
      6: 'film',
    };
    navigate(projectUrl(id, slugMap[stepNum] || 'script'));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function handleSaveScript(advanceToCharacters = false) {
    if (!id || !plan || !scriptDraft) return;
    await run('正在保存剧本', async () => {
      const updated = await api<Project>(`/projects/${id}/script`, {
        title: scriptDraft.title,
        hook: scriptDraft.hook,
        continuity: scriptDraft.continuity,
        scriptText: scriptDraft.scriptText,
        shots: plan.shots.map(s => {
          const d = scriptDraft.shots[s.id];
          return {
            id: s.id,
            title: d?.title ?? s.title,
            scene: d?.scene ?? s.scene ?? '',
            action: d?.action ?? s.action ?? '',
            speaker: d?.speaker ?? s.speaker ?? '旁白',
            caption: d?.caption ?? s.caption,
            audio: d?.audio ?? s.audio ?? '',
          };
        }),
      });
      setProject(updated);
      setScriptDirty(false);
      setScriptSavedNotice(true);
      if (advanceToCharacters) jumpToStep(3);
    });
  }

  async function handleRewriteScript(themeOverride?: string) {
    const themeText = (themeOverride ?? rewriteTheme).trim();
    if (!id || !themeText) return;
    setRewriteTheme(themeText);
    await run('正在按新主题改写全片剧本', async () => {
      const updated = await api<Project>(`/projects/${id}/script/rewrite`, { theme: themeText });
      setProject(updated);
      if (updated.plan) {
        const shotsMap: Record<string, { title: string; scene: string; action: string; speaker: string; caption: string; audio: string }> = {};
        const nextPrompts: Record<string, string> = { ...prompts };
        for (const s of updated.plan.shots) {
          shotsMap[s.id] = {
            title: s.title,
            scene: s.scene || '',
            action: s.action || s.framePrompt,
            speaker: s.speaker || '旁白',
            caption: s.caption || '',
            audio: s.audio || '',
          };
          nextPrompts[`frame:${s.id}`] = s.framePrompt;
          nextPrompts[`video:${s.id}`] = s.videoPrompt;
        }
        setPrompts(nextPrompts);
        setScriptDraft({
          projectId: updated.id,
          title: updated.plan.title,
          hook: updated.plan.hook || '',
          continuity: updated.plan.continuity || '',
          scriptText: formatPlainScript(updated.plan),
          shots: shotsMap,
        });
        setScriptDirty(false);
        setScriptSavedNotice(true);
      }
    });
  }

  async function handleAddCharacter(e: React.FormEvent) {
    e.preventDefault();
    if (!id || !newRoleName.trim() || !newRoleAppearance.trim()) return;
    await run('正在添加识别人物', async () => {
      const updated = await api<Project>(`/projects/${id}/characters`, {
        name: newRoleName.trim(),
        appearance: newRoleAppearance.trim(),
        shots: newRoleShots,
      });
      setProject(updated);
      setNewRoleName('');
      setNewRoleAppearance('');
      setNewRoleShots([]);
      setShowAddRole(false);
    });
  }

  async function handleUploadProduct(e: React.FormEvent) {
    e.preventDefault();
    if (!id || !productName.trim() || !productFile) return;
    await run('正在上传并锁定商品主体图', async () => {
      const form = new FormData();
      form.append('file', productFile);
      form.append('name', productName.trim());
      if (productAppearance.trim()) form.append('appearance', productAppearance.trim());
      form.append('shots', JSON.stringify(productShots));
      const updated = await api<Project>(`/projects/${id}/subjects/upload`, form);
      setProject(updated);
      setProductName('');
      setProductAppearance('');
      setProductShots([]);
      setProductFile(null);
      if (productPreviewUrl) URL.revokeObjectURL(productPreviewUrl);
      setProductPreviewUrl('');
      setShowUploadProduct(false);
    });
  }

  async function handleRemoveCharacter(roleId: string) {
    if (!id) return;
    await run('正在移除人物', async () => {
      const updated = await api<Project>(`/projects/${id}/characters/${roleId}`, undefined, 'DELETE');
      setProject(updated);
    });
  }

  async function handleToggleShotCharacter(shot: Shot, roleId: string) {
    if (!id) return;
    const exists = shot.characters.includes(roleId);
    const next = exists ? shot.characters.filter(cid => cid !== roleId) : [...shot.characters, roleId];
    await run('正在更新出镜人物', async () => {
      const updated = await api<Project>(`/projects/${id}/shots/${shot.id}/characters`, { characters: next });
      setProject(updated);
    });
  }

  async function selectCandidate(kind: 'role' | 'frame' | 'video', slot: string, taskId: string) {
    if (!id) return;
    const key = `${kind}:${slot}`;
    setSlotBusy(prev => ({ ...prev, [key]: true }));
    setError('');
    try {
      const updated = await api<Project>(`/projects/${id}/${kind}/${slot}/confirm`, { taskId });
      setProject(updated);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSlotBusy(prev => ({ ...prev, [key]: false }));
    }
  }

  function renderModelBar(mode: 'image' | 'video', rightSlot?: React.ReactNode, embedded = false) {
    const models = modelCatalog?.[mode] || [];
    if (!models.length && !rightSlot) return null;
    const settings = mode === 'video' ? videoSettings : imageSettings;
    const setSettings = mode === 'video' ? setVideoSettings : setImageSettings;
    const activeModel = models.find(m => m.id === settings.model) || models[0];
    const unit = mode === 'video' ? '段' : '张';

    return (
      <div className={`gen-toolbar ${embedded ? 'is-embedded' : ''}`} aria-label={mode === 'video' ? '视频生成模型设置' : '图像生成模型设置'}>
        <div className="gen-toolbar-group">
          {activeModel && (
            <>
              <span className="gen-toolbar-label">{mode === 'video' ? '视频模型' : '生图模型'}</span>
              <select
                aria-label={mode === 'video' ? '选择视频模型' : '选择生图模型'}
                className="gen-model-select"
                value={activeModel.id}
                disabled={Boolean(autoStage)}
                onChange={e => {
                  const nextModel = models.find(m => m.id === e.target.value) || models[0];
                  setSettings(prev => ({
                    model: nextModel.id,
                    count: nextModel.counts.includes(prev.count) ? prev.count : nextModel.defaultCount,
                    ...(mode === 'video' ? { resolution: nextModel.resolutions?.[0] || '720p' } : {}),
                  }));
                }}
              >
                {models.map(m => {
                  const unitRate = mode === 'video' && settings.resolution && m.resolutionPrices?.[settings.resolution] != null
                    ? m.resolutionPrices[settings.resolution]
                    : m.rate;
                  const priceLabel = typeof unitRate === 'number' && unitRate > 0 ? ` · ¥${unitRate.toFixed(2)}/${unit}` : '';
                  return (
                    <option key={m.id} value={m.id}>
                      {m.name}{m.tag ? ` · ${m.tag}` : ''}{priceLabel}
                    </option>
                  );
                })}
              </select>
            </>
          )}

          {mode === 'video' && activeModel?.resolutions && (
            <div className="gen-seg-group">
              <span className="gen-toolbar-divider" aria-hidden="true" />
              <span className="gen-toolbar-label">清晰度</span>
              <div className="gen-seg-control">
                {activeModel.resolutions.map(res => (
                  <button
                    key={res}
                    type="button"
                    className={`gen-seg-btn ${settings.resolution === res ? 'is-active' : ''}`}
                    disabled={Boolean(autoStage)}
                    onClick={() => setSettings(prev => ({ ...prev, resolution: res }))}
                  >
                    {res}
                  </button>
                ))}
              </div>
            </div>
          )}

          {activeModel && (
            <div className="gen-seg-group">
              <span className="gen-toolbar-divider" aria-hidden="true" />
              <span className="gen-toolbar-label">抽卡数</span>
              <div className="gen-seg-control">
                {activeModel.counts.map(n => (
                  <button
                    key={n}
                    type="button"
                    className={`gen-seg-btn ${settings.count === n ? 'is-active' : ''}`}
                    disabled={Boolean(autoStage)}
                    onClick={() => setSettings(prev => ({ ...prev, count: n }))}
                  >
                    {n} {unit}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {rightSlot && <div className="gen-toolbar-right">{rightSlot}</div>}
      </div>
    );
  }

  function renderCandidateStrip(kind: 'role' | 'frame' | 'video', slot: string, locked: boolean) {
    const list = (project?.versions?.[kind]?.[slot] || []).filter(item => item.status !== 'failed');
    if (!list.length) return null;
    const activeIdx = list.findIndex(item => item.confirmed && item.status === 'completed');
    const current = activeIdx >= 0 ? list[activeIdx] : list[list.length - 1];
    const unit = kind === 'video' ? '段' : '张';

    return (
      <div className="candidate-strip" aria-label="候选版本选择">
        <div className="candidate-strip-head">
          <span className="candidate-strip-title">
            {activeIdx >= 0 ? `已采用 V${activeIdx + 1}` : '待选择版本'}
            {current?.input?.model ? ` · ${current.input.model}` : ''}
            {current?.input?.resolution ? ` ${current.input.resolution}` : ''}
            {current?.input?.cameraName && current.input.camera !== 'auto' ? ` · ${current.input.cameraName}` : ''}
          </span>
          <span className="candidate-strip-hint">
            共 {list.length} {unit}候选{locked ? '（已锁定）' : ' · 点击切换采用'}
          </span>
        </div>
        <div className="candidate-thumbs">
          {list.map((ver, idx) => {
            const isAdopted = ver.confirmed && ver.status === 'completed';
            const working = isWorking(ver);
            return (
              <button
                key={ver.id}
                type="button"
                className={`candidate-thumb ${isAdopted ? 'is-adopted' : ''} ${working ? 'is-working' : ''}`}
                disabled={working || Boolean(autoStage) || (locked && !ver.file)}
                onClick={() => {
                  if (locked) {
                    if (ver.file) setPreview({ file: ver.file, video: kind === 'video' });
                    return;
                  }
                  if (!isAdopted && ver.status === 'completed') {
                    void selectCandidate(kind, slot, ver.id);
                  } else if (ver.file) {
                    setPreview({ file: ver.file, video: kind === 'video' });
                  }
                }}
                title={
                  working
                    ? `V${idx + 1} 生成中…`
                    : locked
                      ? `V${idx + 1} · 点击放大预览`
                      : isAdopted
                        ? `当前已采用 V${idx + 1} · 点击放大预览`
                        : `点击选用 V${idx + 1}（${ver.input?.model || ''}）`
                }
              >
                {ver.file ? (
                  kind === 'video' ? (
                    <video src={ver.file} muted playsInline preload="metadata" />
                  ) : (
                    <img src={ver.file} alt={`候选 V${idx + 1}`} />
                  )
                ) : (
                  <span className="candidate-thumb-loading">
                    <Loader2 size={13} className="spin" />
                  </span>
                )}
                <span className="candidate-ver-tag">V{idx + 1}</span>
                {isAdopted && (
                  <span className="candidate-check-dot" aria-label="已采用">
                    <Check size={9} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  const navSteps = [
    {
      num: 1,
      title: '导入原片',
      meta: id ? '已导入' : imported ? '已就绪' : '待上传',
      done: Boolean(id),
      enabled: true,
    },
    {
      num: 2,
      title: '剧本定稿',
      meta: plan ? `${plan.shots.length} 镜脚本` : '待拆解',
      done: Boolean(plan && !scriptDirty),
      enabled: Boolean(id && plan),
    },
    {
      num: 3,
      title: '画风与主体',
      meta: plan ? `${rolesReadyCount}/${plan.characters.length} 项` : '待拆解',
      done: Boolean(plan && plan.characters.length > 0 && rolesReadyCount === plan.characters.length),
      enabled: Boolean(id && plan),
    },
    {
      num: 4,
      title: '分镜首帧',
      meta: plan ? `${framesReadyCount}/${plan.shots.length} 镜` : '待生成',
      done: Boolean(plan && framesReadyCount === plan.shots.length),
      enabled: Boolean(id && plan),
    },
    {
      num: 5,
      title: '分镜视频',
      meta: plan ? `${videosReadyCount}/${plan.shots.length} 段` : '待生成',
      done: Boolean(plan && videosReadyCount === plan.shots.length),
      enabled: Boolean(id && plan),
    },
    {
      num: 6,
      title: '合成成片',
      meta: filmReady ? '已合成' : '待合成',
      done: Boolean(filmReady),
      enabled: Boolean(id && plan),
    },
  ];

  return (
    <div className="studio-shell">
      {/* Minimal Modern Top Navigation */}
      <header className="studio-topbar">
        <div className="topbar-left">
          <Link to={embedded ? '/app' : root} className="brand-link">
            <img src="/brand/lingxu-mascot.png" alt="" />
            <strong>灵序 AI</strong>
          </Link>
          <span className="brand-divider" style={{ margin: '0 6px' }}>/</span>
          <Link to={root} className="brand-feature"><Clapperboard size={15} /> 一键视频复刻</Link>
        </div>

        <div className="topbar-right">
          {embedded && (
            <Link to="/app" className="ghost-btn">
              返回工作台
            </Link>
          )}
          {id && plan && !filmReady && (
            <button
              type="button"
              className="ghost-btn is-accent"
              disabled={Boolean(autoStage) || Boolean(busy)}
              onClick={() => void runAutoPilot(id)}
              title="自动完成当前项目尚未生成的全部步骤"
            >
              <Zap size={13} />
              {rolesReadyCount === 0 && framesReadyCount === 0 ? '一键全自动出片' : '自动完成剩余步骤'}
            </button>
          )}
          {id && plan && allVideosReady && (
            <button
              type="button"
              className="ghost-btn"
              disabled={Boolean(autoStage) || Boolean(slotBusy['film:main'])}
              onClick={() => void generateAndAutoConfirm(id, 'film', 'main', '')}
            >
              {slotBusy['film:main'] || isWorking(project.film) ? <Loader2 size={13} className="spin" /> : <Film size={13} />}
              {filmReady ? '重新合成' : '合成成片'}
            </button>
          )}
          {id && (
            <Link to={root} className="ghost-btn">
              <ArrowLeft size={13} /> 新建
            </Link>
          )}
          <select
            aria-label="复刻记录"
            className="project-switcher"
            value={id || ''}
            onChange={e => navigate(e.target.value ? projectUrl(e.target.value) : root)}
          >
            <option value="">切换复刻项目 ({history.length})</option>
            {history.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </div>
      </header>

      {/* 6-Step Commercial Workflow Navigation */}
      <nav className="workflow-stepper" aria-label="复刻步骤导航">
        <div className="workflow-stepper-inner">
          {navSteps.map((step, idx) => {
            const slugByStep: Record<number, StepSlug> = { 2: 'script', 3: 'characters', 4: 'frames', 5: 'videos', 6: 'film' };
            const isCurrent = !id ? step.num === 1 : !isOverview && currentStepSlug === slugByStep[step.num];
            return (
              <React.Fragment key={step.num}>
                <button
                  type="button"
                  className={`stepper-item ${step.done ? 'is-done' : ''} ${isCurrent ? 'is-active' : ''}`}
                  disabled={!step.enabled}
                  onClick={() => jumpToStep(step.num)}
                >
                  <span className="stepper-badge">
                    {step.done ? <Check size={11} /> : `0${step.num}`}
                  </span>
                  <span className="stepper-label">{step.title}</span>
                  <span className="stepper-meta">{step.meta}</span>
                </button>
                {idx < navSteps.length - 1 && (
                  <span className={`stepper-connector ${step.done ? 'is-done' : ''}`} aria-hidden="true" />
                )}
              </React.Fragment>
            );
          })}
          {id && plan && (
            <button
              type="button"
              className={`stepper-overview-btn ${isOverview ? 'is-active' : ''}`}
              onClick={() => navigate(projectUrl(id, isOverview ? 'characters' : 'overview'))}
              title="切换分步独立视图与单页全览工作台"
            >
              <Layers size={12} />
              {isOverview ? '单页全览中' : '单页全览'}
            </button>
          )}
        </div>
      </nav>

      <main className="studio-main">
        {/* Global notifications */}
        {error && <div className="toast-banner is-error" role="alert"><span>{error}</span><button onClick={() => setError('')}><X size={14} /></button></div>}
        {autoStage && (
          <div className="autopilot-floating" role="status">
            <div className="autopilot-floating-info">
              <Loader2 size={16} className="spin" />
              <strong>{autoStage.text}</strong>
              <span className="autopilot-pct">{Math.round((autoStage.step / 5) * 100)}%</span>
            </div>
            <div className="autopilot-track">
              <span style={{ width: `${(autoStage.step / 5) * 100}%` }} />
            </div>
          </div>
        )}
        {!autoStage && busy && (
          <div className="toast-banner" role="status"><Loader2 size={15} className="spin" /> <span>{busy}…</span></div>
        )}

        {/* ================================================================ */}
        {/* STEP 1: Focused Commercial Import Stage                          */}
        {/* ================================================================ */}
        {!id && (
          <section className="import-stage">
            <div className="import-hero">
              <h1>导入参考视频</h1>
              <p>上传 15–30 秒参考原片，拆解剧本与分镜后按目标画风复刻同款成片。</p>
            </div>

            <fieldset disabled={Boolean(busy) || Boolean(autoStage)} className="import-single-card">
              <div className="bento-head">
                <strong>导入参考原片</strong>
                <span>支持 MP4 / MOV / WebM，建议 15–30 秒短视频</span>
              </div>

              <div className="import-mode-tabs" role="tablist" aria-label="导入方式">
                <button
                  type="button"
                  role="tab"
                  aria-selected={importTab === 'video'}
                  className={`import-mode-tab ${importTab === 'video' ? 'is-active' : ''}`}
                  onClick={() => setImportTab('video')}
                >
                  上传 / 导入参考视频
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={importTab === 'script'}
                  className={`import-mode-tab ${importTab === 'script' ? 'is-active' : ''}`}
                  onClick={() => setImportTab('script')}
                >
                  无原片 · 直接导入纯文本剧本
                </button>
              </div>

              {importTab === 'script' ? (
                <div className="direct-script-box">
                  <div className="direct-script-top">
                    <input
                      aria-label="剧本标题"
                      className="direct-script-title"
                      value={directScriptTitle}
                      onChange={e => setDirectScriptTitle(e.target.value)}
                      placeholder="剧本标题（选填，不填自动从首行提取）"
                    />
                    <div className="direct-script-actions-mini">
                      <select
                        aria-label="生成视频模型"
                        className="direct-script-aspect"
                        value={videoSettings.model}
                        onChange={e => setVideoSettings(prev => ({ ...prev, model: e.target.value }))}
                      >
                        {(modelCatalog?.video || []).map(m => {
                          const rangeText = m.allowedSeconds?.length
                            ? `${Math.min(...m.allowedSeconds)}-${Math.max(...m.allowedSeconds)}s`
                            : '5-10s';
                          return (
                            <option key={m.id} value={m.id}>
                              {m.name}（单镜 {rangeText}）
                            </option>
                          );
                        })}
                      </select>
                      <select
                        aria-label="画幅比例"
                        className="direct-script-aspect"
                        value={directScriptAspect}
                        onChange={e => setDirectScriptAspect(e.target.value as '9:16' | '16:9' | '1:1')}
                      >
                        <option value="9:16">9:16 竖屏</option>
                        <option value="16:9">16:9 横屏</option>
                        <option value="1:1">1:1 方图</option>
                      </select>
                      <button type="button" className="btn-secondary" onClick={() => scriptFileInput.current?.click()}>
                        读取 .txt/.md 剧本
                      </button>
                      <button
                        type="button"
                        className="btn-accent-soft"
                        onClick={() => {
                          setDirectScriptTitle('清晨咖啡店偶遇');
                          setDirectScriptText(
                            '【第 1 场｜0s–5s｜推门入店｜日间 · 街角咖啡馆 · 晨光】\n' +
                            '出镜：林夏\n' +
                            '画面：清晨阳光斜照进玻璃窗，林夏推开木门走进咖啡馆，眼神四处张望。\n' +
                            '林夏：“请问刚才是你落下的笔记本吗？”\n' +
                            '音效：风铃清脆响声、轻快木吉他背景音乐\n\n' +
                            '【第 2 场｜5s–10s｜递还笔记｜日间 · 靠窗木桌 · 暖光】\n' +
                            '出镜：林夏、顾沉\n' +
                            '画面：顾沉抬头露出惊讶微笑，起身接过牛皮笔记本，两人隔着木桌相视。\n' +
                            '顾沉：“太感谢了，这本子我找了一早上。”\n' +
                            '音效：咖啡机蒸汽声、纸张轻触声'
                          );
                        }}
                      >
                        填入示例剧本
                      </button>
                    </div>
                  </div>
                  <textarea
                    aria-label="纯文本剧本内容"
                    className="direct-script-textarea"
                    rows={8}
                    value={directScriptText}
                    onChange={e => setDirectScriptText(e.target.value)}
                    placeholder={'直接粘贴剧本或小说片段（按空行自动拆场，也支持「第1场」「出镜：」「画面：」「角色：台词」「音效：」格式）…'}
                  />
                  <input
                    ref={scriptFileInput}
                    hidden
                    type="file"
                    accept=".txt,.md,text/plain,text/markdown"
                    onChange={async e => {
                      const f = e.target.files?.[0];
                      if (f) {
                        const text = await f.text();
                        setDirectScriptText(text);
                        if (!directScriptTitle) setDirectScriptTitle(f.name.replace(/\.(txt|md)$/i, ''));
                      }
                      e.target.value = '';
                    }}
                  />
                  <div className="import-action-bar">
                    <button
                      type="button"
                      className="btn-primary-action is-lg"
                      disabled={!directScriptText.trim()}
                      onClick={() => void run('正在解析剧本并生成分镜', async () => {
                        const created = await api<Project>('/projects/from-script', {
                          title: directScriptTitle,
                          scriptText: directScriptText,
                          aspectRatio: directScriptAspect,
                          videoModel: videoSettings.model,
                        });
                        setHistory(prev => [{ id: created.id, name: created.title }, ...prev.filter(h => h.id !== created.id)]);
                        navigate(projectUrl(created.id, 'script'));
                      })}
                    >
                      <Wand2 size={15} />
                      <span>跳过原片，直接生成分镜剧本</span>
                      <ArrowRight size={15} />
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {imported ? (
                    <div className="video-stage-preview">
                      <div className="video-player-frame">
                        <video src={imported.source} controls playsInline preload="metadata" />
                      </div>
                      <div className="video-stage-bar">
                        <span><Check size={14} /> 已就绪：{imported.title}</span>
                        <button type="button" className="link-btn" onClick={() => setImported(null)}>更换视频</button>
                      </div>
                    </div>
                  ) : (
                    <div
                      className="dropzone-area"
                      onDragOver={e => e.preventDefault()}
                      onDrop={e => {
                        e.preventDefault();
                        const f = e.dataTransfer.files[0];
                        if (f) void run('正在导入视频', async () => {
                          const form = new FormData();
                          form.append('file', f);
                          openImported(await api<Project>('/projects/upload', form));
                        });
                      }}
                    >
                      <div className="dropzone-icon"><UploadCloud size={24} /></div>
                      <h3>拖拽参考视频到这里，或点击上传</h3>
                      <p>支持 MP4 / MOV / WebM，最大 150 MB</p>
                      <div className="dropzone-btns">
                        <button type="button" className="btn-secondary" onClick={() => fileInput.current?.click()}>
                          选择本地视频
                        </button>
                        <button
                          type="button"
                          className="btn-accent-soft"
                          onClick={() => void run('正在载入双人示例视频', async () => openImported(await api<Project>('/projects/sample', { preset: 'duo' })))}
                        >
                          <Play size={13} /> 试用 15 秒双人示例视频
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="url-import-bar">
                    <Link2 size={15} />
                    <input aria-label="视频链接" value={link} onChange={e => setLink(e.target.value)} placeholder="或粘贴视频直链…" />
                    <button
                      type="button"
                      onClick={() => void run('正在导入链接', async () => openImported(await api<Project>('/projects/import', { url: link })))}
                    >
                      导入链接
                    </button>
                  </div>

                  <input
                    ref={fileInput}
                    hidden
                    type="file"
                    accept="video/*"
                    onChange={e => {
                      const f = e.target.files?.[0];
                      if (f) void run('正在导入视频', async () => {
                        const form = new FormData();
                        form.append('file', f);
                        openImported(await api<Project>('/projects/upload', form));
                      });
                      e.target.value = '';
                    }}
                  />

                  <div className="import-action-bar">
                    <button
                      type="button"
                      className="btn-primary-action is-lg"
                      disabled={!imported || !analysisConfig}
                      onClick={() => void startFromImport(false)}
                    >
                      <Wand2 size={15} />
                      <span>下一步：拆解剧本与分镜</span>
                      <ArrowRight size={15} />
                    </button>

                    <button
                      type="button"
                      className="btn-secondary is-lg"
                      disabled={!imported || !analysisConfig}
                      onClick={() => void startFromImport(true)}
                    >
                      <Zap size={14} />
                      <span>一键全自动生成同款成片（原片画风）</span>
                    </button>
                  </div>
                </>
              )}
            </fieldset>
          </section>
        )}

        {/* ================================================================ */}
        {/* STEP 2: Gallery-Grade Single-Page Storyboard Workbench           */}
        {/* ================================================================ */}
        {id && !plan && (
          <section className="bento-card loading-state-card">
            <Loader2 size={28} className="spin" />
            <div>
              <h2>{project?.analysis?.error || 'AI 正在拆解参考视频分镜与角色…'}</h2>
              <p>正在提取原片关键帧、分析人物特征与镜头脚本，完成后将自动打开故事板</p>
            </div>
          </section>
        )}

        {id && plan && (
          <div className="storyboard-page">
            {/* Project Context Strip (Only shown in Overview mode to avoid double headers in per-step views) */}
            {isOverview && (
              <section id="section-project-bar" className="project-bar">
                <div className="project-bar-left">
                  <h1>{plan.title}</h1>
                  <span className="project-meta-inline">
                    {plan.characters.length} 位人物 · {plan.shots.length} 镜 · {plan.duration.toFixed(1)} 秒 · {styles.find(s => s.id === project.style)?.name || project.style}
                  </span>
                </div>
              </section>
            )}

            {/* STEP 6: Completed Film Showcase or Pre-Synthesis Panel */}
            {showFilm && (
              filmReady && project.film?.file ? (
                <section id="section-film" className="film-showcase" aria-label="成片预览">
                  <div className="film-showcase-player">
                    <video src={project.film.file} controls playsInline>
                      <track src={project.film.file + '?captions=1'} label="字幕" srcLang="zh" kind="captions" default />
                    </video>
                  </div>
                  <div className="film-showcase-body">
                    <div className="showcase-badge"><Check size={13} /> 复刻成片已就绪</div>
                    <h2>{plan.title} · 完整复刻成片</h2>
                    <p>
                      已将 {plan.shots.length} 段分镜视频与台词字幕合成为 {plan.duration.toFixed(1)} 秒成片（{currentRatioObj.name} · {currentRatioObj.width} × {currentRatioObj.height} MP4 · {project.film.input?.audioMode === 'mute' ? '静音字幕版' : '保留原片音轨'}）。
                      若想调整某一段画面或切换音轨模式，可在下方切换后点「重新合成」。
                    </p>
                    {modelCatalog?.audioModes && (
                      <div className="gen-seg-group" style={{ marginTop: '10px' }}>
                        <span className="gen-toolbar-label">成片音轨</span>
                        <div className="gen-seg-control">
                          {modelCatalog.audioModes.map(am => {
                            const active = (project.audioMode || 'original') === am.id;
                            return (
                              <button
                                key={am.id}
                                type="button"
                                className={`gen-seg-btn ${active ? 'is-active' : ''}`}
                                disabled={Boolean(autoStage) || Boolean(slotBusy['film:main'])}
                                onClick={() => void run('正在切换音轨模式并重新合成', async () => {
                                  await api<Project>(`/projects/${id}/audio-mode`, { audioMode: am.id });
                                  await generateAndAutoConfirm(id, 'film', 'main', '', { audioMode: am.id, force: true });
                                })}
                                title={am.description}
                              >
                                {am.name}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    <div className="showcase-actions">
                      <a className="btn-download-hero" href={project.film.file + '?download=1'}>
                        <Download size={16} /> 下载成片 MP4
                      </a>
                      <button
                        type="button"
                        className="btn-glass"
                        onClick={() => setPreview({ file: project.film!.file!, video: true, caption: project.film!.file! + '?captions=1' })}
                      >
                        <Play size={14} /> 全屏预览
                      </button>
                    </div>
                  </div>
                </section>
              ) : !isOverview ? (
                <section id="section-film" className="film-pending-card">
                  <div className="section-bar">
                    <div className="section-bar-title">
                      <div>
                        <h2>合成最终成片（{currentRatioObj.name} · {currentRatioObj.width} × {currentRatioObj.height}）</h2>
                        <p>当前分镜视频已完成 {videosReadyCount}/{plan.shots.length} 段；全部就绪后即可一键拼接为带字幕 MP4 成片</p>
                      </div>
                    </div>
                    <div className="section-bar-btns">
                      {modelCatalog?.audioModes && (
                        <div className="gen-seg-group">
                          <span className="gen-toolbar-label">音轨</span>
                          <div className="gen-seg-control">
                            {modelCatalog.audioModes.map(am => {
                              const active = (project.audioMode || 'original') === am.id;
                              return (
                                <button
                                  key={am.id}
                                  type="button"
                                  className={`gen-seg-btn ${active ? 'is-active' : ''}`}
                                  disabled={Boolean(autoStage) || Boolean(busy)}
                                  onClick={() => void run('正在切换音轨模式', async () => {
                                    setProject(await api<Project>(`/projects/${id}/audio-mode`, { audioMode: am.id }));
                                  })}
                                  title={am.description}
                                >
                                  {am.name}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}
                      {!allVideosReady && (
                        <button type="button" className="btn-secondary" onClick={() => jumpToStep(5)}>
                          <ArrowLeft size={14} /> 返回生成分镜视频
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn-primary-action"
                        disabled={!allVideosReady || Boolean(autoStage) || Boolean(slotBusy['film:main'])}
                        onClick={() => void generateAndAutoConfirm(id, 'film', 'main', '', { audioMode: project.audioMode || 'original', force: true })}
                      >
                        {slotBusy['film:main'] || isWorking(project.film) ? <Loader2 size={14} className="spin" /> : <Film size={14} />}
                        合成最终成片
                      </button>
                    </div>
                  </div>
                </section>
              ) : null
            )}

            {/* STEP 2: Plain-Text Screenplay & Script Finalization (Apple HIG Single Unified Surface) */}
            {showScript && scriptDraft && (
            <section id="section-script" className="studio-section">
              {isOverview && (
                <div className="section-bar">
                  <div className="section-bar-title">
                    <h2>分场剧本</h2>
                  </div>
                </div>
              )}

              {/* AI One-Click Script Rewrite Bar */}
              <div className="script-rewrite-bar">
                <span className="script-rewrite-label"><Sparkles size={13} /> 二创改写</span>
                <input
                  aria-label="二创改写主题"
                  className="script-rewrite-input"
                  value={rewriteTheme}
                  onChange={e => setRewriteTheme(e.target.value)}
                  placeholder="保留原片分镜节奏与时长，输入新主题重写全片剧本…"
                  onKeyDown={e => { if (e.key === 'Enter' && rewriteTheme.trim()) void handleRewriteScript(); }}
                />
                <div className="script-rewrite-presets">
                  {['精品手冲咖啡广告', '都市悬疑反转短剧', '治愈情感独白'].map(preset => (
                    <button
                      key={preset}
                      type="button"
                      className="tbl-camera-chip"
                      disabled={Boolean(busy) || Boolean(autoStage)}
                      onClick={() => void handleRewriteScript(preset)}
                    >
                      {preset}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={!rewriteTheme.trim() || Boolean(busy) || Boolean(autoStage)}
                  onClick={() => void handleRewriteScript()}
                >
                  <Wand2 size={13} /> 改写剧本
                </button>
              </div>

              {/* Unified Document Card (Toolbar + Plain Text or Table) */}
              <div className="plain-script-doc">
                <div className="plain-script-toolbar">
                  <div className="plain-script-toolbar-left">
                    <div className="gen-seg-control" aria-label="剧本视图切换">
                      <button
                        type="button"
                        className={`gen-seg-btn ${scriptViewMode === 'screenplay' ? 'is-active' : ''}`}
                        onClick={() => setScriptViewMode('screenplay')}
                      >
                        纯文本剧本
                      </button>
                      <button
                        type="button"
                        className={`gen-seg-btn ${scriptViewMode === 'table' ? 'is-active' : ''}`}
                        onClick={() => setScriptViewMode('table')}
                      >
                        分镜脚本表
                      </button>
                    </div>
                    <span className="plain-script-meta">
                      共 {plan.shots.length} 场 · {plan.duration.toFixed(1)} 秒 · {scriptDraft.scriptText.length} 字
                    </span>
                    {scriptDirty && <span className="script-status-tag is-dirty">未保存</span>}
                    {!scriptDirty && scriptSavedNotice && <span className="script-status-tag is-saved"><Check size={11} /> 已保存</span>}
                  </div>
                  <div className="plain-script-actions">
                    {scriptViewMode === 'screenplay' && (
                      <button
                        type="button"
                        className="btn-mini"
                        onClick={() => {
                          void navigator.clipboard?.writeText(scriptDraft.scriptText).then(() => {
                            setScriptCopied(true);
                            setTimeout(() => setScriptCopied(false), 1800);
                          });
                        }}
                      >
                        {scriptCopied ? <Check size={12} /> : <FileText size={12} />}
                        {scriptCopied ? '已复制' : '复制全文'}
                      </button>
                    )}
                    <button
                      type="button"
                      className={scriptDirty ? 'btn-mini is-primary' : 'btn-mini'}
                      disabled={!scriptDirty || Boolean(busy) || Boolean(autoStage)}
                      onClick={() => void handleSaveScript(false)}
                    >
                      <Save size={12} /> 保存剧本
                    </button>
                  </div>
                </div>

                {scriptViewMode === 'screenplay' ? (
                  <textarea
                    aria-label="纯文本剧本正文"
                    className="plain-script-editor"
                    rows={18}
                    spellCheck={false}
                    value={scriptDraft.scriptText}
                    onChange={e => {
                      const val = e.target.value;
                      setScriptDraft(prev => prev ? { ...prev, scriptText: val } : prev);
                      setScriptDirty(true);
                      setScriptSavedNotice(false);
                    }}
                  />
                ) : (
                  <div className="sb-table-inner-scroll">
                    <table className="sb-table">
                      <thead>
                        <tr>
                          <th style={{ width: '112px' }}>场次 / 时长</th>
                          <th style={{ width: '124px' }}>原片参考</th>
                          <th style={{ width: '34%' }}>场景与画面剧情动作</th>
                          <th style={{ width: '28%' }}>说话人 / 台词旁白</th>
                          <th>音效 / BGM 氛围</th>
                        </tr>
                      </thead>
                      <tbody>
                        {plan.shots.map((shot, idx) => {
                          const origUrl = `/demo/projects/${project.id}/original/${shot.id}`;
                          const draftShot = scriptDraft.shots[shot.id] || {
                            title: shot.title,
                            scene: shot.scene || '',
                            action: shot.action || shot.framePrompt,
                            speaker: shot.speaker || '旁白',
                            caption: shot.caption || '',
                            audio: shot.audio || '',
                          };
                          const speakerOptions = ['旁白', ...plan.characters.map(c => c.name), '无对白'];
                          const updateShotDraft = (patch: Partial<typeof draftShot>) => {
                            setScriptDraft(prev => prev ? {
                              ...prev,
                              shots: { ...prev.shots, [shot.id]: { ...draftShot, ...patch } },
                            } : prev);
                            setScriptDirty(true);
                            setScriptSavedNotice(false);
                          };
                          return (
                            <tr key={shot.id}>
                              <td>
                                <div className="tbl-shot-meta">
                                  <span className="sb-shot-num">第 {idx + 1} 场</span>
                                  <strong>{draftShot.title}</strong>
                                  <span className="tbl-shot-time">{shot.start}s – {shot.end}s（{shot.end - shot.start}秒）</span>
                                </div>
                              </td>
                              <td>
                                {project.hasSource !== false ? (
                                  <button type="button" className="tbl-media-box is-sm" onClick={() => setPreview({ file: origUrl })}>
                                    <img src={origUrl} alt={`镜头 ${shot.id} 原片参考`} />
                                    <span className="viewport-tag">{shot.start}s</span>
                                  </button>
                                ) : (
                                  <div className="tbl-no-source">纯剧本模式</div>
                                )}
                              </td>
                              <td>
                                <div className="tbl-video-motion-cell">
                                  <input
                                    aria-label={`镜头 ${shot.id} 场景`}
                                    className="script-table-input"
                                    value={draftShot.scene}
                                    onChange={e => updateShotDraft({ scene: e.target.value })}
                                  />
                                  <textarea
                                    aria-label={`镜头 ${shot.id} 画面与剧情动作`}
                                    className="script-table-textarea"
                                    rows={2}
                                    value={draftShot.action}
                                    onChange={e => updateShotDraft({ action: e.target.value })}
                                  />
                                </div>
                              </td>
                              <td>
                                <div className="tbl-video-motion-cell">
                                  <select
                                    aria-label={`镜头 ${shot.id} 说话人`}
                                    className="tbl-camera-select"
                                    value={speakerOptions.includes(draftShot.speaker) ? draftShot.speaker : '旁白'}
                                    onChange={e => updateShotDraft({ speaker: e.target.value })}
                                  >
                                    {speakerOptions.map(sp => <option key={sp} value={sp}>说话人：{sp}</option>)}
                                  </select>
                                  <textarea
                                    aria-label={`镜头 ${shot.id} 台词`}
                                    className="script-table-textarea"
                                    rows={2}
                                    placeholder="无台词则留空…"
                                    value={draftShot.caption}
                                    onChange={e => updateShotDraft({ caption: e.target.value })}
                                  />
                                </div>
                              </td>
                              <td>
                                <textarea
                                  aria-label={`镜头 ${shot.id} 音效氛围`}
                                  className="script-table-textarea"
                                  rows={3}
                                  value={draftShot.audio}
                                  onChange={e => updateShotDraft({ audio: e.target.value })}
                                />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {!isOverview && (
                <div className="step-footer-bar">
                  <button type="button" className="btn-secondary" onClick={() => jumpToStep(1)}>
                    <ArrowLeft size={14} /> 返回导入原片
                  </button>
                  <button
                    type="button"
                    className="btn-primary-action"
                    disabled={Boolean(busy) || Boolean(autoStage)}
                    onClick={() => (scriptDirty ? void handleSaveScript(true) : jumpToStep(3))}
                  >
                    <span>{scriptDirty ? '保存剧本并进入下一步：画风与人物' : `下一步：画风与人物 (${rolesReadyCount}/${plan.characters.length})`}</span>
                    <ArrowRight size={14} />
                  </button>
                </div>
              )}
            </section>
            )}

            {/* STEP 3: Unified Style + Model + Multi-Character Recognition (Apple HIG) */}
            {showCharacters && (
            <section id="section-characters" className="studio-section">
              {isOverview && (
                <div className="section-bar">
                  <div className="section-bar-title">
                    <h2>画风与多人物立绘</h2>
                  </div>
                </div>
              )}

              <div className="cast-controls-card">
                <div className="compact-style-bar is-embedded" aria-label="目标画风选择">
                  <span className="compact-style-label">目标画风</span>
                  <div className="compact-style-list">
                    {styles.map(s => {
                      const active = project.style === s.id;
                      return (
                        <button
                          key={s.id}
                          type="button"
                          aria-pressed={active}
                          disabled={Boolean(anyAssetGenerated) || Boolean(autoStage) || Boolean(busy)}
                          className={`compact-style-chip ${active ? 'is-selected' : ''}`}
                          onClick={() => void run('正在切换画风', async () => {
                            setProject(await api<Project>(`/projects/${id}/style`, { style: s.id }));
                          })}
                          title={anyAssetGenerated ? '已生成素材，画风已锁定' : s.description}
                        >
                          <img src={`/demo/fixtures/${s.image}.webp`} alt="" />
                          <span>{s.name}</span>
                          {active && <Check size={11} className="compact-style-check" />}
                        </button>
                      );
                    })}
                  </div>
                  {anyAssetGenerated && <span className="compact-style-lock">已锁定</span>}
                  {modelCatalog?.aspectRatios && (
                    <div className="gen-seg-group" style={{ marginLeft: 'auto' }}>
                      <span className="gen-toolbar-label">画幅</span>
                      <div className="gen-seg-control">
                        {modelCatalog.aspectRatios.map(ar => {
                          const active = (project.aspectRatio || '9:16') === ar.id;
                          return (
                            <button
                              key={ar.id}
                              type="button"
                              className={`gen-seg-btn ${active ? 'is-active' : ''}`}
                              disabled={Boolean(anyFrameOrVideoGenerated) || Boolean(autoStage) || Boolean(busy)}
                              onClick={() => void run('正在切换画幅比例', async () => {
                                setProject(await api<Project>(`/projects/${id}/aspect-ratio`, { aspectRatio: ar.id }));
                              })}
                              title={anyFrameOrVideoGenerated ? '已生成分镜，画幅已锁定' : ar.description}
                            >
                              {ar.name}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>

                {renderModelBar(
                  'image',
                  <>
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={Boolean(autoStage) || Boolean(busy)}
                      onClick={() => { setShowUploadProduct(v => !v); setShowAddRole(false); }}
                    >
                      <UploadCloud size={13} /> 上传商品图
                    </button>
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={Boolean(autoStage) || Boolean(busy)}
                      onClick={() => { setShowAddRole(v => !v); setShowUploadProduct(false); }}
                    >
                      <Plus size={13} /> 补充人物
                    </button>
                    <button
                      type="button"
                      className={rolesReadyCount === plan.characters.length ? 'btn-secondary' : 'btn-primary-action'}
                      disabled={Boolean(autoStage) || Boolean(busy) || plan.characters.length === 0}
                      onClick={() => void runBatchKind('role')}
                    >
                      <Sparkles size={13} />
                      {rolesReadyCount === plan.characters.length ? '重新生成全部主体' : '一键生成全部主体'}
                    </button>
                  </>,
                  true,
                )}
              </div>

              {showUploadProduct && (
                <form className="add-role-panel" onSubmit={e => void handleUploadProduct(e)}>
                  <div className="upload-product-row">
                    <button
                      type="button"
                      className="upload-product-thumb"
                      onClick={() => productFileInput.current?.click()}
                    >
                      {productPreviewUrl ? (
                        <img src={productPreviewUrl} alt="商品预览" />
                      ) : (
                        <>
                          <UploadCloud size={18} />
                          <span>选择商品图</span>
                        </>
                      )}
                    </button>
                    <input
                      ref={productFileInput}
                      hidden
                      type="file"
                      accept="image/*"
                      onChange={e => {
                        const f = e.target.files?.[0];
                        if (!f) return;
                        if (productPreviewUrl) URL.revokeObjectURL(productPreviewUrl);
                        setProductFile(f);
                        setProductPreviewUrl(URL.createObjectURL(f));
                        if (!productName) setProductName(f.name.replace(/\.[^.]+$/, '').slice(0, 30));
                        e.target.value = '';
                      }}
                    />
                    <div className="upload-product-fields">
                      <div className="add-role-fields">
                        <label className="add-role-field">
                          <span>商品 / 主体名称</span>
                          <input
                            required
                            placeholder="如：冰滴手冲咖啡礼盒 / 哑光口红 #08"
                            value={productName}
                            onChange={e => setProductName(e.target.value)}
                          />
                        </label>
                        <label className="add-role-field is-wide">
                          <span>外观卖点描述（选填，用于提示词一致性）</span>
                          <input
                            placeholder="如：磨砂黑瓶身配烫金字体，保留原包装细节与材质反光"
                            value={productAppearance}
                            onChange={e => setProductAppearance(e.target.value)}
                          />
                        </label>
                      </div>
                      <div className="add-role-footer">
                        <div className="add-role-shots">
                          <span>关联出镜镜头：</span>
                          {plan.shots.map(shot => {
                            const locked = Boolean(project.assets.frame[shot.id] && project.assets.frame[shot.id].status !== 'failed');
                            const checked = productShots.includes(shot.id);
                            return (
                              <button
                                key={shot.id}
                                type="button"
                                disabled={locked}
                                className={`shot-bind-chip ${checked ? 'is-selected' : ''}`}
                                onClick={() => setProductShots(prev => (checked ? prev.filter(x => x !== shot.id) : [...prev, shot.id]))}
                              >
                                镜头 {shot.id}
                              </button>
                            );
                          })}
                        </div>
                        <div className="add-role-actions">
                          <button type="button" className="btn-mini" onClick={() => setShowUploadProduct(false)}>取消</button>
                          <button type="submit" className="btn-mini is-primary" disabled={!productFile || !productName.trim()}>
                            上传并锁定商品图
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </form>
              )}

              {showAddRole && (
                <form className="add-role-panel" onSubmit={e => void handleAddCharacter(e)}>
                  <div className="add-role-fields">
                    <label className="add-role-field">
                      <span>人物名称</span>
                      <input
                        required
                        placeholder="如：陈默 / 咖啡师 / 路人甲"
                        value={newRoleName}
                        onChange={e => setNewRoleName(e.target.value)}
                      />
                    </label>
                    <label className="add-role-field is-wide">
                      <span>外貌与服装特征</span>
                      <input
                        required
                        placeholder="描述发型、五官特征、上衣/外套颜色与道具，用于锁定跨镜头一致性"
                        value={newRoleAppearance}
                        onChange={e => setNewRoleAppearance(e.target.value)}
                      />
                    </label>
                  </div>
                  <div className="add-role-footer">
                    <div className="add-role-shots">
                      <span>关联出镜镜头：</span>
                      {plan.shots.map(shot => {
                        const locked = Boolean(project.assets.frame[shot.id] && project.assets.frame[shot.id].status !== 'failed');
                        const checked = newRoleShots.includes(shot.id);
                        return (
                          <button
                            key={shot.id}
                            type="button"
                            disabled={locked}
                            className={`shot-bind-chip ${checked ? 'is-selected' : ''}`}
                            onClick={() => setNewRoleShots(prev => (checked ? prev.filter(x => x !== shot.id) : [...prev, shot.id]))}
                            title={locked ? '该镜头已生成首帧' : `绑定到镜头 ${shot.id}`}
                          >
                            镜头 {shot.id}
                          </button>
                        );
                      })}
                    </div>
                    <div className="add-role-actions">
                      <button type="button" className="btn-mini" onClick={() => setShowAddRole(false)}>取消</button>
                      <button type="submit" className="btn-mini is-primary">确认添加人物</button>
                    </div>
                  </div>
                </form>
              )}

              <div className="cast-grid">
                {plan.characters.map((role, roleIdx) => {
                  const asset = project.assets.role[role.id];
                  const key = `role:${role.id}`;
                  const busyHere = Boolean(slotBusy[key]) || isWorking(asset);
                  const lockedByFrame = (Object.values(project.assets.frame) as Asset[]).some(
                    f => f.status !== 'failed' && f.input.roles?.some((r: { slot: string }) => r.slot === role.id),
                  );
                  const usedInShots = plan.shots.filter(s => s.characters.includes(role.id)).map(s => `镜头 ${s.id}`).join(' · ') || '暂未绑定镜头';
                  const promptText = prompts[key] ?? role.appearance;
                  const isEditing = editingKey === key;

                  return (
                    <article key={role.id} className="cast-card">
                      <div className="cast-portrait">
                        {asset?.file ? (
                          <button type="button" className="portrait-frame" onClick={() => setPreview({ file: asset.file! })}>
                            <img src={asset.file} alt={role.name} />
                            <span className="media-badge is-ready"><Check size={11} /> 已锁定</span>
                          </button>
                        ) : (
                          <div className="portrait-empty">
                            {busyHere ? <Loader2 size={22} className="spin" /> : <ImageIcon size={22} />}
                            <span>{busyHere ? '生成中…' : '待生成'}</span>
                          </div>
                        )}
                      </div>

                      <div className="cast-info">
                        <div className="cast-header">
                          <div>
                            <div className="cast-name-row">
                              <span className={`cast-index ${role.kind === 'product' ? 'is-product' : ''}`}>
                                {role.kind === 'product' ? '商品主体' : `人物 #${roleIdx + 1}`}
                              </span>
                              <h3>{role.name}</h3>
                            </div>
                            <span className="cast-shots">出镜：{usedInShots}</span>
                          </div>
                          {!lockedByFrame && (
                            <div className="cast-card-actions">
                              <button
                                type="button"
                                className={asset?.confirmed ? 'btn-mini' : 'btn-mini is-primary'}
                                disabled={busyHere || Boolean(autoStage)}
                                onClick={() => void generateAndAutoConfirm(id, 'role', role.id, promptText)}
                              >
                                {busyHere ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
                                {asset?.file ? '重抽' : '生成立绘'}
                              </button>
                              <button
                                type="button"
                                className="btn-mini is-icon-only"
                                title="移除未锁定的角色"
                                disabled={busyHere || Boolean(autoStage) || Boolean(busy)}
                                onClick={() => void handleRemoveCharacter(role.id)}
                              >
                                <Trash2 size={12} />
                              </button>
                            </div>
                          )}
                        </div>

                        {isEditing && !lockedByFrame ? (
                          <div className="prompt-edit-box">
                            <textarea
                              aria-label={`${role.name} 人物设定`}
                              rows={2}
                              autoFocus
                              value={promptText}
                              onChange={e => setPrompts(prev => ({ ...prev, [key]: e.target.value }))}
                            />
                            <div className="prompt-edit-actions">
                              <button type="button" className="btn-mini" onClick={() => setEditingKey(null)}>完成</button>
                            </div>
                          </div>
                        ) : (
                          <div
                            className={`prompt-display ${!lockedByFrame ? 'is-editable' : ''}`}
                            onClick={() => { if (!lockedByFrame) setEditingKey(key); }}
                            title={lockedByFrame ? '角色已用于下游分镜首帧' : '点击微调人物设定提示词'}
                          >
                            <p>{promptText}</p>
                            {!lockedByFrame && <span className="edit-trigger"><Edit3 size={12} /> 微调设定</span>}
                          </div>
                        )}
                        {renderCandidateStrip('role', role.id, lockedByFrame)}
                      </div>
                    </article>
                  );
                })}
              </div>

              {!isOverview && (
                <div className="step-footer-bar">
                  <button type="button" className="btn-secondary" onClick={() => jumpToStep(2)}>
                    <ArrowLeft size={14} /> 上一步：剧本定稿
                  </button>
                  <button
                    type="button"
                    className={rolesReadyCount === plan.characters.length ? 'btn-primary-action' : 'btn-secondary'}
                    onClick={() => jumpToStep(4)}
                  >
                    <span>下一步：生成分镜首帧 ({framesReadyCount}/{plan.shots.length})</span>
                    <ArrowRight size={14} />
                  </button>
                </div>
              )}
            </section>
            )}

            {/* STEP 4 & 5: Focused Frame / Video Step or Overview Table (Single Unified Surface — Apple HIG) */}
            {showStoryboard && (
            <section id="section-storyboard" className="studio-section">
              {isOverview && (
                <div className="section-bar">
                  <div className="section-bar-title">
                    <h2>分镜生产总表</h2>
                  </div>
                </div>
              )}

              <div className="sb-table-wrap">
                {showFrames && renderModelBar(
                  'image',
                  <button
                    type="button"
                    className="btn-primary-action"
                    disabled={Boolean(autoStage) || Boolean(busy) || rolesReadyCount < plan.characters.length}
                    onClick={() => void runBatchKind('frame')}
                    title={rolesReadyCount < plan.characters.length ? '请先在第 03 步生成并锁定全部角色立绘' : '批量生成全部镜头首帧'}
                  >
                    <Sparkles size={13} /> 一键生成全部首帧
                  </button>,
                  true,
                )}
                {showVideos && renderModelBar(
                  'video',
                  <button
                    type="button"
                    className={isOverview ? 'btn-secondary' : 'btn-primary-action'}
                    disabled={Boolean(autoStage) || Boolean(busy) || framesReadyCount < plan.shots.length}
                    onClick={() => void runBatchKind('video')}
                    title={framesReadyCount < plan.shots.length ? '请先在第 04 步完成全部镜头首帧' : '批量生成全部分镜视频'}
                  >
                    <Film size={13} /> 一键生成全部视频
                  </button>,
                  true,
                )}
                <table className="sb-table">
                  <thead>
                    <tr>
                      <th style={{ width: '126px' }}>镜号 / 时长</th>
                      <th style={{ width: isOverview ? '156px' : '172px' }}>出镜人物与台词</th>
                      {(isOverview || showFrames) && <th style={{ width: isOverview ? '138px' : '152px' }}>原片参考</th>}
                      {showFrames && !isOverview && <th>首帧画面描述（点击微调）</th>}
                      <th style={{ width: showFrames && !isOverview ? '268px' : isOverview ? '220px' : '152px' }}>
                        {isOverview || showFrames ? '复刻首帧 / 候选选版' : '已锁定首帧'}
                      </th>
                      {showVideos && !isOverview && <th>运镜与动作描述（点击微调）</th>}
                      {showVideos && (
                        <th style={{ width: isOverview ? '230px' : '276px' }}>复刻动态视频 / 候选选版</th>
                      )}
                      <th style={{ width: '104px', textAlign: 'right' }}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.shots.map(shot => {
                      const frameKey = `frame:${shot.id}`;
                      const videoKey = `video:${shot.id}`;
                      const frameAsset = project.assets.frame[shot.id];
                      const videoAsset = project.assets.video[shot.id];
                      const frameBusy = Boolean(slotBusy[frameKey]) || isWorking(frameAsset);
                      const videoBusy = Boolean(slotBusy[videoKey]) || isWorking(videoAsset);
                      const rolesReadyForShot = shot.characters.every(cid => project.assets.role[cid]?.confirmed);
                      const frameLocked = Boolean(videoAsset && videoAsset.status !== 'failed');
                      const videoLocked = Boolean(project.film && project.film.status !== 'failed');
                      const origUrl = `/demo/projects/${project.id}/original/${shot.id}`;
                      const framePromptText = prompts[frameKey] ?? shot.framePrompt;
                      const videoPromptText = prompts[videoKey] ?? shot.videoPrompt;

                      return (
                        <tr key={shot.id}>
                          {/* Col 1: Shot Index + Title + Time */}
                          <td>
                            <div className="tbl-shot-meta">
                              <span className="sb-shot-num">SHOT {shot.id}</span>
                              <strong>{shot.title}</strong>
                              <span className="tbl-shot-time">{shot.start}s – {shot.end}s（{shot.end - shot.start}秒）</span>
                            </div>
                          </td>

                          {/* Col 2: Cast Chips + Dialogue */}
                          <td>
                            <div className="tbl-cast-col">
                              <div className="sb-cast-group" aria-label="出镜人物">
                                {frameLocked ? (
                                  shot.characters.length > 0 ? (
                                    shot.characters.map(cid => {
                                      const r = plan.characters.find(item => item.id === cid);
                                      return r ? <span key={cid} className="sb-role-tag is-active">{r.name}</span> : null;
                                    })
                                  ) : (
                                    <span className="sb-pill">空镜（无人）</span>
                                  )
                                ) : (
                                  plan.characters.map(r => {
                                    const present = shot.characters.includes(r.id);
                                    return (
                                      <button
                                        key={r.id}
                                        type="button"
                                        className={`sb-role-tag is-toggle ${present ? 'is-active' : ''}`}
                                        disabled={Boolean(autoStage) || Boolean(busy)}
                                        onClick={() => void handleToggleShotCharacter(shot, r.id)}
                                        title={present ? `点击从镜头 ${shot.id} 移除 ${r.name}` : `点击将 ${r.name} 加入镜头 ${shot.id}`}
                                      >
                                        {present && <Check size={10} />}
                                        {r.name}
                                      </button>
                                    );
                                  })
                                )}
                              </div>
                              {shot.caption && <div className="tbl-dialogue">“{shot.caption}”</div>}
                            </div>
                          </td>

                          {/* Col 3 (Step 3 & Overview): Original Reference Frame */}
                          {(isOverview || showFrames) && (
                            <td>
                              {project.hasSource !== false ? (
                                <button type="button" className="tbl-media-box" onClick={() => setPreview({ file: origUrl })}>
                                  <img src={origUrl} alt={`镜头 ${shot.id} 原片参考`} />
                                  <span className="viewport-tag">{shot.start}s</span>
                                </button>
                              ) : (
                                <div className="tbl-no-source">纯剧本模式</div>
                              )}
                            </td>
                          )}

                          {/* Col 4 (Step 3 only): Frame Prompt Cell */}
                          {showFrames && !isOverview && (
                            <td>
                              {editingKey === frameKey && !frameLocked ? (
                                <div className="prompt-edit-box">
                                  <textarea
                                    aria-label={`镜头 ${shot.id} 首帧提示词`}
                                    rows={3}
                                    autoFocus
                                    value={framePromptText}
                                    onChange={e => setPrompts(prev => ({ ...prev, [frameKey]: e.target.value }))}
                                  />
                                  <div className="prompt-edit-actions">
                                    <button type="button" className="btn-mini" onClick={() => setEditingKey(null)}>完成</button>
                                  </div>
                                </div>
                              ) : (
                                <div
                                  className={`tbl-prompt-cell ${!frameLocked ? 'is-editable' : ''}`}
                                  onClick={() => { if (!frameLocked) setEditingKey(frameKey); }}
                                >
                                  <p>{framePromptText}</p>
                                  {!frameLocked && <span className="edit-trigger"><Edit3 size={11} /> 微调提示词</span>}
                                </div>
                              )}
                            </td>
                          )}

                          {/* Col 5: Generated First Frame (+ Candidate Strip in Step 3 & Overview) */}
                          <td>
                            <div className="tbl-asset-cell">
                              {frameAsset?.file ? (
                                <button type="button" className="tbl-media-box" onClick={() => setPreview({ file: frameAsset.file! })}>
                                  <img src={frameAsset.file} alt={`镜头 ${shot.id} 复刻首帧`} />
                                  <span className="viewport-tag is-ready"><Check size={10} /> 首帧</span>
                                </button>
                              ) : (
                                <div className="tbl-media-box is-empty">
                                  {frameBusy ? <Loader2 size={18} className="spin" /> : <ImageIcon size={18} />}
                                  <span>{frameBusy ? '生成中…' : rolesReadyForShot ? '待生成首帧' : '需先完成人物立绘'}</span>
                                </div>
                              )}
                              {isOverview && <p className="tbl-mini-prompt" title={framePromptText}>{framePromptText}</p>}
                              {(showFrames || isOverview) && renderCandidateStrip('frame', shot.id, frameLocked || !showFrames)}
                            </div>
                          </td>

                          {/* Col 6 (Step 5 only): Camera Movement + Video Prompt Cell */}
                          {showVideos && !isOverview && (
                            <td>
                              <div className="tbl-video-motion-cell">
                                {modelCatalog?.cameraMovements && (
                                  <select
                                    aria-label={`镜头 ${shot.id} 运镜方式`}
                                    className="tbl-camera-select"
                                    value={shotCameras[shot.id] ?? videoAsset?.input?.camera ?? shot.camera ?? 'auto'}
                                    disabled={videoLocked || Boolean(autoStage)}
                                    onChange={e => setShotCameras(prev => ({ ...prev, [shot.id]: e.target.value }))}
                                  >
                                    {modelCatalog.cameraMovements.map(c => (
                                      <option key={c.id} value={c.id}>运镜：{c.name}</option>
                                    ))}
                                  </select>
                                )}
                                {editingKey === videoKey && !videoLocked ? (
                                  <div className="prompt-edit-box">
                                    <textarea
                                      aria-label={`镜头 ${shot.id} 分镜提示词`}
                                      rows={3}
                                      autoFocus
                                      value={videoPromptText}
                                      onChange={e => setPrompts(prev => ({ ...prev, [videoKey]: e.target.value }))}
                                    />
                                    <div className="prompt-edit-actions">
                                      <button type="button" className="btn-mini" onClick={() => setEditingKey(null)}>完成</button>
                                    </div>
                                  </div>
                                ) : (
                                  <div
                                    className={`tbl-prompt-cell is-compact ${!videoLocked ? 'is-editable' : ''}`}
                                    onClick={() => { if (!videoLocked) setEditingKey(videoKey); }}
                                  >
                                    <p>{videoPromptText}</p>
                                    {!videoLocked && <span className="edit-trigger"><Edit3 size={11} /> 微调</span>}
                                  </div>
                                )}
                              </div>
                            </td>
                          )}

                          {/* Col 7 (Step 4 & Overview): Generated Shot Video + Candidate Strip */}
                          {showVideos && (
                            <td>
                              <div className="tbl-asset-cell">
                                {videoAsset?.file ? (
                                  <div className="tbl-media-box">
                                    <video src={videoAsset.file} poster={frameAsset?.file || undefined} controls playsInline preload="metadata" />
                                  </div>
                                ) : (
                                  <div className="tbl-media-box is-empty">
                                    {videoBusy ? <Loader2 size={18} className="spin" /> : <Film size={18} />}
                                    <span>{videoBusy ? '生成中…' : frameAsset?.confirmed ? '待生成视频' : '需先完成首帧'}</span>
                                  </div>
                                )}
                                {isOverview && <p className="tbl-mini-prompt" title={videoPromptText}>{videoPromptText}</p>}
                                {renderCandidateStrip('video', shot.id, videoLocked)}
                              </div>
                            </td>
                          )}

                          {/* Col 8: Row Action Buttons */}
                          <td>
                            <div className="tbl-row-actions">
                              {showFrames && (
                                !frameLocked ? (
                                  <button
                                    type="button"
                                    className={`btn-mini ${frameAsset?.confirmed ? '' : 'is-primary'}`}
                                    disabled={frameBusy || Boolean(autoStage) || !rolesReadyForShot}
                                    onClick={() => void generateAndAutoConfirm(id, 'frame', shot.id, framePromptText)}
                                  >
                                    {frameBusy ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
                                    {frameAsset?.file ? '重抽首帧' : '生成首帧'}
                                  </button>
                                ) : (
                                  <span className="tbl-locked-tag">首帧已锁</span>
                                )
                              )}
                              {showVideos && (
                                !videoLocked ? (
                                  <button
                                    type="button"
                                    className={`btn-mini ${videoAsset?.confirmed ? '' : 'is-primary'}`}
                                    disabled={videoBusy || Boolean(autoStage) || !frameAsset?.confirmed}
                                    onClick={() => void generateAndAutoConfirm(id, 'video', shot.id, videoPromptText)}
                                  >
                                    {videoBusy ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
                                    {videoAsset?.file ? '重抽视频' : '生成视频'}
                                  </button>
                                ) : (
                                  <span className="tbl-locked-tag">视频已锁</span>
                                )
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {!isOverview && (
                <div className="step-footer-bar">
                  <button type="button" className="btn-secondary" onClick={() => jumpToStep(showFrames ? 3 : 4)}>
                    <ArrowLeft size={14} /> {showFrames ? '上一步：画风与人物' : '上一步：分镜首帧'}
                  </button>
                  <button type="button" className="btn-primary-action" onClick={() => jumpToStep(showFrames ? 5 : 6)}>
                    <span>{showFrames ? `下一步：生成分镜视频 (${videosReadyCount}/${plan.shots.length})` : '下一步：合成最终成片'}</span>
                    <ArrowRight size={14} />
                  </button>
                </div>
              )}
            </section>
            )}
          </div>
        )}
      </main>
      {preview && <Lightbox media={preview} close={() => setPreview(null)} />}
    </div>
  );
}

export default VideoReconstructionApp;

const standaloneRoot = typeof document !== 'undefined' ? document.getElementById('reconstruction-demo-root') || document.getElementById('root') : null;
if (standaloneRoot && typeof window !== 'undefined' && window.location.port === '4187') {
  createRoot(standaloneRoot).render(<BrowserRouter><VideoReconstructionApp /></BrowserRouter>);
}

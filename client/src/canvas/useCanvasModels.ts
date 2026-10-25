import { useCallback, useEffect, useState } from 'react';
import { fetchImageModels, getCachedImageModels, type ImageModel } from '../api/imageGen';
import { fetchVideoModels, getCachedVideoModels, type VideoModel } from '../api/video';
import { analysisApi, getCachedTtsModels, type TtsModel } from '../api/analysis';
import type { GenerationDraft } from './model';

type Kind = GenerationDraft['kind'];
export type CanvasModel = ImageModel & Partial<VideoModel> & { voices?: string[] };
const audioModels = (items: TtsModel[]): CanvasModel[] => items.map(m => ({
  id: m.modelId, name: m.displayName, description: m.description || '',
  available: true, rate: m.rate, voices: m.voices,
}));
function cachedModels(kind: Kind): CanvasModel[] {
  if (kind === 'image') return getCachedImageModels();
  if (kind === 'video') return getCachedVideoModels().filter(m => m.available);
  return audioModels(getCachedTtsModels());
}
async function loadModels(kind: Kind, force: boolean): Promise<CanvasModel[]> {
  if (kind === 'image') return fetchImageModels(force);
  if (kind === 'video') return (await fetchVideoModels(force)).filter(m => m.available);
  return audioModels(await analysisApi.getTtsModels(force));
}

/** Each active catalog settles independently; old account/type responses cannot change the panel. */
export function useCanvasModels(kind: Kind, userId: number | undefined, selectedModel: string) {
  const identity = localStorage.getItem('token') || '';
  const key = JSON.stringify([kind, userId, identity]);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{ key: string; models: CanvasModel[]; refreshing: boolean; error: string }>(
    () => ({ key, models: cachedModels(kind), refreshing: true, error: '' }),
  );
  // Hide previous-account prices synchronously, before the loading effect runs.
  const current = state.key === key ? state : { key, models: [] as CanvasModel[], refreshing: true, error: '' };
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    let cancelled = false;
    setState(previous => ({ key, models: previous.key === key ? previous.models : cachedModels(kind), refreshing: true, error: '' }));
    loadModels(kind, revision > 0).then(models => {
      if (!cancelled) setState({ key, models, refreshing: false, error: '' });
    }).catch(error => {
      if (!cancelled) setState(previous => ({ ...previous, refreshing: false,
        error: `${kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频'}模型加载失败：${error instanceof Error ? error.message : '请重试'}`,
      }));
    });
    return () => { cancelled = true; };
  }, [key, revision]);

  const retryAt = kind === 'image' ? current.models.find(m => m.id === selectedModel)?.retryAt : undefined;
  useEffect(() => {
    // Keep the existing image availability refresh, without hiding a usable catalog.
    const canRefresh = !current.refreshing && !current.error;
    const interval = kind === 'image' && canRefresh ? window.setInterval(refresh, 15_000) : undefined;
    const timer = canRefresh && retryAt && retryAt > Date.now() ? window.setTimeout(refresh, retryAt - Date.now() + 100) : undefined;
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    return () => {
      window.clearInterval(interval); window.clearTimeout(timer);
      window.removeEventListener('focus', refresh); window.removeEventListener('online', refresh);
    };
  }, [kind, retryAt, refresh, current.refreshing, current.error]);
  return { models: current.models, loading: current.refreshing && !current.models.length,
    refreshing: current.refreshing, error: current.error, refresh };
}

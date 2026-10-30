import { useCallback, useEffect, useState } from 'react';
import { fetchVideoQuote, type VideoQuote } from '../api/video';
import { useAuthStore } from '../stores/authStore';
const WAN_VIDEO_MODELS = new Set(['wan3.0-video-nsfw']);
const EMPTY_REFERENCE_VIDEOS: string[] = [];

function browserVideoDuration(source: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const media = document.createElement('video');
    const timer = window.setTimeout(() => finish(new Error('读取参考视频时长超时')), 15_000);
    const finish = (error?: Error, duration?: number) => {
      window.clearTimeout(timer);
      media.removeAttribute('src');
      media.load();
      if (error) reject(error); else resolve(duration!);
    };
    media.preload = 'metadata';
    media.onloadedmetadata = () => Number.isFinite(media.duration) && media.duration > 0 ? finish(undefined, media.duration) : finish(new Error('无法读取参考视频时长'));
    media.onerror = () => finish(new Error('无法读取参考视频时长'));
    media.src = source;
  });
}

export function useVideoQuote(model: string, resolution: string, seconds: number, enabled: boolean, referenceVideos: string[] = EMPTY_REFERENCE_VIDEOS) {
  const userId = useAuthStore(state => state.user?.id);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{ key: string; quote?: VideoQuote; error?: string; loading: boolean }>({ key: '', loading: false });
  const needsVideoProbe = WAN_VIDEO_MODELS.has(model) && referenceVideos.length > 0;
  const referenceKey = JSON.stringify(referenceVideos.map(source => [source.length, source.slice(0, 48), source.slice(-48)]));
  const [probe, setProbe] = useState<{ key: string; seconds?: number; error?: string }>({ key: '' });
  const probeReady = !needsVideoProbe || probe.key === referenceKey && probe.seconds !== undefined;
  const key = JSON.stringify([userId, model, resolution, seconds, enabled, revision, referenceKey, probe.seconds]);
  const refresh = useCallback(() => setRevision(r => r+1), []);
  useEffect(() => {
    if (!needsVideoProbe) { setProbe({ key: referenceKey, seconds: 0 }); return; }
    let cancelled = false;
    setProbe({ key: referenceKey });
    Promise.all(referenceVideos.map(browserVideoDuration)).then(durations => {
      const billableDurations = durations.map(value => Math.ceil((value - Number.EPSILON) * 10) / 10);
      if (!cancelled) setProbe({ key: referenceKey, seconds: Math.round(billableDurations.reduce((sum, value) => sum + value, 0) * 10) / 10 });
    }).catch(error => { if (!cancelled) setProbe({ key: referenceKey, error: error.message || '无法读取参考视频时长' }); });
    return () => { cancelled = true; };
  }, [needsVideoProbe, referenceKey, referenceVideos]);
  useEffect(() => {
    if (!enabled || !model || !resolution) { setState({ key, loading: false }); return; }
    if (needsVideoProbe && probe.key === referenceKey && probe.error) { setState({ key, loading: false, error: probe.error }); return; }
    if (!probeReady) { setState({ key, loading: true }); return; }
    const controller = new AbortController();
    setState({ key, loading: true });
    const timer = window.setTimeout(() => {
      const request = (probe.seconds || 0) > 0
        ? fetchVideoQuote(model, resolution, seconds, controller.signal, probe.seconds)
        : fetchVideoQuote(model, resolution, seconds, controller.signal);
      request.then(quote => {
        if (!controller.signal.aborted) setState({ key, loading: false, quote });
      }).catch(error => { if (!controller.signal.aborted) setState({ key, loading: false, error: error.message || '费用预估失败' }); });
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [key, model, resolution, seconds, enabled, needsVideoProbe, probe.key, probe.error, probe.seconds, probeReady, referenceKey]);
  useEffect(() => { if (!enabled) return; window.addEventListener('focus', refresh); return () => window.removeEventListener('focus', refresh); }, [enabled, refresh]);
  return { ...(state.key === key ? state : { loading: enabled }), refresh };
}

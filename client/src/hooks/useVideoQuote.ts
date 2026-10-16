import { useCallback, useEffect, useState } from 'react';
import { fetchVideoQuote, type VideoQuote } from '../api/video';
import { useAuthStore } from '../stores/authStore';
export function useVideoQuote(model: string, resolution: string, seconds: number, enabled: boolean) {
  const userId = useAuthStore(state => state.user?.id);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{ key: string; quote?: VideoQuote; error?: string; loading: boolean }>({ key: '', loading: false });
  const key = JSON.stringify([userId, model, resolution, seconds, enabled, revision]);
  const refresh = useCallback(() => setRevision(r => r+1), []);
  useEffect(() => {
    if (!enabled || !model || !resolution) { setState({ key, loading: false }); return; }
    const controller = new AbortController();
    setState({ key, loading: true });
    const timer = window.setTimeout(() => {
      fetchVideoQuote(model, resolution, seconds, controller.signal).then(quote => {
        if (!controller.signal.aborted) setState({ key, loading: false, quote });
      }).catch(error => { if (!controller.signal.aborted) setState({ key, loading: false, error: error.message || '费用预估失败' }); });
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [key, model, resolution, seconds, enabled]);
  useEffect(() => { if (!enabled) return; window.addEventListener('focus', refresh); return () => window.removeEventListener('focus', refresh); }, [enabled, refresh]);
  return { ...(state.key === key ? state : { loading: enabled }), refresh };
}

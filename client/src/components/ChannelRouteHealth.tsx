import { useEffect, useRef, useState } from 'react';
import { adminApi } from '../api/admin';
import { isUpstreamCreditFailure, modelAvailabilityMessage } from '../../../shared/upstreamAvailability';

type RouteIssue = { modelId: string; name: string; key: string; state: string; lastError: string; retryAt?: number; probeUntil?: number };
export default function ChannelRouteHealth({ channelId, disabled = false }: { channelId: number; disabled?: boolean }) {
  const [issues, setIssues] = useState<RouteIssue[]>([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const revision = useRef(0);
  const requestSequence = useRef(0);
  const [loading, setLoading] = useState(true);
  async function load(version: number) {
    const sequence = ++requestSequence.current;
    const specs = await adminApi.getModelSpecifications();
    if (version !== revision.current || sequence !== requestSequence.current) return;
    const found = new Map<string, RouteIssue>();
    for (const spec of specs) for (const route of spec.routes.filter((r: any) => r.channelId === channelId)) {
      for (const health of spec.routeStatus?.find((s: any) => s.id === route.id)?.health || []) {
        if (health.state !== 'healthy') found.set(health.key, { ...health, modelId: spec.modelId, name: spec.displayName || '生成模型' });
      }
    }
    setIssues([...found.values()]); setError(''); setLoading(false);
    if (found.size) setMessage('');
  }
  useEffect(() => {
    const version = ++revision.current;
    setIssues([]); setMessage(''); setError(''); setLoading(true);
    const refresh = () => { if (!pending.current) void load(version).catch(() => { if (version === revision.current) setError('线路状态加载失败，请稍后重试。'); }); };
    refresh(); const timer = window.setInterval(refresh, 15_000);
    return () => { ++revision.current; window.clearInterval(timer); };
  }, [channelId]);
  async function restore(issue: RouteIssue) {
    if (pending.current || disabled) return;
    pending.current = true; setBusy(true); setMessage(''); setError('');
    const version = revision.current;
    ++requestSequence.current;
    try {
      await adminApi.resetModelRouteHealth(issue.modelId, issue.key);
      if (version !== revision.current) return;
      setMessage('已解除线路暂停，可重新提交。请确认上游积分或密钥已修复；原任务不会自动重跑。');
      await load(version).catch(() => { if (version === revision.current) setError('已解除暂停，但状态刷新失败，请稍后刷新页面。'); });
    } catch { if (version === revision.current) setError('恢复失败，请刷新线路状态后重试。'); }
    finally { pending.current = false; setBusy(false); }
  }
  return <section className="channel-route-health" aria-label="线路可用状态">
    <h3>线路可用状态</h3>
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    {loading && !error && <p role="status">正在读取线路状态…</p>}
    {!loading && !issues.length && !error && !message && <p>当前没有暂停的线路。</p>}
    {issues.map(issue => <div className="channel-route-issue" key={issue.key}>
      <div><strong>{issue.name}</strong><p>{issue.probeUntil && issue.probeUntil > Date.now() ? '正在尝试恢复，请等待当前请求完成。' : issue.state === 'cooldown' && (issue.retryAt || 0) <= Date.now() ? '冷却已结束，可以重新提交；请确认上游问题已处理。' : modelAvailabilityMessage({ available: false, unavailableReason: issue.state === 'blocked' ? 'credentials' : isUpstreamCreditFailure(issue.lastError) ? 'credits' : 'cooldown', retryAt: issue.retryAt })}</p></div>
      <button type="button" disabled={disabled || busy || Boolean(issue.probeUntil && issue.probeUntil > Date.now())} onClick={() => void restore(issue)}>{busy ? '正在恢复…' : '立即恢复'}</button>
    </div>)}
  </section>;
}

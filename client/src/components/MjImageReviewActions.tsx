import React, { useState } from 'react';
import { adminApi } from '../api/admin';

export function MjImageReviewActions({ id, metadata, hasResult, onResolved }: {
  key?: React.Key; id: number; metadata: Record<string, any>; hasResult: boolean; onResolved: () => Promise<void>;
}) {
  const [urls, setUrls] = useState((metadata.upstreamImageUrls || []).join('\n'));
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  if (hasResult || metadata.nativeImageOutputs !== 4 || !metadata.requiresReview) return null;
  const recover = async () => {
    setBusy(true); setMessage('正在取回原任务图片…');
    try {
      const result = await adminApi.recoverMjImages(id, urls.split(/\r?\n/).map(url => url.trim()).filter(Boolean));
      setMessage(result.message);
      await onResolved();
    } catch (error: any) { setMessage(error.message || '原结果未取回，请核对下载地址后重试'); }
    finally { setBusy(false); }
  };
  return <section className="rounded-xl border border-amber-400/25 bg-amber-500/10 p-4 text-xs" aria-label="恢复 MJ 原任务图片">
    <div className="mb-2 font-semibold">恢复 MJ 原任务图片</div>
    <p className="mb-3 leading-relaxed">先在原渠道日志核对时间、提示词和成功状态，再复制该任务的图片下载地址。只取回原结果，使用原预扣费用结算，不重新生成或扣费。</p>
    <textarea aria-label="MJ 原任务图片下载地址" rows={3} value={urls} disabled={busy}
      onChange={event => { setUrls(event.target.value); setConfirmed(false); }} placeholder="一张四宫格地址，或四张图片地址（每行一个）"
      className="w-full rounded-lg border border-white/10 bg-black/20 p-2" />
    <label className="my-3 flex items-center gap-2"><input type="checkbox" checked={confirmed} disabled={busy}
      onChange={event => setConfirmed(event.target.checked)} />已核对上游日志，确认地址属于本笔成功任务</label>
    <button type="button" disabled={busy || !confirmed || !urls.trim()} onClick={() => { void recover(); }}
      className="rounded-lg border border-amber-400/30 px-3 py-2 disabled:opacity-50">
      {busy ? '正在取回…' : '取回原任务的四张图片'}
    </button>
    {message && <p role="status" className="mt-3 whitespace-pre-wrap">{message}</p>}
  </section>;
}

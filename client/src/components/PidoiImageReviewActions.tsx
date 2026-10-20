import React, { useState } from 'react';
import { adminApi } from '../api/admin';

export function PidoiImageReviewActions({ id, status, cost, metadata, hasResult, onResolved }: {
  key?: React.Key; id: number; status: string; cost: number; metadata: any; hasResult: boolean; onResolved: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  if (metadata.imageProtocol !== 'pidoi-async-v1' || metadata.managedSpecification || !['review', 'processing'].includes(status)) return null;
  const canRefund = status === 'review' && !hasResult && !metadata.imageUrls?.length && !metadata.upstreamImageUrls?.length
    && !metadata.pidoiImageJobs?.some((job: any) => job.sourceUrl || job.localUrl || job.status === 'completed');
  const run = async (refund: boolean) => {
    if (busy) return;
    let note = '';
    if (refund) {
      if (!window.confirm(`请先在上游核实任务 #${id} 未成功、没有可交付图片。确认后将结束本站任务并退回 ¥${cost.toFixed(2)}，停止自动恢复。是否继续？`)) return;
      const input = window.prompt('请输入 6–500 字的核实依据（上游任务号、核实时间、确认失败的依据）：');
      if (input === null) return;
      note = input.trim();
      if (note.length < 6 || note.length > 500) { setMessage('请填写 6–500 字的核实依据'); return; }
    }
    setBusy(true); setMessage('');
    try {
      if (refund) {
        const result = await adminApi.confirmPidoiImageFailure(id, note);
        setMessage(result.alreadyResolved ? '已处理，未重复退款' : `已退回 ¥${result.refundedAmount.toFixed(2)}`);
      } else setMessage((await adminApi.recheckPidoiImage(id)).message);
      await onResolved();
    } catch (error: any) { setMessage(error.message || '处理失败，请稍后再试'); }
    finally { setBusy(false); }
  };
  return <div className="mt-3 space-y-2 rounded-lg border border-amber-500/20 p-3">
    <p className="text-xs text-zinc-400">这是生成结果待确认，不是内容审核。查询不会重新生成或重复扣费。</p>
    <div className="flex flex-wrap gap-2">
      <button type="button" disabled={busy} onClick={() => void run(false)} className="rounded-lg border border-white/20 px-3 py-2 text-xs focus-visible:ring-2 disabled:opacity-50">{busy ? '处理中…' : '查询原任务'}</button>
      {canRefund && <button type="button" disabled={busy} onClick={() => void run(true)} className="rounded-lg border border-red-400/30 px-3 py-2 text-xs text-red-400 focus-visible:ring-2 disabled:opacity-50">确认失败并退款</button>}
    </div>
    <p role="status" aria-live="polite" className="text-xs text-zinc-400">{message || metadata.pidoiRecoveryPauseReason}</p>
  </div>;
}

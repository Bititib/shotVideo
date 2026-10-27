import React, { useState } from 'react';
import { adminApi } from '../api/admin';

export function PidoiImageReviewActions({ id, status, cost, metadata, hasResult, onResolved }: {
  key?: React.Key; id: number; status: string; cost: number; metadata: any; hasResult: boolean; onResolved: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [showSupplement, setShowSupplement] = useState(false);
  const [links, setLinks] = useState('');
  const [showTaskSupplement, setShowTaskSupplement] = useState(false);
  const [taskId, setTaskId] = useState('');
  if (metadata.imageProtocol !== 'pidoi-async-v1' || metadata.managedSpecification || !['review', 'processing'].includes(status)) return null;
  const canRefund = status === 'review' && !hasResult && !metadata.imageUrls?.length && !metadata.upstreamImageUrls?.length
    && !metadata.pidoiImageJobs?.some((job: any) => job.sourceUrl || job.localUrl || job.status === 'completed');
  const supplementTask = async () => {
    if (busy || !taskId.trim()) return;
    setBusy(true); setMessage('正在核对上游原任务…');
    try {
      setMessage((await adminApi.supplementPidoiImageTask(id, taskId.trim())).message);
      await onResolved();
    } catch (error: any) { setMessage(error.message || '任务查询未通过，未绑定编号'); }
    finally { setBusy(false); }
  };
  const supplement = async () => {
    if (busy) return;
    const urls = links.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (urls.length !== Number(metadata.count ?? 1)) { setMessage(`请填写全部 ${metadata.count ?? 1} 张图片链接，每行一条`); return; }
    setBusy(true); setMessage('正在下载并保存图片，请稍候…');
    try {
      setMessage((await adminApi.supplementPidoiImageResults(id, urls)).message);
      await onResolved();
    } catch (error: any) { setMessage(error.message || '图片补录失败'); }
    finally { setBusy(false); }
  };
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
      {canRefund && !metadata.batchItemId && <button type="button" disabled={busy} onClick={() => setShowSupplement(!showSupplement)} className="rounded-lg border border-white/20 px-3 py-2 text-xs focus-visible:ring-2 disabled:opacity-50">补录成功图片</button>}
      {canRefund && !metadata.batchItemId && Number(metadata.count ?? 1) === 1 && <button type="button" disabled={busy} onClick={() => setShowTaskSupplement(!showTaskSupplement)} className="rounded-lg border border-white/20 px-3 py-2 text-xs focus-visible:ring-2 disabled:opacity-50">补录上游任务 ID</button>}
    </div>
    {canRefund && showTaskSupplement && <div className="space-y-2 border-t border-white/10 pt-2">
      <label htmlFor={`pidoi-task-id-${id}`} className="block text-xs">本订单的上游任务 ID</label>
      <input id={`pidoi-task-id-${id}`} value={taskId} disabled={busy} onChange={event => setTaskId(event.target.value)} className="w-full rounded-lg border border-white/20 bg-transparent p-2 text-xs" />
      <p className="text-xs text-zinc-400">请核对编号属于本订单。查到成功结果后保存原图片，沿用原 ¥{cost.toFixed(2)} 预扣；原任务明确失败则退款。查询报错不绑定编号，仍可更正或核实后退款。</p>
      <button type="button" disabled={busy || !taskId.trim()} onClick={() => void supplementTask()} className="rounded-lg border border-white/20 px-3 py-2 text-xs focus-visible:ring-2 disabled:opacity-50">{busy ? '正在查询…' : '查询原任务并恢复'}</button>
    </div>}
    {canRefund && showSupplement && <div className="space-y-2 border-t border-white/10 pt-2">
      <label htmlFor={`pidoi-result-links-${id}`} className="block text-xs">原订单成功图片链接（每行一条，共 {metadata.count ?? 1} 张）</label>
      <textarea id={`pidoi-result-links-${id}`} rows={3} value={links} disabled={busy} onChange={event => setLinks(event.target.value)} placeholder="https://…" className="w-full rounded-lg border border-white/20 bg-transparent p-2 text-xs" />
      <p className="text-xs text-zinc-400">请核对图片属于本订单，填写可直接下载的 HTTPS 链接。全部保存成功后恢复订单，沿用原 ¥{cost.toFixed(2)} 预扣，不会重新生成或重复扣费。</p>
      <button type="button" disabled={busy || !links.trim()} onClick={() => void supplement()} className="rounded-lg border border-white/20 px-3 py-2 text-xs focus-visible:ring-2 disabled:opacity-50">{busy ? '正在保存…' : '保存图片并恢复成功'}</button>
    </div>}
    <p role="status" aria-live="polite" className="text-xs text-zinc-400">{message || metadata.pidoiRecoveryPauseReason}</p>
  </div>;
}

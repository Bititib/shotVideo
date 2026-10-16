/** A generated video is not ready for delivery until a result link can be saved. */
export function videoTaskPhase(status: string, raw: unknown) {
  let meta: any = {};
  try { meta = typeof raw === 'string' ? JSON.parse(raw) : raw || {}; } catch {}
  if (['completed','success','complete'].includes(status)) return 'completed';
  if (['failed','error'].includes(status)) return 'failed';
  if (status === 'review') return 'review';
  if (meta.progressText === '视频已生成，正在保存到本站存储') return 'saving';
  if ((meta.upstreamGenerated && meta.upstreamDeliveryPending) || meta.progressText === '视频已生成，正在等待结果交付') return 'awaiting_delivery';
  return status;
}

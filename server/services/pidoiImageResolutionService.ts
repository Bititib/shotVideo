import { sqlite } from '../db/index.js';
import { isSuperAdmin } from '../middleware/admin.js';
import { resolveBillingReservation } from './billingReconciliation.js';
import { recoverPidoiImage, pidoiImageActive } from './pidoiImageWorker.js';
import { localizeRecoveredImages } from './pidoiImageStorage.js';
import { finalizeReservedContent } from './contentBillingService.js';
import { transportDiagnostic, upstreamDiagnostic } from './upstreamDiagnostic.js';
import { ChannelService } from './channelService.js';
import { isPidoiImageChannel, pollPidoiImage } from './pidoiImageAdapter.js';

const fail = (status: number, message: string): never => { throw Object.assign(new Error(message), { status }); };
function authorize(contentId: number, adminId: number) {
  if (!Number.isSafeInteger(contentId) || contentId <= 0) fail(400, '记录 ID 无效');
  const admin = sqlite.prepare('SELECT role,is_active FROM users WHERE id=?').get(adminId) as any;
  if (!admin?.is_active || !isSuperAdmin(admin.role)) fail(403, '需要有效的超级管理员账号');
  const row = sqlite.prepare('SELECT * FROM contents WHERE id=?').get(contentId) as any;
  if (!row) fail(404, '记录不存在');
  let meta: any;
  try { meta = JSON.parse(row.metadata || '{}'); } catch { fail(409, '记录信息损坏，请人工核查'); }
  if (row.type !== 'image' || meta?.imageProtocol !== 'pidoi-async-v1' || meta.managedSpecification || meta.batchItemId) fail(409, '该入口仅处理 Pidoi 网页图片任务');
  return { row, meta };
}

export async function recheckPidoiImage(contentId: number, adminId: number) {
  authorize(contentId, adminId);
  if (pidoiImageActive.has(contentId)) fail(409, '原任务正在提交或查询，请稍后刷新');
  await recoverPidoiImage(contentId);
  const { row, meta } = authorize(contentId, adminId);
  return { id: contentId, status: row.status, taskId: meta.upstreamTaskId || meta.taskId || '',
    message: row.status === 'completed' ? '图片已保存，已完成结算' : row.status === 'failed' ? '任务已结束，请查看退款信息'
      : meta.pidoiRecoveryPausedAt ? meta.pidoiRecoveryPauseReason || '自动恢复已暂停，请核对原任务后处理'
      : meta.recoveryStage === 'download' ? '图片已生成，后台继续重试保存，不会重新生成'
      : meta.lastRecoveryError ? '查询暂未成功，未重新生成或退款；请核对原上游任务'
      : !meta.pidoiImageJobs?.length ? '未找到可查询任务 ID，请核对上游；确认未成功后可退款' : '已查询原任务，后台将继续跟进，不会重新生成' };
}

/** Verify a manually entered ID with the original provider BEFORE attaching it to the order. */
export async function supplementPidoiImageTask(contentId: number, adminId: number, input: unknown) {
  const { row, meta } = authorize(contentId, adminId);
  if (row.status === 'completed' && row.result_url && meta.pidoiTaskSupplement && meta.billingStatus === 'settled')
    return { id: contentId, status: 'completed', message: '原任务已恢复成功，未重复扣费', alreadyResolved: true };
  if (pidoiImageActive.has(contentId)) fail(409, '任务正在提交、查询或保存，请稍后刷新');
  supplementReservation(row, meta);
  if (Number(meta.count ?? 1) !== 1) fail(409, '任务 ID 补录仅支持单图订单；多图订单请补录全部成功图片链接');
  if (typeof input !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(input.trim()) || /^(?:undefined|null|unknown|pending)$/i.test(input.trim()))
    fail(400, '请填写真实的上游任务 ID，不能填写提示文字或链接');
  const taskId = (input as string).trim();
  if (meta.pidoiImageJobs?.some((job: any) => job.taskId && job.taskId !== taskId))
    fail(409, '订单已有其他上游任务，请查询原任务，不能覆盖编号');
  const channel = ChannelService.getChannelRaw(meta.channelId, meta.channelApiKeyId);
  if (!channel?.apiKey || !isPidoiImageChannel(channel)) fail(409, '原 Pidoi 渠道或密钥不可用，请在渠道管理核对');
  pidoiImageActive.add(contentId);
  let verifiedStatus: string;
  try {
    let task: Awaited<ReturnType<typeof pollPidoiImage>>;
    try { task = await pollPidoiImage(channel, taskId); }
    catch (error: any) {
      // Do not return upstream 401 as our login status; keep its diagnosis in the body.
      const hint = error.status === 401 || error.status === 403 ? '请核对原渠道 API 密钥及原任务的查询权限。' : '';
      fail(502, `${transportDiagnostic('Pidoi', '补录编号查询未通过', error, channel.apiKey)} ${hint}未绑定该编号，订单和预扣保持不变。`);
    }
    if (task!.taskId !== taskId) fail(422, '查询响应未返回匹配的任务 ID，未绑定编号，订单和预扣保持不变');
    verifiedStatus = task!.status;
    sqlite.transaction(() => {
      const current = authorize(contentId, adminId);
      supplementReservation(current.row, current.meta);
      if (current.row.metadata !== row.metadata || current.row.user_id !== row.user_id)
        fail(409, '查询期间订单已变更，请刷新后核对');
      const duplicate = sqlite.prepare(`SELECT id FROM contents WHERE id<>? AND type='image'
        AND CASE WHEN json_valid(metadata) THEN json_extract(metadata,'$.channelId') END=?
        AND (CASE WHEN json_valid(metadata) THEN json_extract(metadata,'$.upstreamTaskId') END=?
          OR CASE WHEN json_valid(metadata) THEN json_extract(metadata,'$.taskId') END=?) LIMIT 1`).get(contentId, meta.channelId, taskId, taskId) as any;
      if (duplicate) fail(409, `该任务已关联订单 #${duplicate.id}，不能重复关联`);
      const at = new Date().toISOString();
      const recoveryRequired = task!.status === 'processing' && task!.raw?.data?.recovery_required === true;
      const pauseReason = recoveryRequired ? upstreamDiagnostic('Pidoi', '上游要求核查原任务结果', { message: task!.raw.message || 'recovery_required=true：上游要求管理员核查结果' }) : null;
      // Keep the verified receipt and source before download, so restarts can recover it.
      const next = { ...meta, count: 1, taskId, upstreamTaskId: taskId, upstreamTaskIds: [taskId],
        pidoiImageJobs: [{ index: 0, taskId, pollPath: task!.pollPath, protocol: 'async', status: task!.status,
          sourceUrl: task!.imageUrl, error: task!.error }],
        upstreamImageUrls: task!.imageUrl ? [task!.imageUrl] : [], progresses: [task!.progress],
        pidoiTaskSupplement: { adminId, at, taskId, verifiedStatus: task!.status, channelId: meta.channelId,
          previousFailureReason: meta.failureReason || null, previousRecoveryPauseReason: meta.pidoiRecoveryPauseReason || null },
        pidoiRecoveryStartedAt: Date.now(), pidoiRecoveryPausedAt: recoveryRequired ? at : null, pidoiRecoveryPauseReason: pauseReason,
        lastRecoveryError: null, failureReason: null, requiresReview: recoveryRequired, recoveryStage: 'poll',
        progressText: pauseReason || (task!.status === 'completed' ? '已查到原图片，正在保存' : '已核实原任务，后台继续获取结果'),
      };
      sqlite.prepare('UPDATE contents SET status=?,metadata=? WHERE id=?').run(recoveryRequired ? 'review' : 'processing', JSON.stringify(next), contentId);
    })();
  } finally { pidoiImageActive.delete(contentId); }
  // Processing receipts continue in the normal scanner. Terminal receipts need no further GET.
  if (verifiedStatus! !== 'processing') await recoverPidoiImage(contentId);
  const current = authorize(contentId, adminId);
  return { id: contentId, status: current.row.status, alreadyResolved: false,
    message: current.row.status === 'completed' ? '原图片已保存，订单已恢复成功，沿用原预扣，未重复扣费'
      : current.row.status === 'failed' ? '原任务明确失败，已按原预扣账本退款'
      : current.meta.pidoiRecoveryPausedAt ? current.meta.pidoiRecoveryPauseReason
      : current.meta.recoveryStage === 'download' ? '原图片已找到，保存暂未完成，后台继续下载，不会重新生成或扣费'
      : current.meta.lastRecoveryError ? '已保存原任务回执，恢复暂未完成，请查询原任务查看原因'
      : '已核实并保存原任务 ID，后台继续获取原结果，不会重新生成或重复扣费' };
}

function supplementReservation(row: any, meta: any) {
  if (row.status !== 'review') fail(409, '只允许补录结果待确认的任务');
  if (row.result_url || meta.imageUrls?.length || meta.upstreamImageUrls?.length
    || meta.pidoiImageJobs?.some((job: any) => job.localUrl || job.sourceUrl || job.status === 'completed'))
    fail(409, '已有成功图片，请查询原任务恢复，不能覆盖结果');
  const bill = meta.billingReservationId && sqlite.prepare('SELECT * FROM billing_reservations WHERE id=?').get(meta.billingReservationId) as any;
  if (!bill || !['reserved', 'review'].includes(bill.state) || !Number.isFinite(bill.amount) || bill.amount < 0
    || Math.abs(bill.amount - Number(row.cost)) > 0.000001 || !Number.isFinite(Number(row.cost)))
    fail(409, '原预扣已结算、已退款或金额不一致，不能补录结算或重新扣费');
  const context = JSON.parse(bill.context), receipt = JSON.parse(bill.receipt);
  if (context.userId !== row.user_id || Number(context.contentId) !== row.id || context.tokenId || !['user', 'org'].includes(receipt.source))
    fail(409, '原扣款来源或账单归属不一致，停止补录');
  if (receipt.source === 'org' && (!receipt.orgId || !sqlite.prepare('SELECT id FROM organizations WHERE id=?').get(receipt.orgId)))
    fail(409, '原扣款组织不存在，请人工核对');
  return bill;
}

/** Import only an administrator-verified original result. Never submit a generation or deduct funds. */
export async function supplementPidoiImageResults(contentId: number, adminId: number, input: unknown) {
  const { row, meta } = authorize(contentId, adminId);
  if (row.status === 'completed' && row.result_url && meta.pidoiResultSupplement && meta.billingStatus === 'settled')
    return { id: contentId, status: 'completed', alreadyResolved: true, message: '该订单已补录成功，未重复扣费' };
  if (pidoiImageActive.has(contentId)) fail(409, '任务正在提交、查询或保存，请稍后刷新');
  const bill = supplementReservation(row, meta);
  const count = Number(meta.count ?? 1);
  if (!Number.isSafeInteger(count) || count < 1 || count > 10) fail(409, '原任务图片数量异常，请人工核对');
  if (!Array.isArray(input) || input.length !== count || input.some(url => typeof url !== 'string' || url.length > 16384))
    fail(400, `请补录原订单全部 ${count} 张成功图片的链接，每行一条`);
  const sources = (input as string[]).map(value => value.trim());
  for (const source of sources) {
    let url: URL;
    try { url = new URL(source); } catch { fail(400, '请填写有效的 HTTPS 图片链接'); }
    if (url!.protocol !== 'https:' || url!.username || url!.password) fail(400, '图片链接必须为 HTTPS，不能包含账号密码');
  }
  if (new Set(sources).size !== count) fail(400, '图片链接重复，请核对原订单全部图片');
  pidoiImageActive.add(contentId);
  try {
    const saved = await localizeRecoveredImages(sources.map(url => ({ url, channelId: 0, channelApiKeyId: null })), contentId, row.user_id, meta.publicBaseUrl || '');
    if (saved.urls.length !== count || saved.failures?.length || saved.issues.length)
      fail(422, transportDiagnostic('Pidoi', '补录图片下载或保存失败，订单和预扣未变', saved.failures?.[0] || new Error(saved.issues.join('；') || '保存图片数量不足')));
    return sqlite.transaction(() => {
      // Revalidate after network I/O: concurrent refund/reconciliation must never be undone.
      const current = authorize(contentId, adminId);
      supplementReservation(current.row, current.meta);
      if (current.row.metadata !== row.metadata || current.row.user_id !== row.user_id)
        fail(409, '下载期间订单已变更，请刷新后核对');
      const at = new Date().toISOString();
      const completed = finalizeReservedContent(contentId, 'completed', {
        imageUrls: saved.urls, upstreamImageUrls: sources, progresses: sources.map(() => 100),
        pidoiResultSupplement: { adminId, at, count, reservationId: bill.id, amount: bill.amount,
          previousFailureReason: meta.failureReason || null, previousRecoveryPauseReason: meta.pidoiRecoveryPauseReason || null },
        completedAt: at, progressText: '管理员已补录原生成图片，使用原预扣结算，未重复扣费',
        failureReason: null, lastRecoveryError: null, pidoiRecoveryPausedAt: null, pidoiRecoveryPauseReason: null,
        recoveryStage: null,
      }, saved.urls[0]);
      const updated = sqlite.prepare('SELECT status,cost FROM contents WHERE id=?').get(contentId) as any;
      if (!completed || updated.status !== 'completed' || updated.cost !== bill.amount) fail(409, '补录结算未完成，已回滚，请核查原账本');
      return { id: contentId, status: 'completed', alreadyResolved: false, message: '图片已保存，订单已恢复成功，未重复扣费' };
    })();
  } finally { pidoiImageActive.delete(contentId); }
}

/** Explicit operator confirmation, ledger audit and content transition are one transaction.
 * Does not call upstream, resubmit, or allow full refunds for any known successful image. */
export function confirmPidoiImageFailure(contentId: number, adminId: number, confirmed: unknown, note: unknown) {
  if (confirmed !== true || typeof note !== 'string' || note.trim().length < 6 || note.length > 500) fail(400, '请核对上游未成功并填写 6–500 字的核实依据');
  return sqlite.transaction(() => {
    const { row, meta } = authorize(contentId, adminId);
    if (row.status === 'failed' && meta.pidoiFailureResolution && meta.billingStatus === 'refunded')
      return { id: contentId, status: 'failed', refundedAmount: Number(meta.refundAmount) || 0, alreadyResolved: true };
    if (pidoiImageActive.has(contentId)) fail(409, '任务正在提交或恢复，暂不能退款');
    if (row.status !== 'review') fail(409, '只允许处理结果待确认的任务');
    if (row.result_url || meta.imageUrls?.length || meta.upstreamImageUrls?.length
      || meta.pidoiImageJobs?.some((job: any) => job.localUrl || job.sourceUrl || job.status === 'completed'))
      fail(409, '已有成功结果或部分图片成功，请先恢复结果，不能全额退款');
    const bill = meta.billingReservationId && sqlite.prepare('SELECT * FROM billing_reservations WHERE id=?').get(meta.billingReservationId) as any;
    if (!bill || bill.state !== 'review' || !Number.isFinite(bill.amount) || bill.amount < 0 || Math.abs(bill.amount - Number(row.cost)) > 0.000001)
      fail(409, '预扣账本状态或金额不一致，请到异常账单核查');
    const context = JSON.parse(bill.context), receipt = JSON.parse(bill.receipt);
    if (context.userId !== row.user_id || Number(context.contentId) !== contentId || context.tokenId || !['user', 'org'].includes(receipt.source))
      fail(409, '原扣款来源或账单归属不一致，停止退款');
    if (receipt.source === 'org' && (!receipt.orgId || !sqlite.prepare('SELECT id FROM organizations WHERE id=?').get(receipt.orgId)))
      fail(409, '原扣款组织不存在，请人工核对，不能退入其他账户');
    resolveBillingReservation(bill.id, adminId, 0, String(note).trim());
    const at = new Date().toISOString();
    sqlite.prepare("UPDATE contents SET status='failed',cost=0,metadata=? WHERE id=?").run(JSON.stringify({ ...meta,
      billingStatus: 'refunded', refundAmount: bill.amount, refundedAt: at, queueRefunded: true,
      refundTarget: receipt.source === 'org' ? 'organization_balance' : 'user_balance',
      requiresReview: false, failedAt: at, progressText: '管理员核实未成功，已退款', failureReason: '管理员核实未成功，已退回原扣款来源',
      pidoiFailureResolution: { adminId, note: String(note).trim(), at },
    }), contentId);
    return { id: contentId, status: 'failed', refundedAmount: bill.amount, alreadyResolved: false };
  })();
}

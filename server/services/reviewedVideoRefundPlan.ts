import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { videoReviewKind } from '../../shared/videoReview.js';
import { isTaskIdPlaceholder } from '../../shared/upstreamTaskId.js';

type Row = {id:number;user_id:number;type:string;status:string;cost:number;model_id:string;created_at:string;metadata:string;result_url:string|null};
export type RefundPlan = {version:1;createdAt:string;items:Array<{id:number;amount:number;fingerprint:string;blockedReason:string|null}>};
const fingerprint = (row: Row) => createHash('sha256').update(JSON.stringify(row)).digest('hex');
const selectRow = 'SELECT id,user_id,type,status,cost,model_id,created_at,metadata,result_url FROM contents';

function blockReason(database: Database.Database, row: Row): string | null {
  let m: any;
  try { m = JSON.parse(row.metadata); } catch { return '记录信息无法解析'; }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return '记录信息无效';
  if (videoReviewKind(m) !== 'submission') return '不是提交待核实，需按查询或结算流程处理';
  if (m.batchItemId || m.managedSpecification) return '批量或规格独立账本，请在对应入口处理';
  if (['preparing','submitting'].includes(m.videoSubmissionState)) return '提交尚未结束，不能批量退款';
  if (m.recoveryTaskIdSupplemented) return '有手工补录编号，先核验或撤销未核实补录';
  const ids = [m.videoId,m.upstreamTaskId,m.upstream_task_id,m.taskId,m.task_id,m.requestId,m.request_id,
    ...(Array.isArray(m.upstreamTaskIds)?m.upstreamTaskIds:[]),...(Array.isArray(m.recoveryTaskIds)?m.recoveryTaskIds:[])];
  if (ids.some(id => typeof id === 'string' ? id.trim() && !isTaskIdPlaceholder(id) : Boolean(id))) return '已有上游编号，先查询原任务';
  if (database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='video_submission_receipts'").get()) {
    const receipt = database.prepare('SELECT upstream_task_id FROM video_submission_receipts WHERE content_id=?').get(row.id) as any;
    if (receipt && !isTaskIdPlaceholder(receipt.upstream_task_id)) return '已有独立任务回执';
  }
  if (row.result_url || m.upstreamResultUrl || m.recoverySourceUrls?.length || m.upstreamGenerated || m.upstreamStatus === 'completed') return '已有结果或生成成功证据';
  if (m.queueRefunded || ['refunded','settled'].includes(m.billingStatus)) return '已结算或已退款';
  if (!Number.isFinite(row.cost) || row.cost < 0) return '金额无效';
  return null;
}

/** Read-only snapshot, not proof that the upstream did not accept these orders. */
export function previewReviewedVideoRefunds(database: Database.Database): RefundPlan {
  const rows = database.prepare(`${selectRow} WHERE type='video' AND status='review' ORDER BY id`).all() as Row[];
  return {version:1,createdAt:new Date().toISOString(),items:rows.map(row => ({
    id:row.id,amount:row.cost,fingerprint:fingerprint(row),blockedReason:blockReason(database,row),
  }))};
}

export function applyReviewedVideoRefunds(database: Database.Database, plan: RefundPlan, adminId: number,
  confirmedNotAccepted: boolean, refund: (id:number,adminId:number,confirmed:boolean)=>{refundedAmount:number;alreadyResolved:boolean;refundTarget?:string}) {
  if (!confirmedNotAccepted) throw new Error('需要确认清单中的可处理订单上游未接单；待核实状态本身不是依据');
  const admin = database.prepare('SELECT role,is_active FROM users WHERE id=?').get(adminId) as any;
  if (admin?.role !== 'super_admin' || admin.is_active !== 1) throw new Error('请填写有效的超级管理员 ID');
  if (plan?.version !== 1 || !Array.isArray(plan.items) || plan.items.length > 100000
    || new Set(plan.items.map(item=>item.id)).size !== plan.items.length
    || plan.items.some(item=>!Number.isSafeInteger(item.id)||item.id<=0||!/^[a-f0-9]{64}$/.test(item.fingerprint))) throw new Error('退款清单格式无效');
  const results: Array<{id:number;outcome:string;amount?:number;target?:string;reason?:string}> = [];
  for (const item of plan.items) {
    try {
      const result = database.transaction(() => {
        const row = database.prepare(`${selectRow} WHERE id=?`).get(item.id) as Row | undefined;
        if (item.blockedReason) return {id:item.id,outcome:'skipped',reason:item.blockedReason};
        if (!row || row.status !== 'review' || fingerprint(row) !== item.fingerprint)
          return {id:item.id,outcome:'skipped',reason:'订单已变化或已处理，请重新预览'};
        const blocked = blockReason(database,row);
        if (blocked) return {id:item.id,outcome:'skipped',reason:blocked};
        const paid = refund(row.id,adminId,true);
        return {id:row.id,outcome:paid.alreadyResolved?'already_resolved':'refunded',amount:paid.alreadyResolved?0:paid.refundedAmount,target:paid.refundTarget};
      }).immediate();
      results.push(result);
    } catch (error: any) { results.push({id:item.id,outcome:'error',reason:error?.message || '退款事务失败，未完成该笔处理'}); }
  }
  return {results,refundedCount:results.filter(r=>r.outcome==='refunded').length,
    refundedAmount:Number(results.reduce((sum,r)=>sum+(r.amount||0),0).toFixed(6)),
    skippedCount:results.filter(r=>r.outcome==='skipped'||r.outcome==='already_resolved').length,
    errorCount:results.filter(r=>r.outcome==='error').length};
}

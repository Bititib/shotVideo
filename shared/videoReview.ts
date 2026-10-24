import { sanitizedGenerationReason } from './generationErrorPrivacy.js';
export type VideoReviewKind = 'submission' | 'query' | 'settlement' | 'local';

export function videoReviewKind(raw: unknown): VideoReviewKind | null {
  let m: any;
  try { m = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
  if (!m || typeof m !== 'object') return null;
  if (m.requiresReview === false && m.billingStatus !== 'review') return m.upstreamQueryError ? 'query' : null;
  if (['submission', 'query', 'settlement', 'local'].includes(m.reviewKind)) return m.reviewKind;
  if (m.billingShortfall || m.billingStatus === 'review' && m.upstreamStatus === 'completed') return 'settlement';
  if (m.recoveryPollPausedAt || m.upstreamQueryError) return 'query';
  if (m.requiresReview || m.hayaNeedsReview || m.missingTaskIdReview) return 'submission';
  return null;
}

export function videoReviewLabel(raw: unknown): string {
  return ({ submission: '提交待核实', query: '查询异常', settlement: '结算待核实', local: '本地处理异常' })[videoReviewKind(raw) || 'submission'];
}

export function videoReviewMessage(raw: unknown): string {
  let m: any;
  try { m = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch {}
  const guidance = videoReviewKind(raw) === 'settlement' && m?.upstreamStatus === 'failed'
    ? '生成已失败，退款处理待核实；请勿重复提交。' : ({
    submission: '提交结果待核实，请在生成记录核实原任务，请勿重复提交。',
    query: '原任务查询异常，尚未确认生成失败；费用保留，请勿重复提交。',
    settlement: '生成结果已保留，费用结算待核实，请勿重复提交。',
    local: '本地处理异常，原任务和费用已保留，请联系管理员核查。',
  })[videoReviewKind(raw) || 'submission'];
  const value = m?.error || m?.upstreamQueryError || m?.failureReason;
  if (!value) return guidance;
  const detail = sanitizedGenerationReason(value, [m?.channelName, m?.actualChannel].filter((v): v is string => typeof v === 'string'));
  return detail.endsWith(guidance) ? detail : detail + '；' + guidance;
}

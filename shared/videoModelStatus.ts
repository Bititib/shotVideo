export type VideoModelState = 'healthy' | 'degraded' | 'unavailable' | 'unknown';
export type VideoModelStatus = {
  state: VideoModelState;
  reason: 'recent_successes' | 'recent_failures' | 'consecutive_failures' | 'no_channel' | 'insufficient_data' | 'stale_data';
  checkedAt: string;
};

export const VIDEO_MODEL_STATUS_LABELS: Record<VideoModelState, string> = {
  healthy: '正常', degraded: '波动', unavailable: '异常', unknown: '待检测',
};

export const VIDEO_MODEL_STATUS_DETAILS: Record<VideoModelStatus['reason'], string> = {
  recent_successes: '近期生成记录正常，不代表每次生成均能成功',
  recent_failures: '近期生成记录中出现失败，请留意任务结果',
  consecutive_failures: '最近连续三次生成失败，请稍后再试',
  no_channel: '当前没有可用渠道',
  insufficient_data: '近期生成记录不足，暂时无法判断状态',
  stale_data: '状态信息已过期，等待刷新',
};

// Old persisted model lists must not present yesterday's state as current.
export function currentVideoModelStatus(status?: VideoModelStatus, now = Date.now()): VideoModelStatus {
  const checkedAt = Date.parse(status?.checkedAt || '');
  if (status && Object.hasOwn(VIDEO_MODEL_STATUS_LABELS, status.state)
    && Object.hasOwn(VIDEO_MODEL_STATUS_DETAILS, status.reason)
    && Number.isFinite(checkedAt) && checkedAt <= now + 60_000 && now - checkedAt <= 120_000) return status;
  return { state: 'unknown', reason: status ? 'stale_data' : 'insufficient_data', checkedAt: new Date(now).toISOString() };
}

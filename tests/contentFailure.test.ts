import { describe, expect, it } from 'vitest';
import { getContentFailureInfo } from '../client/src/utils/contentFailure.js';

describe('admin content failure details', () => {
  it('reads the persisted video failure reason and timestamp', () => {
    expect(getContentFailureInfo(JSON.stringify({
      error: 'HM Studio rejected the reference image',
      failedAt: '2026-08-29T10:20:00.000Z',
    }))).toEqual({
      message: 'HM Studio rejected the reference image',
      failedAt: '2026-08-29T10:20:00.000Z',
      hasRecordedReason: true,
    });
  });

  it('shows an explicit fallback for legacy failed tasks without an error', () => {
    expect(getContentFailureInfo('{}')).toEqual({
      message: '未记录失败原因（历史任务或上游未返回错误详情）',
      hasRecordedReason: false,
    });
  });

  it('shows where and when a failed task was refunded', () => {
    expect(getContentFailureInfo({
      error: '系统繁忙，请重试',
      billingStatus: 'refunded',
      queueRefunded: true,
      refundAmount: 1.8,
      refundTarget: 'user_balance',
      refundedAt: '2026-08-29T08:13:04.240Z',
    })).toEqual({
      message: '系统繁忙，请重试',
      hasRecordedReason: true,
      billingStatus: 'refunded',
      refunded: true,
      refundAmount: 1.8,
      refundTarget: 'user_balance',
      refundedAt: '2026-08-29T08:13:04.240Z',
    });
  });

  it('extracts a concise reason from an escaped upstream gateway failure', () => {
    const nested = JSON.stringify({
      code: 'fail_to_fetch_task',
      message: JSON.stringify({
        state: 'failed',
        err_code: JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: '生成服务暂时不可用，请稍后重试' } }),
      }),
    });
    expect(getContentFailureInfo({ error: `创建视频任务失败 (400): ${nested}` }).message)
      .toBe('生成服务暂时不可用，请稍后重试');
  });
});

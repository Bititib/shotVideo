import { describe, expect, it } from 'vitest';
import { getContentFailureInfo } from '../client/src/utils/contentFailure.js';

describe('admin content failure details', () => {
  it('shows the evidence retained by legacy V6K review records without inventing the missing 503 response body', () => {
    const detail = getContentFailureInfo({ billingStatus: 'reserved', progressText: '固定待核实提示',
      zonghengSubmissionDiagnostics: { reason: 'http_error', httpStatus: 503, elapsedMs: 1007 } });
    expect(detail.hasRecordedReason).toBe(true);
    expect(detail.message).toContain('HTTP 503');
    expect(detail.message).toContain('1.01 秒');
    expect(detail.message).toContain('原始错误正文未保存');
    expect(detail.message).not.toContain('余额');
  });
  it('redacts saved diagnostic messages and keeps an explicit failure reason authoritative', () => {
    const diagnostic = { message: '503 sk-private-key https://private.invalid/file?sign=secret' };
    const detail = getContentFailureInfo({ zonghengSubmissionDiagnostics: diagnostic });
    expect(detail.message).toContain('503');
    expect(detail.message).not.toContain('sk-private-key');
    expect(detail.message).not.toContain('private.invalid');
    expect(getContentFailureInfo({ error: '确切业务错误', zonghengSubmissionDiagnostics: diagnostic }).message).toBe('确切业务错误');
  });
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

it('shows the failure reason persisted by image generation', () => {
  expect(getContentFailureInfo(JSON.stringify({ failureReason: '图片 #1: 超时' })).message).toBe('图片 #1: 超时');
});

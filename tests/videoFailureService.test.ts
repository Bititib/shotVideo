import { describe, expect, it } from 'vitest';
import {
  clarifyVideoCapacityFailure,
  extractVideoFailureMessage,
  formatVideoPollHttpFailure,
  isVideoFailurePayload,
  isVideoFailureStatus,
  withVideoFailureMetadata,
} from '../server/services/videoFailureService.js';

describe('video failure persistence', () => {
  it('distinguishes an upstream capacity rejection from the local HM queue', () => {
    expect(clarifyVideoCapacityFailure('任务并发数不足', false))
      .toBe('上游渠道当前容量不足，请稍后重试（非本站并发限制）');
    expect(clarifyVideoCapacityFailure('任务并发数不足', true)).toBe('任务并发数不足');
  });

  it('extracts a readable reason from an escaped gateway error', () => {
    const body = JSON.stringify({
      code: 'fail_to_fetch_task',
      message: JSON.stringify({
        state: 'failed',
        err_code: JSON.stringify({
          error: { code: 'SERVICE_UNAVAILABLE', message: '生成服务暂时不可用，请稍后重试' },
        }),
      }),
    });
    expect(extractVideoFailureMessage(body)).toBe('生成服务暂时不可用，请稍后重试');
    expect(extractVideoFailureMessage(`创建视频任务失败 (400): ${body}`))
      .toBe('生成服务暂时不可用，请稍后重试');
  });

  it('preserves task metadata while recording the reason and timestamp', () => {
    expect(withVideoFailureMetadata('{"videoId":"task_1"}', 'upstream timeout', '2026-08-29T10:00:00.000Z')).toEqual({
      videoId: 'task_1',
      error: 'upstream timeout',
      failedAt: '2026-08-29T10:00:00.000Z',
      queueStatus: 'failed',
    });
  });

  it('recognizes terminal failure statuses from different providers', () => {
    for (const status of ['failed', 'failure', 'error', 'rejected', 'cancelled', 'canceled', 'expired']) {
      expect(isVideoFailureStatus(status)).toBe(true);
    }
    expect(isVideoFailureStatus('processing')).toBe(false);
  });

  it('recognizes failures wrapped in a 200 response payload', () => {
    expect(isVideoFailurePayload({ state: 'failed', error: { message: 'generation failed' } })).toBe(true);
    expect(isVideoFailurePayload({ data: { task_status: 'rejected' } })).toBe(true);
    expect(isVideoFailurePayload({ status_code: 429, error: { message: '视频生成失败' } })).toBe(true);
    expect(isVideoFailurePayload({ success: false, message: 'upstream rejected task' })).toBe(true);
    expect(isVideoFailurePayload({ status: 'processing', progress: 70 })).toBe(false);
  });

  it('formats a non-2xx polling response with its nested failure reason', () => {
    const body = JSON.stringify({ error: { message: '视频生成失败，请稍后重试' } });
    expect(formatVideoPollHttpFailure(429, body))
      .toBe('上游任务查询失败 (429): 视频生成失败，请稍后重试');
  });
});

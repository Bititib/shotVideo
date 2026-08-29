import { describe, expect, it } from 'vitest';
import { extractVideoFailureMessage, withVideoFailureMetadata } from '../server/services/videoFailureService.js';

describe('video failure persistence', () => {
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
});

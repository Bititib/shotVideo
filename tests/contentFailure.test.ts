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
});

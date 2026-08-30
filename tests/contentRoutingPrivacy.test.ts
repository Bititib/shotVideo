import { describe, expect, it } from 'vitest';
import { sanitizeContentRoutingForClient } from '../server/services/contentService.js';

describe('content routing privacy', () => {
  it('removes administrator-only failover fields from ordinary string metadata', () => {
    const sanitized = sanitizeContentRoutingForClient({
      id: 1,
      metadata: JSON.stringify({
        model: 'seedance_v2.5',
        actualModel: 'sd2.5',
        actualChannel: 'wx-haidiyue',
        fallbackFrom: 'hmstudio',
        fallbackReason: 'hmstudio_capacity',
        fallbackAt: '2026-08-30T00:00:00.000Z',
        channelId: 12,
        channelApiKeyId: 8,
        upstreamModel: 'sd2.5',
        progressText: '主线路已切换至备用线路',
        seconds: 8,
      }),
    });
    const metadata = JSON.parse(sanitized.metadata);

    expect(metadata).toMatchObject({
      model: 'seedance_v2.5',
      seconds: 8,
      progressText: '视频生成中',
    });
    expect(metadata).not.toHaveProperty('actualModel');
    expect(metadata).not.toHaveProperty('actualChannel');
    expect(metadata).not.toHaveProperty('fallbackFrom');
    expect(metadata).not.toHaveProperty('fallbackReason');
    expect(metadata).not.toHaveProperty('fallbackAt');
    expect(metadata).not.toHaveProperty('channelId');
    expect(metadata).not.toHaveProperty('channelApiKeyId');
    expect(metadata).not.toHaveProperty('upstreamModel');
  });

  it('preserves ordinary generation metadata', () => {
    const sanitized = sanitizeContentRoutingForClient({
      metadata: { model: 'seedance_v2.5', seconds: 10, progressText: '视频生成中 40%' },
    });
    expect(sanitized.metadata).toEqual({
      model: 'seedance_v2.5', seconds: 10, progressText: '视频生成中 40%',
    });
  });
});

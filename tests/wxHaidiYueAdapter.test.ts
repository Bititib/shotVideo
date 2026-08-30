import { describe, expect, it } from 'vitest';
import {
  buildWxHaidiYueVideoPayload,
  normalizeWxHaidiYueTask,
  shouldSendWxHaidiYueAuthorization,
  wxHaidiYueCreateUrl,
  wxHaidiYueTaskUrl,
} from '../server/services/wxHaidiYueAdapter.js';

describe('wx-海底月 sd2.5 adapter', () => {
  it('builds the documented JSON endpoints and request payload', () => {
    expect(wxHaidiYueCreateUrl('https://example.test/v1')).toBe('https://example.test/v1/videos/generations');
    expect(wxHaidiYueTaskUrl('https://example.test', 'request/a')).toBe('https://example.test/v1/videos/generations/request%2Fa');
    expect(buildWxHaidiYueVideoPayload({
      prompt: 'test',
      duration: 8,
      aspectRatio: '16:9',
      images: ['https://cdn.test/a.jpg', 'data:image/png;base64,AAAA'],
    })).toEqual({
      model: 'sd2.5',
      prompt: 'test',
      duration: 8,
      aspect_ratio: '16:9',
      images: ['https://cdn.test/a.jpg', 'data:image/png;base64,AAAA'],
    });
  });

  it('normalizes pending, done, and failed tasks', () => {
    expect(normalizeWxHaidiYueTask({ status: 'pending' }, 'https://example.test/v1')).toMatchObject({
      status: 'pending', progress: 0,
    });
    expect(normalizeWxHaidiYueTask({
      status: 'done',
      video: { url: '/v1/videos/request-1/content' },
    }, 'https://example.test/v1')).toMatchObject({
      status: 'completed',
      progress: 100,
      resultUrl: 'https://example.test/v1/videos/request-1/content',
    });
    expect(normalizeWxHaidiYueTask({
      status: 'failed',
      error: { code: 'VIDEO_NOT_STARTED', message: 'not started' },
    }, 'https://example.test/v1')).toMatchObject({
      status: 'failed', error: 'not started', errorCode: 'VIDEO_NOT_STARTED',
    });
  });

  it('never forwards the API key to a signed third-party URL', () => {
    expect(shouldSendWxHaidiYueAuthorization('/v1/videos/a/content', 'https://example.test/v1')).toBe(true);
    expect(shouldSendWxHaidiYueAuthorization('https://cdn.test/signed.mp4?token=x', 'https://example.test/v1')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import {
  buildWxHaidiYueVideoPayload,
  normalizeWxHaidiYueFaceSplit,
  normalizeWxHaidiYueTask,
  resolveWxHaidiYueFaceSplit,
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
      face_split: true,
    });
  });

  it('normalizes the documented face_split values without treating "false" as truthy', () => {
    for (const enabled of [true, 1, 'true', '1']) {
      expect(normalizeWxHaidiYueFaceSplit(enabled)).toBe(true);
    }
    for (const disabled of [undefined, false, 0, 'false', '0', 'yes', null]) {
      expect(normalizeWxHaidiYueFaceSplit(disabled)).toBe(false);
    }
    expect(buildWxHaidiYueVideoPayload({
      prompt: 'test',
      duration: 5,
      aspectRatio: '16:9',
      faceSplit: 'false',
    })).toMatchObject({ face_split: false });
  });

  it('uses the channel switch as the default and lets an explicit request value override it', () => {
    expect(resolveWxHaidiYueFaceSplit({ faceSplitEnabled: 1 })).toBe(true);
    expect(resolveWxHaidiYueFaceSplit({ faceSplitEnabled: 0 })).toBe(false);
    expect(resolveWxHaidiYueFaceSplit(undefined)).toBe(true);
    expect(resolveWxHaidiYueFaceSplit({ faceSplitEnabled: 0 }, true)).toBe(true);
    expect(resolveWxHaidiYueFaceSplit({ faceSplitEnabled: 1 }, 'false')).toBe(false);
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

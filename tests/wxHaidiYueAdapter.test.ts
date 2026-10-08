import { describe, expect, it } from 'vitest';
import {
  buildWxHaidiYueVideoPayload,
  normalizeWxHaidiYueFaceSplit,
  normalizeWxHaidiYueTask,
  resolveWxHaidiYueFaceSplit,
  shouldSendWxHaidiYueAuthorization,
  validateWxHaidiYueVideoInput,
  WX_HAIDIYUE_MULTIMODAL_MODEL,
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

  it('sends the new multimodal model and all supported reference media', () => {
    expect(buildWxHaidiYueVideoPayload({
      model: WX_HAIDIYUE_MULTIMODAL_MODEL,
      prompt: 'multimodal test',
      duration: 30,
      aspectRatio: '9:16',
      images: ['https://cdn.test/a.jpg'],
      videos: ['https://cdn.test/a.mp4'],
      audios: ['https://cdn.test/a.wav'],
      faceSplit: false,
    })).toEqual({
      model: '2.5-s',
      prompt: 'multimodal test',
      duration: 30,
      aspect_ratio: '9:16',
      image: 'https://cdn.test/a.jpg',
      videos: ['https://cdn.test/a.mp4'],
      audios: ['https://cdn.test/a.wav'],
      face_split: false,
    });
  });

  it('enforces the 2.5-s 30-image, 10-video, 10-audio and 30-second limits', () => {
    const valid = {
      seconds: 30,
      resolution: '720p',
      ratio: '16:9',
      imageCount: 30,
      videoCount: 10,
      audioCount: 10,
    };
    expect(validateWxHaidiYueVideoInput(WX_HAIDIYUE_MULTIMODAL_MODEL, valid)).toBeNull();
    expect(validateWxHaidiYueVideoInput(WX_HAIDIYUE_MULTIMODAL_MODEL, { ...valid, seconds: 29 })).toContain('只支持30秒');
    expect(validateWxHaidiYueVideoInput(WX_HAIDIYUE_MULTIMODAL_MODEL, { ...valid, imageCount: 31 })).toContain('最多支持30张');
    expect(validateWxHaidiYueVideoInput(WX_HAIDIYUE_MULTIMODAL_MODEL, { ...valid, videoCount: 11 })).toContain('最多支持10个参考视频');
    expect(validateWxHaidiYueVideoInput(WX_HAIDIYUE_MULTIMODAL_MODEL, { ...valid, audioCount: 11 })).toContain('最多支持10段参考音频');
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

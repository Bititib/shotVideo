import { describe, expect, it } from 'vitest';
import {
  buildLongxiaVideoPayload, isLongxiaChannel, LONGXIA_MODELS, longxiaResolution,
  longxiaVideoCreateUrl, longxiaVideoTaskUrl, normalizeLongxiaVideoTask,
} from '../server/services/longxiaVideoAdapter.js';

const input = { model: LONGXIA_MODELS[0], prompt: '日出', seconds: 8, ratio: '16:9', resolution: '480p' };
describe('LongXia video contract', () => {
  it.each(LONGXIA_MODELS)('serializes only accepted fields for %s', model => {
    expect(buildLongxiaVideoPayload({ ...input, model, resolution: longxiaResolution(model) })).toEqual({
      model, prompt: '日出', duration: 8, size: '16:9',
    });
  });
  it('converts UI references, preserving image 1 versus image 10 and per-category numbering', () => {
    const result = buildLongxiaVideoPayload({ ...input,
      prompt: '让[ref_9.jpg]和[ref_0.jpg]跟随[ref_audio_1]，模仿[ref_video_1]',
      imageUrls: Array(10).fill('https://example.com/image.jpg'),
      audioUrls: ['data:audio/mpeg;base64,SUQz'], videoUrls: ['https://example.com/video.mp4'],
    });
    expect(result.prompt).toContain('让@image10和@image1跟随@audio1，模仿@video1');
    for (let n = 1; n <= 10; n++) expect(result.prompt).toContain('@image' + n);
    expect(result.assets?.at(-1)).toEqual({ category: 'audio', data_base64: 'SUQz' });
    expect(result.assets?.[10]).toEqual({ category: 'video', url: 'https://example.com/video.mp4' });
  });
  it.each([4, 25])('accepts the duration boundary %s and all 50 reference assets', seconds => {
    const result = buildLongxiaVideoPayload({ ...input, seconds,
      imageUrls: Array(30).fill('https://example.com/image.jpg'),
      videoUrls: Array(10).fill('https://example.com/video.mp4'), audioUrls: Array(10).fill('https://example.com/audio.mp3'),
    });
    expect(result.assets).toHaveLength(50);
    expect(result.prompt).toContain('@image30');
    expect(result.prompt).toContain('@video10');
    expect(result.prompt).toContain('@audio10');
  });
  it.each([3, 26, 4.5, NaN])('rejects invalid duration %s', seconds => {
    expect(() => buildLongxiaVideoPayload({ ...input, seconds })).toThrow('4～25');
  });
  it.each([['imageUrls', 31], ['videoUrls', 11], ['audioUrls', 11]] as const)('rejects excessive %s', (field, count) => {
    expect(() => buildLongxiaVideoPayload({ ...input, [field]: Array(count).fill('https://example.com/file') })).toThrow('最多');
  });
  it('rejects mismatched resolution, unsupported media, invalid references and excess prompt length', () => {
    expect(() => buildLongxiaVideoPayload({ ...input, resolution: '720p' })).toThrow('480p');
    expect(() => buildLongxiaVideoPayload({ ...input, audioUrls: ['data:audio/wav;base64,AAAA'] })).toThrow('MP3');
    expect(() => buildLongxiaVideoPayload({ ...input, imageUrls: ['http://example.com/i.jpg'] })).toThrow('HTTPS');
    expect(() => buildLongxiaVideoPayload({ ...input, prompt: '@image2', imageUrls: ['https://example.com/i.jpg'] })).toThrow('不存在');
    expect(() => buildLongxiaVideoPayload({ ...input, prompt: '字'.repeat(9501) })).toThrow('9500');
    expect(() => buildLongxiaVideoPayload({ ...input, firstFrame: 'https://example.com/i.jpg' })).toThrow('首尾帧');
  });
  it('normalizes task URLs and detects only the configured channel or exact host', () => {
    expect(longxiaVideoCreateUrl('https://api8.longxiaai.store/v1/')).toBe('https://api8.longxiaai.store/v1/videos');
    expect(longxiaVideoTaskUrl('https://api8.longxiaai.store', 'task/1')).toMatch(/task%2F1$/);
    expect(isLongxiaChannel({ baseUrl: 'https://api8.longxiaai.store' })).toBe(true);
    expect(isLongxiaChannel({ type: 'longxia', baseUrl: 'https://proxy.example' })).toBe(true);
    expect(isLongxiaChannel({ baseUrl: 'https://api8.longxiaai.store.example' })).toBe(false);
  });
  it('reads data[].url and maps cancellation to the existing failure/refund path', () => {
    expect(normalizeLongxiaVideoTask({ status: 'completed', data: [{ media_type: 'video/mp4', url: 'https://media.longxiaai.store/result.mp4' }] })).toMatchObject({
      status: 'completed', progress: 100, resultUrl: 'https://media.longxiaai.store/result.mp4',
    });
    expect(normalizeLongxiaVideoTask({ status: 'cancelled' })).toMatchObject({ status: 'failed', error: 'LongXia 任务已取消' });
    expect(normalizeLongxiaVideoTask({ status: 'failed', error: { code: 'invalid_media', message: 'invalid MP3' } })).toMatchObject({ status: 'failed', error: 'invalid MP3' });
    expect(normalizeLongxiaVideoTask({ status: 'completed', data: [] }).resultUrl).toBe('');
  });
});

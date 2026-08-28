import { describe, expect, it } from 'vitest';
import {
  buildMjNewApiVideoPayload,
  findInvalidMjNewApiMaterialUrls,
  isMjNewApiChannel,
  normalizeMjNewApiPrompt,
} from '../server/services/mjNewApiAdapter.js';

describe('MJNewAPI video adapter', () => {
  it('detects only the configured MJNewAPI host', () => {
    expect(isMjNewApiChannel({ baseUrl: 'https://mjnewapi.diwdiw.cn/' })).toBe(true);
    expect(isMjNewApiChannel({ baseUrl: 'https://example.com' })).toBe(false);
    expect(isMjNewApiChannel({ baseUrl: 'not-a-url' })).toBe(false);
  });

  it('uses the documented JSON material fields', () => {
    const payload = buildMjNewApiVideoPayload({
      model: 'ad-seedance-2.5-480p',
      prompt: '保持[ref_0.jpg]人物，参考[ref_video_1]和[ref_audio_1]',
      duration: 5,
      aspectRatio: '16:9',
      resolution: '480p',
      images: ['https://cdn.example.com/image.png'],
      videos: ['https://cdn.example.com/video.mp4'],
      audios: ['https://cdn.example.com/audio.mp3'],
    });

    expect(payload).toEqual({
      model: 'ad-seedance-2.5-480p',
      prompt: '保持@Image1人物，参考@Video1和@Audio1',
      duration: 5,
      aspect_ratio: '16:9',
      resolution: '480p',
      images: ['https://cdn.example.com/image.png'],
      videos: ['https://cdn.example.com/video.mp4'],
      audios: ['https://cdn.example.com/audio.mp3'],
    });
    expect(payload).not.toHaveProperty('image_refs');
    expect(payload).not.toHaveProperty('video_refs');
    expect(payload).not.toHaveProperty('audio_refs');
  });

  it('normalizes all supported reference placeholders', () => {
    expect(normalizeMjNewApiPrompt('[ref_1.png] [ref_video] [ref_audio_2]'))
      .toBe('@Image2 @Video1 @Audio2');
  });

  it('rejects non-public or non-HTTPS material URLs', () => {
    expect(findInvalidMjNewApiMaterialUrls(
      ['https://cdn.example.com/a.png'],
      ['http://cdn.example.com/a.mp4', 'https://127.0.0.1/a.mp4'],
      ['https://localhost/a.mp3'],
    )).toEqual([
      'http://cdn.example.com/a.mp4',
      'https://127.0.0.1/a.mp4',
      'https://localhost/a.mp3',
    ]);
  });
});

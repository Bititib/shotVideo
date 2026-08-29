import { describe, expect, it } from 'vitest';
import {
  buildNewTokenVideoPayload,
  isNewTokenChannel,
  isNewTokenVideoModel,
  newTokenVideoCreateUrl,
} from '../server/services/newTokenAdapter.js';

describe('NewToken video adapter', () => {
  it('identifies only the NewToken channel and its four routed models', () => {
    expect(isNewTokenChannel({ name: 'NewToken 渠道', baseUrl: 'https://newtoken.club/' })).toBe(true);
    expect(isNewTokenChannel({ name: 'SudaShui 星河渠道', baseUrl: 'https://api.sudashuiapi.com' })).toBe(false);
    expect(isNewTokenVideoModel('veo-omni-flash')).toBe(true);
    expect(isNewTokenVideoModel('veo-omni-flash-video-edit')).toBe(true);
    expect(isNewTokenVideoModel('nd-seedance-2.0-720p')).toBe(true);
    expect(isNewTokenVideoModel('sdas-bl-sd2.0-933-pro-720p')).toBe(false);
    expect(newTokenVideoCreateUrl('https://newtoken.club/')).toBe('https://newtoken.club/v1/videos');
  });

  it('builds the Veo Omni payload for POST /v1/videos', () => {
    expect(buildNewTokenVideoPayload({
      model: 'veo-omni-flash',
      prompt: 'test',
      duration: 4,
      aspectRatio: '9:16',
      images: ['https://example.com/a.png'],
    })).toEqual({
      model: 'veo-omni-flash',
      prompt: 'test',
      duration: 10,
      aspect_ratio: '9:16',
      Ingredients_images: ['https://example.com/a.png'],
    });
  });

  it('builds the Veo 3-1 payload with fixed duration and frame fields', () => {
    expect(buildNewTokenVideoPayload({
      model: 'veo-3-1',
      prompt: 'test',
      duration: 4,
      aspectRatio: '16:9',
      images: ['https://example.com/a.png'],
      firstFrame: 'https://example.com/first.png',
      lastFrame: 'https://example.com/last.png',
    })).toMatchObject({
      duration: 8,
      reference_images: ['https://example.com/a.png'],
      first_frame_image: 'https://example.com/first.png',
      last_frame_image: 'https://example.com/last.png',
    });
  });

  it('builds the Veo Omni video edit payload required by NewToken', () => {
    expect(buildNewTokenVideoPayload({
      model: 'veo-omni-flash-video-edit',
      prompt: 'make it brighter',
      duration: 10,
      aspectRatio: '16:9',
      videos: ['https://example.com/reference.mp4'],
      images: ['https://example.com/product.png'],
    })).toEqual({
      model: 'veo-omni-flash-video-edit',
      prompt: 'make it brighter',
      duration: 10,
      aspect_ratio: '16:9',
      video_url: 'https://example.com/reference.mp4',
      Ingredients_images: ['https://example.com/product.png'],
    });
  });

  it('maps nd-seedance references to the NewToken JSON schema', () => {
    expect(buildNewTokenVideoPayload({
      model: 'nd-seedance-2.0-720p',
      upstreamModel: 'nd-seedance-2.0 720p',
      prompt: '[ref_0] walks with [ref_video_1] and [ref_audio_1]',
      duration: 4,
      aspectRatio: '16:9',
      images: ['https://example.com/a.png'],
      videos: ['https://example.com/a.mp4'],
      audios: ['https://example.com/a.wav'],
    })).toEqual({
      model: 'nd-seedance-2.0 720p',
      prompt: '@Image1 walks with @Video1 and @Audio1',
      duration: 4,
      aspect_ratio: '16:9',
      image_refs: ['https://example.com/a.png'],
      video_refs: ['https://example.com/a.mp4'],
      audio_refs: ['https://example.com/a.wav'],
    });
  });
});

import { describe, expect, it } from 'vitest';
import {
  buildSudaShuiVideoPayload,
  normalizeSudaShuiPrompt,
  sudaShuiVideoCreateUrl,
} from '../server/services/sudaShuiAdapter.js';

describe('SudaShui video adapter', () => {
  it('maps our user-facing reference placeholders to provider placeholders', () => {
    expect(normalizeSudaShuiPrompt(
      '[ref_0.jpg] 和 [ref_1.png] 使用 [ref_audio_1]，然后查看 [ref_video_2]',
    )).toBe('@image1 和 @image2 使用 @audio1，然后查看 @video2');
  });

  it('builds the documented nested H3 request body', () => {
    const payload = buildSudaShuiVideoPayload({
      model: 'sdas-mj-minimax-h3-2k',
      prompt: '@image1 和@image2 走在校园的操场上，@image2 用@audio1 的声音说 你好帅啊 鬼哥',
      duration: 12,
      aspectRatio: '16:9',
      imageUrls: [
        'https://files2.sudashuiapi.com/ceshi/004.jpg',
        'https://files2.sudashuiapi.com/ceshi/20260827-232002.png',
      ],
      audioUrls: ['https://files2.sudashuiapi.com/ceshi/test.WAV'],
    });

    expect(payload).toEqual({
      model: 'sdas-mj-minimax-h3-2k',
      prompt: '@image1 和@image2 走在校园的操场上，@image2 用@audio1 的声音说 你好帅啊 鬼哥',
      duration: 12,
      metadata: {
        payload: JSON.stringify({
          aspectRatio: '16:9',
          mode: 'references',
          imageUrls: [
            'https://files2.sudashuiapi.com/ceshi/004.jpg',
            'https://files2.sudashuiapi.com/ceshi/20260827-232002.png',
          ],
          audioUrls: ['https://files2.sudashuiapi.com/ceshi/test.WAV'],
        }),
      },
    });
  });

  it('omits empty material arrays and normalizes the create URL', () => {
    const payload = buildSudaShuiVideoPayload({
      model: 'sdas-mj-minimax-h3-2k',
      prompt: ' text only ',
      duration: 4,
      aspectRatio: '9:16',
      imageUrls: ['', '  '],
    });
    expect(JSON.parse((payload.metadata as { payload: string }).payload)).toEqual({
      aspectRatio: '9:16',
      mode: 'references',
    });
    expect(sudaShuiVideoCreateUrl('https://api.sudashuiapi.com/')).toBe(
      'https://api.sudashuiapi.com/v1/video/generations',
    );
  });
});

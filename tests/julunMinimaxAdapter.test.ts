import { describe, expect, it } from 'vitest';
import {
  buildJulunMinimaxH3Payload,
  buildJulunSd25Payload,
  isJulunChannel,
  isJulunMinimaxH3Model,
  JULUN_MINIMAX_H3_MODEL,
} from '../server/services/julunMinimaxAdapter.js';

describe('Julun MiniMax H3 768p adapter', () => {
  it('recognizes only the exact upstream model ID', () => {
    expect(isJulunMinimaxH3Model(JULUN_MINIMAX_H3_MODEL)).toBe(true);
    expect(isJulunMinimaxH3Model(JULUN_MINIMAX_H3_MODEL.toLowerCase())).toBe(false);
  });

  it('builds the Julun sd2.5 fallback payload', () => {
    expect(isJulunChannel({ baseUrl: 'https://julun.cc' })).toBe(true);
    expect(buildJulunSd25Payload({
      prompt: 'test',
      ratio: '16:9',
      imageUrls: ['https://assets.example/1.jpg'],
    })).toEqual({
      model: 'sd2.5',
      prompt: 'test',
      seconds: 30,
      ratio: '16:9',
      resolution: '720p',
      image_urls: ['https://assets.example/1.jpg'],
    });
  });

  it('builds a fixed 768p payload and preserves 933 reference limits', () => {
    const payload = buildJulunMinimaxH3Payload({
      prompt: 'cinematic shot',
      seconds: 15,
      ratio: '16:9',
      imageUrls: Array.from({ length: 11 }, (_, i) => `https://cdn.example.com/i${i}.png`),
      videoUrls: Array.from({ length: 4 }, (_, i) => `https://cdn.example.com/v${i}.mp4`),
      audioUrls: Array.from({ length: 4 }, (_, i) => `https://cdn.example.com/a${i}.wav`),
    });
    expect(payload).toMatchObject({
      model: JULUN_MINIMAX_H3_MODEL,
      prompt: 'cinematic shot',
      seconds: 15,
      ratio: '16:9',
      resolution: '768p',
    });
    expect(payload.image_urls).toHaveLength(9);
    expect(payload.video_urls).toHaveLength(3);
    expect(payload.audio_urls).toHaveLength(3);
  });
});

import { describe, expect, it } from 'vitest';
import {
  buildSnumomWanPayload,
  isSnumomWanChannel,
  normalizeSnumomWanTask,
  SNUMOM_GROK_IMAGINE_VIDEO_MAX_IMAGES,
  SNUMOM_GROK_IMAGINE_VIDEO_MODEL,
  SNUMOM_GROK_IMAGINE_VIDEO_SECONDS,
  SNUMOM_SD_MINI_MAX_IMAGES,
  SNUMOM_SD_MINI_MAX_VIDEOS,
  SNUMOM_SD_MINI_MAX_AUDIOS,
  SNUMOM_SD_MINI_MODEL,
  SNUMOM_VIDEO_MODELS,
  snumomSdMiniSecondsForResolution,
  snumomContentUrl,
} from '../server/services/snumomWanAdapter.js';

describe('snumom Wan 3.0 adapter', () => {
  it('declares the Grok per-request model and its advertised limits', () => {
    expect(SNUMOM_GROK_IMAGINE_VIDEO_MODEL).toBe('grok-imagine-video-1.5（按次）');
    expect(SNUMOM_VIDEO_MODELS).toEqual([
      'wan3.0-video',
      'wan3.0-video-prime',
      SNUMOM_GROK_IMAGINE_VIDEO_MODEL,
      SNUMOM_SD_MINI_MODEL,
    ]);
    expect(SNUMOM_GROK_IMAGINE_VIDEO_SECONDS).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(SNUMOM_GROK_IMAGINE_VIDEO_MAX_IMAGES).toBe(7);
  });

  it('declares sd-mini and its exact resolution-duration pairs', () => {
    expect(SNUMOM_SD_MINI_MODEL).toBe('sd-mini');
    expect(SNUMOM_SD_MINI_MAX_IMAGES).toBe(9);
    expect(SNUMOM_SD_MINI_MAX_VIDEOS).toBe(3);
    expect(SNUMOM_SD_MINI_MAX_AUDIOS).toBe(3);
    expect(snumomSdMiniSecondsForResolution('480p')).toBe(15);
    expect(snumomSdMiniSecondsForResolution('720P')).toBe(10);
    expect(snumomSdMiniSecondsForResolution('1080p')).toBeNull();
  });

  it('passes sd-mini image, video and audio references through the snumom payload', () => {
    expect(buildSnumomWanPayload({
      model: SNUMOM_SD_MINI_MODEL,
      prompt: '人物自然走动',
      seconds: 10,
      resolution: '720p',
      aspectRatio: '9:16',
      images: [{ url: 'https://cdn.example.com/ref.jpg', role: 'reference_image' }],
      videos: [{ url: 'https://cdn.example.com/ref.mp4' }],
      audios: [{ url: 'https://cdn.example.com/ref.mp3' }],
    })).toMatchObject({
      model: 'sd-mini',
      seconds: 10,
      size: '720P',
      reference_images: [{ url: 'https://cdn.example.com/ref.jpg', role: 'reference_image' }],
      reference_videos: [{ url: 'https://cdn.example.com/ref.mp4' }],
      reference_audios: [{ url: 'https://cdn.example.com/ref.mp3' }],
    });
  });

  it('detects the dedicated channel type or documented host', () => {
    expect(isSnumomWanChannel({ type: 'snumom', baseUrl: 'https://proxy.example.com' })).toBe(true);
    expect(isSnumomWanChannel({ baseUrl: 'https://snumom.com/' })).toBe(true);
    expect(isSnumomWanChannel({ baseUrl: 'https://example.com' })).toBe(false);
  });

  it('builds the documented flat payload', () => {
    expect(buildSnumomWanPayload({
      model: 'wan3.0-video', prompt: ' 图1人物自然走动 ', seconds: 10,
      resolution: '720p', aspectRatio: '9:16',
      images: [{ url: 'https://cdn.example.com/a.jpg', role: 'reference_image' }],
      videos: [{ url: 'https://cdn.example.com/a.mp4', duration: 5 }],
      audios: [{ url: 'https://cdn.example.com/a.mp3' }],
    })).toEqual({
      model: 'wan3.0-video', prompt: '图1人物自然走动', seconds: 10,
      size: '720P', aspect_ratio: '9:16',
      reference_images: [{ url: 'https://cdn.example.com/a.jpg', role: 'reference_image' }],
      reference_videos: [{ url: 'https://cdn.example.com/a.mp4', duration: 5 }],
      reference_audios: [{ url: 'https://cdn.example.com/a.mp3' }],
    });
  });

  it('reads metadata.url and builds the documented content URL', () => {
    expect(normalizeSnumomWanTask({
      id: 'task_1', status: 'completed', progress: 100, metadata: { url: 'https://oss.example.com/a.mp4' },
    })).toMatchObject({ id: 'task_1', status: 'completed', progress: 100, resultUrl: 'https://oss.example.com/a.mp4' });
    expect(snumomContentUrl('https://snumom.com/', 'task/1')).toBe('https://snumom.com/v1/videos/task%2F1/content');
  });

  it('passes the exact Grok model ID through the snumom JSON payload', () => {
    expect(buildSnumomWanPayload({
      model: SNUMOM_GROK_IMAGINE_VIDEO_MODEL,
      prompt: '镜头缓慢推进',
      seconds: 15,
      resolution: '720p',
      aspectRatio: '16:9',
      images: [{ url: 'https://cdn.example.com/reference.jpg', role: 'reference_image' }],
    })).toMatchObject({
      model: 'grok-imagine-video-1.5（按次）',
      seconds: 15,
      size: '720P',
      reference_images: [{ url: 'https://cdn.example.com/reference.jpg', role: 'reference_image' }],
    });
  });
});

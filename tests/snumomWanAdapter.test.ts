import { describe, expect, it } from 'vitest';
import {
  buildSnumomWanPayload,
  isSnumomWanChannel,
  normalizeSnumomWanTask,
  snumomContentUrl,
} from '../server/services/snumomWanAdapter.js';

describe('snumom Wan 3.0 adapter', () => {
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
});

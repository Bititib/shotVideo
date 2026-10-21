import { describe, expect, it } from 'vitest';
import {
  buildSnumomWanPayload,
  canonicalSnumomVideoModel,
  isSnumomWanChannel,
  normalizeSnumomWanTask,
  extractSnumomTaskId,
  normalizeSnumomWanInputMedia,
  extractSnumomWanBillingUsage,
  SNUMOM_GROK_IMAGINE_VIDEO_MAX_IMAGES,
  SNUMOM_GROK_IMAGINE_VIDEO_MODEL,
  SNUMOM_GROK_IMAGINE_VIDEO_SECONDS,
  SNUMOM_SD_MINI_MAX_IMAGES,
  SNUMOM_SD_MINI_MAX_VIDEOS,
  SNUMOM_SD_MINI_MAX_AUDIOS,
  SNUMOM_SD_MINI_MODEL,
  SNUMOM_VIDEO_MODELS,
  snumomSdMiniSecondsForResolution,
  snumomWanBillableSeconds,
  snumomContentUrl,
} from '../server/services/snumomWanAdapter.js';
import { roundUpVideoDurationTenths } from '../server/services/videoDurationProbe.js';

describe('snumom Wan 3.0 adapter', () => {
  it('passes smart duration, prompt extension and file/link parameters', () => {
    const payload = buildSnumomWanPayload({ model: 'wan3.0-video', prompt: 'test', seconds: 5,
      resolution: '720p', aspectRatio: '16:9', smartDuration: true, promptExtend: false,
      videos: [{ url: 'https://example.com/ref.mp4' }],
      inputMedia: [{ type: 'link', url: 'https://example.com/article' }] });
    expect(payload).toMatchObject({ parameters: { duration: -1, prompt_extend: false },
      input: { media: [{ type: 'link', url: 'https://example.com/article' }] } });
    expect(payload).not.toHaveProperty('seconds');
  });
  it('validates file/link input and rejects invalid types, local URLs and multiple files', () => {
    expect(normalizeSnumomWanInputMedia([{ type: 'file', url: 'https://example.com/a.pdf' }]))
      .toEqual([{ type: 'file', url: 'https://example.com/a.pdf' }]);
    expect(() => normalizeSnumomWanInputMedia([{ type: 'other', url: 'https://example.com' }])).toThrow();
    expect(() => normalizeSnumomWanInputMedia([{ type: 'file', url: 'http://127.0.0.1/a' }])).toThrow();
    expect(() => normalizeSnumomWanInputMedia([{ type: 'link', url: 'https://example.com' }, { type: 'link', url: 'https://example.com/b' }])).toThrow();
  });
  it('forces adaptive only for WAN first/last-frame requests, not Grok', () => {
    const input = { prompt: 'test', seconds: 5, resolution: '720p', aspectRatio: '16:9',
      images: [{ url: 'https://example.com/a.jpg', role: 'first_frame' as const }] };
    expect(buildSnumomWanPayload({ ...input, model: 'wan3.0-video' })).toMatchObject({ aspect_ratio: 'adaptive' });
    expect(buildSnumomWanPayload({ ...input, model: 'grok-imagine-video-1.5' })).toMatchObject({ aspect_ratio: '16:9' });
  });
  it('uses explicit usage only and preserves known reference seconds when omitted upstream', () => {
    expect(extractSnumomWanBillingUsage({ metadata: { usage: { output_seconds: 10, reference_video_seconds: 5.2, resolution: '720P' } } }))
      .toMatchObject({ billableSeconds: 15.2, resolution: '720p' });
    expect(extractSnumomWanBillingUsage({ usage: { output_seconds: 8 } }, 5.2)).toMatchObject({ billableSeconds: 13.2 });
    expect(extractSnumomWanBillingUsage({ usage: { billable_seconds: '12.5', output_seconds: 8 } }, 5.2))
      .toMatchObject({ billableSeconds: 12.5 });
    expect(extractSnumomWanBillingUsage({ progress: 30, duration: 10 })).toBeNull();
    for (const value of [null, false, '', ' ', -1, {}, 'NaN']) {
      expect(extractSnumomWanBillingUsage({ usage: { billable_seconds: value } })).toBeNull();
    }
  });
  it('declares the Grok per-request model and its advertised limits', () => {
    expect(SNUMOM_GROK_IMAGINE_VIDEO_MODEL).toBe('grok-imagine-video-1.5');
    expect(SNUMOM_VIDEO_MODELS).toEqual([
      'wan3.0-video',
      'wan3.0-video-prime',
      SNUMOM_GROK_IMAGINE_VIDEO_MODEL,
      SNUMOM_SD_MINI_MODEL,
    ]);
    expect(SNUMOM_GROK_IMAGINE_VIDEO_SECONDS).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
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
      seconds: '10',
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
      model: 'wan3.0-video', prompt: '图1人物自然走动', seconds: '10',
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

  it('accepts only documented snumom task IDs and never a request trace ID', () => {
    expect(extractSnumomTaskId({ request_id: 'task_trace', id: 'task_real' })).toBe('task_real');
    expect(extractSnumomTaskId({ request_id: 'task_trace' })).toBe('');
    expect(extractSnumomTaskId({ task_id: 'not-a-task' })).toBe('');
    expect(extractSnumomTaskId({}, new Headers({ location: '/v1/videos/task_location' }))).toBe('task_location');
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
      model: 'grok-imagine-video-1.5',
      seconds: '15',
      size: '720P',
      reference_images: [{ url: 'https://cdn.example.com/reference.jpg', role: 'reference_image' }],
    });
    expect(canonicalSnumomVideoModel('grok-imagine-video-1.5（按次）')).toBe('grok-imagine-video-1.5');
  });

  it('adds probed reference-video duration only for Wan 3.0 video models', () => {
    expect(snumomWanBillableSeconds('wan3.0-video', 10, 5.25)).toBe(15.25);
    expect(snumomWanBillableSeconds('wan3.0-video-prime', 10, 3)).toBe(13);
    expect(snumomWanBillableSeconds(SNUMOM_GROK_IMAGINE_VIDEO_MODEL, 10, 5)).toBe(10);
  });

  it('rounds every reference video up to one tenth of a second', () => {
    expect(roundUpVideoDurationTenths(5)).toBe(5);
    expect(roundUpVideoDurationTenths(5.001)).toBe(5.1);
    expect(roundUpVideoDurationTenths(5.19)).toBe(5.2);
  });
});

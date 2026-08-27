import { describe, expect, it } from 'vitest';
import {
  buildHmStudioImageForm,
  buildHmStudioVideoForm,
  hmStudioCreateUrl,
  hmStudioTaskUrl,
  normalizeHmStudioTask,
} from '../server/services/hmStudioAdapter.js';

describe('HM Studio adapter', () => {
  it('uses the documented create and task endpoints', () => {
    expect(hmStudioCreateUrl('https://example.test/', 'video')).toBe('https://example.test/v1/videos/generations');
    expect(hmStudioCreateUrl('https://example.test', 'image')).toBe('https://example.test/v1/images/generations');
    expect(hmStudioTaskUrl('https://example.test/', 'task/id')).toBe('https://example.test/v1/tasks/task%2Fid');
  });

  it('maps ordinary video fields and a single reference image', () => {
    const form = buildHmStudioVideoForm({
      model: 'HM-Video-SD1.5Pro',
      prompt: '让画面动起来',
      duration: 8,
      ratio: '16:9',
      resolution: '1080p',
      imageSources: ['https://cdn.example.test/start.jpg'],
    });

    expect(form.get('duration')).toBe('8');
    expect(form.get('ratio')).toBe('16:9');
    expect(form.get('video_resolution')).toBe('1080p');
    expect(form.get('function_mode')).toBe('first_last_frames');
    expect(form.get('first_frame_url')).toBe('https://cdn.example.test/start.jpg');
  });

  it('maps multimodal SD2 references to omni materials', () => {
    const form = buildHmStudioVideoForm({
      model: 'HM-Video-SD2.0',
      prompt: '[ref_1] 听着 [ref_audio_1] 走过街道',
      duration: 10,
      ratio: '9:16',
      resolution: '720p',
      imageSources: ['https://cdn.example.test/person.jpg'],
      audioSources: ['https://cdn.example.test/music.mp3'],
    });

    expect(form.get('function_mode')).toBe('omni_reference');
    expect(form.get('prompt')).toBe('@Image1 听着 @Audio1 走过街道');
    expect(JSON.parse(String(form.get('materials')))).toEqual([
      { type: 'image', name: 'Image1', url: 'https://cdn.example.test/person.jpg' },
      { type: 'audio', name: 'Audio1', url: 'https://cdn.example.test/music.mp3' },
    ]);
  });

  it('builds the documented multipart image request', () => {
    const form = buildHmStudioImageForm({
      model: 'HM-Image-5.0Lite',
      prompt: '暖色调山谷',
      ratio: '4:3',
      resolution: '2k',
      imageSources: ['https://cdn.example.test/reference.jpg'],
      sampleStrength: 0.6,
    });

    expect(form.get('ratio')).toBe('4:3');
    expect(form.get('resolution')).toBe('2k');
    expect(form.get('sample_strength')).toBe('0.6');
    expect(form.get('image_url')).toBe('https://cdn.example.test/reference.jpg');
  });

  it('normalizes successful and failed task responses', () => {
    expect(normalizeHmStudioTask({ status: 'success', result_urls: ['/files/result.mp4'] }, 'https://example.test/')).toMatchObject({
      status: 'success',
      progress: 100,
      resultUrl: 'https://example.test/files/result.mp4',
    });
    expect(normalizeHmStudioTask({ data: { status: 'failed', fail_reason: 'upstream rejected' } }, 'https://example.test')).toMatchObject({
      status: 'failed',
      error: 'upstream rejected',
    });
  });

  it('reads HM Studio progress_pct and progress_text fields', () => {
    expect(normalizeHmStudioTask({
      status: 'generating',
      progress_pct: 37,
      progress_text: '视频生成中',
    }, 'https://example.test')).toMatchObject({
      status: 'generating',
      progress: 37,
      progressText: '视频生成中',
    });
  });
});

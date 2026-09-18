import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  buildHmStudioImageForm,
  buildHmStudioVideoForm,
  hmStudioCreateUrl,
  hmStudioTaskUrl,
  normalizeHmStudioFace,
  normalizeHmStudioTask,
  shouldSendHmStudioAuthorization,
} from '../server/services/hmStudioAdapter.js';

describe('HM Studio adapter', () => {
  it('uses the documented create and task endpoints', () => {
    expect(hmStudioCreateUrl('https://example.test/', 'video')).toBe('https://example.test/v1/videos/generations');
    expect(hmStudioCreateUrl('https://example.test', 'image')).toBe('https://example.test/v1/images/generations');
    expect(hmStudioTaskUrl('https://example.test/', 'task/id')).toBe('https://example.test/v1/tasks/task%2Fid');
  });

  it('only sends API authorization to the HM Studio API origin', () => {
    const baseUrl = 'https://hm.example.test';

    expect(shouldSendHmStudioAuthorization('/v1/files/video.mp4', baseUrl)).toBe(true);
    expect(shouldSendHmStudioAuthorization('https://hm.example.test/files/video.mp4', baseUrl)).toBe(true);
    expect(shouldSendHmStudioAuthorization('http://v19-dola.dola.com/signed/video.mp4', baseUrl)).toBe(false);
    expect(shouldSendHmStudioAuthorization('not a valid absolute url', '')).toBe(false);
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
    expect(form.get('face')).toBe('true');
    expect(form.get('function_mode')).toBe('first_last_frames');
    expect(form.get('first_frame_url')).toBe('https://cdn.example.test/start.jpg');
    expect(form.has('face_split')).toBe(false);
  });

  it('uploads a processed local image as multipart bytes', async () => {
    const uploadDir = path.join(process.cwd(), 'data', 'uploads');
    const filename = 'hm_face_adapter_test.jpg';
    const filePath = path.join(uploadDir, filename);
    fs.mkdirSync(uploadDir, { recursive: true });
    fs.writeFileSync(filePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    try {
      const form = buildHmStudioVideoForm({
        model: 'HM-Video-SD1.5Pro',
        prompt: 'test',
        duration: 5,
        ratio: '16:9',
        resolution: '720p',
        imageSources: [`/uploads/${filename}`],
      });
      const uploaded = form.get('first_frame');
      expect(uploaded).toBeInstanceOf(Blob);
      expect(await (uploaded as Blob).arrayBuffer()).toEqual(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]).buffer);
      expect(form.has('first_frame_url')).toBe(false);
    } finally {
      fs.rmSync(filePath, { force: true });
    }
  });

  it('forces upstream face processing on for every HM request', () => {
    expect(normalizeHmStudioFace(undefined)).toBe(false);
    expect(normalizeHmStudioFace('false')).toBe(false);
    expect(normalizeHmStudioFace(true)).toBe(true);
    expect(normalizeHmStudioFace('true')).toBe(true);

    const videoForm = buildHmStudioVideoForm({
      model: 'seedance_v2.5-301010',
      prompt: 'test',
      duration: 10,
      ratio: '16:9',
      resolution: '720p',
      face: true,
    });
    const imageForm = buildHmStudioImageForm({
      model: 'jimen-5.0',
      prompt: 'test',
      ratio: '1:1',
      face: 'true',
    });
    const explicitFalseForm = buildHmStudioVideoForm({
      model: 'seedance_v2.5-301010',
      prompt: 'test',
      duration: 10,
      ratio: '16:9',
      resolution: '720p',
      face: false,
    });

    expect(videoForm.get('face')).toBe('true');
    expect(imageForm.get('face')).toBe('true');
    expect(explicitFalseForm.get('face')).toBe('true');
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

  it.each([
    'MINIMAX-H3-2.5采样',
    'MINIMAX-H3-2.0采样-933',
    'MINIMAX-H3-2.5采样-101010',
    'MINIMAX-H3-2.5采样-301010',
  ])('passes the configured upstream model id through unchanged: %s', (model) => {
    const form = buildHmStudioVideoForm({
      model,
      prompt: 'test',
      duration: 10,
      ratio: '16:9',
      resolution: '720p',
    });

    expect(form.get('model')).toBe(model);
  });

  it('uses omni reference fields for the 301010 mixed-material model', () => {
    const form = buildHmStudioVideoForm({
      model: 'MINIMAX-H3-2.5采样-301010',
      prompt: '[ref_1] watches [ref_video_1] while [ref_audio_1] plays',
      duration: 30,
      ratio: '16:9',
      resolution: '720p',
      imageSources: ['https://cdn.example.test/person.jpg'],
      videoSources: ['https://cdn.example.test/reference.mp4'],
      audioSources: ['https://cdn.example.test/reference.mp3'],
    });

    expect(form.get('function_mode')).toBe('omni_reference');
    expect(form.get('model')).toBe('MINIMAX-H3-2.5采样-301010');
    expect(form.get('prompt')).toBe('@Image1 watches @Video1 while @Audio1 plays');
    expect(JSON.parse(String(form.get('materials')))).toEqual([
      { type: 'image', name: 'Image1', url: 'https://cdn.example.test/person.jpg' },
      { type: 'video', name: 'Video1', url: 'https://cdn.example.test/reference.mp4' },
      { type: 'audio', name: 'Audio1', url: 'https://cdn.example.test/reference.mp3' },
    ]);
    expect(form.get('face')).toBe('true');
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
    expect(form.get('face')).toBe('true');
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

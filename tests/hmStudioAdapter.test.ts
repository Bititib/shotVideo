import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import fs from 'fs';
import path from 'path';
const publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-public-refs-'));
beforeAll(() => { vi.stubEnv('PUBLIC_REFERENCE_DIR', publicDir); vi.stubEnv('BACKEND_URL', 'https://studio.test'); });
afterAll(() => { vi.unstubAllEnvs(); fs.rmSync(publicDir, { recursive: true, force: true }); });
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
  it.each(['SD2.0FAST803', 'SD2.0FAST813', 'SD2.0MINI503'])('sends the exact new upstream model and mixed audio references for %s', model => {
    const resolution = model.includes('MINI') ? '720p' : '2k';
    const form = buildHmStudioVideoForm({ model, prompt: '[ref_1] [ref_audio_1]', duration: 15,
      ratio: '9:16', resolution, imageSources: ['https://example.test/image.jpg'],
      audioSources: ['https://example.test/audio.mp3'],
      videoSources: model === 'SD2.0FAST813' ? ['https://example.test/video.mp4'] : [] });
    expect(form.get('model')).toBe(model);
    expect(form.getAll('channel')).toEqual(['lumen']);
    expect(form.get('duration')).toBe('15');
    expect(form.get('video_resolution')).toBe(resolution);
    expect(form.get('function_mode')).toBe('omni_reference');
    expect(form.get('prompt')).toBe('@Image1 @Audio1');
    const materials = JSON.parse(String(form.get('materials')));
    expect(materials).toContainEqual({ type: 'audio', name: 'Audio1', url: 'https://example.test/audio.mp3' });
    expect(materials.filter((m: any) => m.type === 'video')).toHaveLength(model === 'SD2.0FAST813' ? 1 : 0);
  });
  it.each(['SD2.0FAST803', 'SD2.0FAST813', 'SD2.0MINI503'])('pins %s to lumen even for old/default channel overrides', model => {
    for (const upstreamChannel of [undefined, '', 'default', 'official', '低价', 'lumen']) {
      const form = buildHmStudioVideoForm({ model, prompt: 'test', duration: 4, ratio: '16:9', resolution: '720p', upstreamChannel });
      expect(form.getAll('channel')).toEqual(['lumen']);
      expect(form.get('model')).toBe(model);
    }
  });
  it('leaves older HM video and image channel routing unchanged', () => {
    for (const model of ['MINIMAX-H3-2.5采样', 'MINIMAX-H3-2.0采样-933', 'MINIMAX-H3-2.5采样-101010', 'MINIMAX-H3-2.5采样-301010']) {
      const options = { model, prompt: 'test', duration: 6, ratio: '16:9', resolution: '720p' };
      expect(buildHmStudioVideoForm(options).has('channel')).toBe(false);
      expect(buildHmStudioVideoForm({ ...options, upstreamChannel: 'custom' }).get('channel')).toBe('custom');
    }
    const imageOptions = { model: 'jimen-5.0', prompt: 'test', ratio: '1:1' };
    expect(buildHmStudioImageForm(imageOptions).has('channel')).toBe(false);
    expect(buildHmStudioImageForm({ ...imageOptions, upstreamChannel: 'custom' }).get('channel')).toBe('custom');
  });
  it('sends persisted reference video and audio as unsigned public URLs', async () => {
    const dir=fs.mkdtempSync(path.join(process.cwd(),'data/uploads/hm-multimodal-'));
    try {
      fs.writeFileSync(path.join(dir,'video.mov'),Buffer.from('0000ftypqt  video bytes'));
      fs.writeFileSync(path.join(dir,'audio.ogg'),Buffer.from('OggS audio bytes'));
      const prefix=`https://studio.test/uploads/${path.basename(dir)}`;
      const form=buildHmStudioVideoForm({model:'seedance_v2.5-101010',prompt:'test',duration:6,ratio:'16:9',resolution:'720p',
        videoSources:[`${prefix}/video.mov`],audioSources:[`${prefix}/audio.ogg`],localMediaBaseUrl:'https://studio.test'});
      expect(form.has('video_file_1')).toBe(false); expect(form.has('audio_file_1')).toBe(false);
      const materials = JSON.parse(String(form.get('materials')));
      expect(materials).toEqual([{type:'video',name:'Video1',url:expect.stringMatching(/^https:\/\/studio.test\/reference-assets\/.+\.mov$/)},
        {type:'audio',name:'Audio1',url:expect.stringMatching(/^https:\/\/studio.test\/reference-assets\/.+\.ogg$/)}]);
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
  });
  it('publishes historical assets as URLs in every video mode', async () => {
    const dir = path.join(process.cwd(), 'data/uploads/history-assets');
    const file = path.join(dir, 'hm-private-reference-test.jpg');
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, bytes);
    try {
      for (const source of ['/uploads/history-assets/hm-private-reference-test.jpg',
        'https://studio.test/uploads/history-assets/hm-private-reference-test.jpg',
        'https://studio.test/api/uploads/history-assets/hm-private-reference-test.jpg?expires=1&signature=expired']) {
        for (const [mode, field] of [['first_last_frames', 'first_frame'], ['omni_reference', 'image_file_1'], ['multi_frame', 'frame_1']]) {
          const form = buildHmStudioVideoForm({ model: 'seedance_v2.5', prompt: 'test', duration: 6,
            ratio: '16:9', resolution: '720p', imageSources: [source], functionMode: mode, localMediaBaseUrl: 'https://studio.test' });
          expect(form.has(field)).toBe(false);
          const url = mode === 'first_last_frames' ? String(form.get('first_frame_url'))
            : mode === 'omni_reference' ? JSON.parse(String(form.get('materials')))[0].url : JSON.parse(String(form.get('multi_frames')))[0];
          expect(url).toMatch(/^https:\/\/studio.test\/reference-assets\/[a-f0-9-]+\.jpg$/);
          expect(fs.readFileSync(path.join(publicDir, path.basename(new URL(url).pathname)))).toEqual(bytes);
        }
      }
      const remote = 'https://external.test/uploads/history-assets/hm-private-reference-test.jpg';
      const options = { model: 'seedance_v2.5', prompt: 'test', duration: 6, ratio: '16:9', resolution: '720p', localMediaBaseUrl: 'https://studio.test' };
      expect(buildHmStudioVideoForm({ ...options, imageSources: [remote] }).get('first_frame_url')).toBe(remote);
      expect(() => buildHmStudioVideoForm({ ...options, imageSources: ['/uploads/%2e%2e/private.jpg'] })).toThrow('路径不安全');
      expect(() => buildHmStudioVideoForm({ ...options, imageSources: ['https://studio.test/uploads/history-assets/missing.jpg'] })).toThrow('不存在');
    } finally { fs.rmSync(file, { force: true }); }
  });
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

  it('sends a processed local image as a public first-frame URL', async () => {
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
      expect(form.has('first_frame')).toBe(false);
      expect(form.get('first_frame_url')).toMatch(/^https:\/\/studio.test\/reference-assets\/[a-f0-9-]+\.jpg$/);
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

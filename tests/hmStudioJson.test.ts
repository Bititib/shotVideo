import { describe, it, expect } from 'vitest';
import { buildHmStudioVideoPayload } from '../server/services/hmStudioAdapter.js';

const base = { model: '30-10-10', prompt: 'test', duration: 30, ratio: '16:9', resolution: '720p' };
describe('HM video JSON protocol', () => {
  it('preserves the 7936 character / 68 newline regression on the serialized wire', async () => {
    const prompt = '字'.repeat(7800) + '\n字'.repeat(68);
    expect(prompt.length).toBe(7936);
    const old = new FormData(); old.append('prompt', prompt);
    expect(String((await new Response(old).formData()).get('prompt')).length).toBe(8004);
    const result = JSON.parse(JSON.stringify(buildHmStudioVideoPayload({ ...base, prompt })));
    expect(result.prompt).toBe(prompt);
    expect(result).toMatchObject({ model: 'DDLONG-SD2.5', channel: 'DDLONG', duration: 30, face: true, video_resolution: '720p' });
  });
  it.each([8000, 8001, 12000])('preserves %s Unicode characters without a local HM limit', length => {
    const prompt = '😀'.repeat(length);
    expect(buildHmStudioVideoPayload({ ...base, prompt }).prompt).toBe(prompt);
  });
  it('retains reference replacement without a length restriction', () => {
    const prompt = '字'.repeat(7993) + '[ref_1.jpg]';
    expect(buildHmStudioVideoPayload({ ...base, prompt, imageSources: ['https://example.com/a.jpg'] }).prompt).toBe('字'.repeat(7993) + '@Image1');
  });
  it('retains all 15 material names and URL ordering as an array and legacy face=true', () => {
    const payload = buildHmStudioVideoPayload({ ...base, prompt: '[ref_9] [ref_video_3] [ref_audio_3]', face: false,
      imageSources: Array.from({ length: 9 }, (_, i) => `https://example.com/${i}.jpg`),
      videoSources: Array.from({ length: 3 }, (_, i) => `https://example.com/${i}.mp4`),
      audioSources: Array.from({ length: 3 }, (_, i) => `https://example.com/${i}.mp3`) });
    expect(payload.materials).toHaveLength(15);
    expect(payload.prompt).toBe('@Image9 @Video3 @Audio3');
    expect((payload.materials as any[])[14]).toEqual({type:'audio', name:'Audio3', url:'https://example.com/2.mp3'});
    expect(payload.face).toBe(true);
  });
  it.each(['SD2.0FAST803', 'SD2.0FAST813', 'SD2.0MINI503'])('retains lumen for %s', model => {
    expect(buildHmStudioVideoPayload({ ...base, model, upstreamChannel: 'default' }).channel).toBe('lumen');
  });
  it('retains separate first/last frame fields and multi-frame arrays', () => {
    const firstFrame = 'https://example.com/first.jpg', lastFrame = 'https://example.com/last.jpg';
    expect(buildHmStudioVideoPayload({ ...base, model:'minimaxH3', firstFrame, lastFrame }))
      .toMatchObject({ first_frame_url:firstFrame, end_frame_url:lastFrame, function_mode:'first_last_frames' });
    expect(buildHmStudioVideoPayload({ ...base, model:'minimaxH3', functionMode:'multi_frame', imageSources:[firstFrame,lastFrame] }).multi_frames)
      .toEqual([firstFrame,lastFrame]);
  });
});

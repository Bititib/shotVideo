import { afterEach, describe, expect, it, vi } from 'vitest';
import { FUNAI_IMAGE_MODELS, FUNAI_VIDEO_MODELS, funAiModelLimits } from '../shared/funAi.js';
import { buildFunAiVideoPayload, fetchFunAiModels, funAiBaseUrl, funAiInlineImage, generateFunAiImage,
  isFunAiChannel, normalizeFunAiTask, shouldSendFunAiAuthorization } from '../server/services/funAiAdapter.js';
import type { SpecificationRequest } from '../server/services/specificationAdapters.js';
const channel = { type: 'funai', baseUrl: 'https://ztyunjuan.com', apiKey: 'private-funai-test-key' };
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=';
const url = (n: number) => `https://media.example/${n}.png`;
function request(model: string, overrides: Partial<SpecificationRequest> = {}): SpecificationRequest {
  const l = funAiModelLimits(model);
  return { prompt: 'product camera movement', images: [], videos: [], audios: [], firstFrame: '', lastFrame: '', body: {}, publicBaseUrl: 'https://app.example',
    input: { images: 0, videos: 0, audios: 0, outputs: 1, seconds: l.duration.min, resolution: l.resolutions[0], ratio: l.ratios[0], firstFrame: false, lastFrame: false }, ...overrides };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('FunAI documented protocol', () => {
  it.each(['veo-3.1','veo-3.1-lite'])('passes the documented %s result-audio flag without dropping false', model => {
    expect(buildFunAiVideoPayload(model, request(model,{body:{audio:false}}))).toMatchObject({audio:false});
    expect(buildFunAiVideoPayload(model, request(model))).not.toHaveProperty('audio');
    expect(()=>buildFunAiVideoPayload(model, request(model,{body:{audio:'false'}}))).toThrow('布尔');
  });
  it('routes Omni ordinary images to the chosen upstream role without dropping or duplicating any', () => {
    for(const [mode,field] of [['frame','input_reference'],['style','style_references'],['element','element_references']]) {
      const payload=buildFunAiVideoPayload('gemini-omni-flash',request('gemini-omni-flash',{images:[url(1)],body:{reference_mode:mode}}));
      expect(payload[field]).toEqual(mode==='frame'?url(1):[url(1)]);
      for(const other of ['input_reference','style_references','element_references'].filter(x=>x!==field))expect(payload).not.toHaveProperty(other);
    }
    expect(()=>buildFunAiVideoPayload('gemini-omni-flash',request('gemini-omni-flash',{images:[url(1),url(2)],body:{reference_mode:'frame'}}))).toThrow('最多 1');
    expect(()=>buildFunAiVideoPayload('gemini-omni-flash',request('gemini-omni-flash',{firstFrame:url(1),body:{reference_mode:'style'}}))).toThrow('独立首帧');
    expect(()=>buildFunAiVideoPayload('gemini-omni-flash',request('gemini-omni-flash',{body:{reference_mode:'style'}}))).toThrow('必须提供图片');
  });
  it('recognizes exact hostnames and normalizes SDK base paths', () => {
    expect(isFunAiChannel({ baseUrl: channel.baseUrl })).toBe(true);
    expect(isFunAiChannel({ baseUrl: 'https://ztyunjuan.com.evil.example' })).toBe(false);
    expect(funAiBaseUrl(channel.baseUrl + '/v1/')).toBe(channel.baseUrl);
    expect(funAiBaseUrl(channel.baseUrl + '/v1beta')).toBe(channel.baseUrl);
    expect(() => funAiBaseUrl('https://name:secret@example.com')).toThrow();
    expect(shouldSendFunAiAuthorization('https://cdn.example/file.mp4', channel.baseUrl)).toBe(false);
    expect(shouldSendFunAiAuthorization(channel.baseUrl + '/v1/videos/a/content', channel.baseUrl)).toBe(true);
  });
  it('discovers actual account models and redacts upstream authentication failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [{ id: 'veo-3.1' }] })));
    expect(await fetchFunAiModels(channel)).toEqual(['veo-3.1']);
    expect(fetch).toHaveBeenCalledWith(channel.baseUrl + '/v1/models', expect.objectContaining({ headers: { Authorization: 'Bearer ' + channel.apiKey } }));
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { message: channel.apiKey + ' invalid' } }, { status: 401 })));
    try { await fetchFunAiModels(channel); expect.fail('expected rejection'); } catch (error: any) { expect(error.status).toBe(401); expect(error.message).not.toContain(channel.apiKey); }
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: {} })));
    await expect(fetchFunAiModels(channel)).rejects.toThrow('格式');
  });
  it.each(FUNAI_VIDEO_MODELS)('builds the documented JSON protocol for %s', model => {
    const req = request(model);
    if (model === 'runway-gen4-turbo') req.images = [url(1)];
    const payload = buildFunAiVideoPayload(model, req);
    expect(payload).toMatchObject({ model, prompt: req.prompt, seconds: req.input.seconds, aspect_ratio: req.input.ratio, n: 1 });
    expect(payload).not.toHaveProperty('duration');
  });
  it('uses separate frame/material/audio fields and rejects invalid combinations before creating a task', () => {
    expect(buildFunAiVideoPayload('minimax-h3', request('minimax-h3', { images: [url(1)], audios: ['https://media.example/a.mp3'] })))
      .toMatchObject({ reference_images: [url(1)], audio_reference: ['https://media.example/a.mp3'], resolution: '1440P' });
    expect(() => buildFunAiVideoPayload('minimax-h3', request('minimax-h3', { audios: ['https://media.example/a.mp3'] }))).toThrow('必须搭配');
    expect(() => buildFunAiVideoPayload('minimax-h3', request('minimax-h3', { body: { audio: false } }))).toThrow('原生音频');
    expect(buildFunAiVideoPayload('kling-v3', request('kling-v3', { images: [url(1), url(2)] })))
      .toMatchObject({ start_frame: url(1), end_frame: url(2) });
    expect(buildFunAiVideoPayload('veo-3.1-fl', request('veo-3.1-fl', { firstFrame: url(1), lastFrame: url(2) })))
      .toMatchObject({ images: [url(1), url(2)] });
    expect(() => buildFunAiVideoPayload('veo-3.1-fl', request('veo-3.1-fl', { lastFrame: url(2) }))).toThrow('必须搭配');
    expect(() => buildFunAiVideoPayload('kling-o3-pro-v2v-reference', request('kling-o3-pro-v2v-reference', { images: [url(1),url(2),url(3),url(4)], videos: ['https://media.example/a.mp4'] }))).toThrow('合计');
    expect(buildFunAiVideoPayload('kling-v3-omni-v2v-create', request('kling-v3-omni-v2v-create', { images: [url(1),url(2),url(3),url(4),url(5),url(6)] })))
      .toMatchObject({ element_references: [url(1),url(2),url(3)], style_references: [url(4),url(5),url(6)] });
    expect(buildFunAiVideoPayload('happy-horse', request('happy-horse', { videos: ['https://media.example/a.mp4'] }))).not.toHaveProperty('seconds');
    expect(() => buildFunAiVideoPayload('runway-gen4-turbo', request('runway-gen4-turbo'))).toThrow('图片数量');
  });
  it('normalizes both processing states, relative results, failures and authenticated content fallback', () => {
    expect(normalizeFunAiTask({ status: 'in_progress', progress: 35 }, channel, 'a')).toMatchObject({ status: 'processing', progress: 35 });
    expect(normalizeFunAiTask({ status: 'completed', url: '/generated/a.mp4' }, channel, 'a').resultUrl).toBe(channel.baseUrl + '/generated/a.mp4');
    expect(normalizeFunAiTask({ status: 'completed' }, channel, 'a/b').resultUrl).toBe(channel.baseUrl + '/v1/videos/a%2Fb/content');
    expect(normalizeFunAiTask({ status: 'completed' }, channel, 'a', 'image').resultUrl).toBe('');
    expect(normalizeFunAiTask({ status: 'failed', error: { message: 'blocked ' + channel.apiKey } }, channel, 'a').error).not.toContain(channel.apiKey);
    expect(() => normalizeFunAiTask({ status: 'completed', url: 'javascript:alert(1)' }, channel, 'a')).toThrow('无效');
  });
  it.each(FUNAI_IMAGE_MODELS.filter(model => !model.startsWith('gpt-')))('uses native Gemini contents/inlineData for %s', async model => {
    const req = request(model, { images: [png, png] }); let posted: any, endpoint = '';
    const fetcher = vi.fn(async (target, init) => {
      endpoint = String(target); posted = JSON.parse(init!.body as string);
      return Response.json({ candidates: [{ content: { parts: [{ text: 'done' }, { inlineData: { mimeType: 'image/png', data: png.split(',')[1] } }] } }] });
    });
    const result = await generateFunAiImage(channel, model, req, fetcher as typeof fetch, vi.fn());
    expect(endpoint).toBe(channel.baseUrl + '/v1beta/models/' + model + ':generateContent');
    expect(posted.contents[0].parts).toHaveLength(3);
    expect(posted.contents[0].parts[1].inlineData.data).toBe(png.split(',')[1]);
    expect(posted).not.toHaveProperty('images'); expect(posted).not.toHaveProperty('model');
    expect(result.imageUrl).toBe(png);
  });
  it('persists the GPT task ID, retries only its status query and returns the original result', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ id: 'image/task', status: 'queued' }))
      .mockResolvedValueOnce(Response.json({}, { status: 429 }))
      .mockResolvedValueOnce(Response.json({ status: 'in_progress' }))
      .mockResolvedValueOnce(Response.json({ status: 'completed', data: [{ url: url(3) }] }));
    const submitted = vi.fn(), wait = vi.fn(async () => {});
    const req = request('gpt-image-2', { images: [png] }); req.input.resolution = '2K'; req.input.quality = 'high';
    const result = await generateFunAiImage(channel, 'gpt-image-2', req, fetcher, submitted, wait);
    expect(submitted).toHaveBeenCalledExactlyOnceWith('image/task'); expect(result.imageUrl).toBe(url(3));
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ model: 'gpt-image-2', images: [png], quality: 'high', output_resolution: '2K', n: 1 });
    expect(fetcher.mock.calls.filter(call => call[1].method === 'POST')).toHaveLength(1);
    expect(fetcher.mock.calls[1][0]).toBe(channel.baseUrl + '/v1/videos/image%2Ftask');
  });
  it.each([400, 408, 503])('classifies image submission HTTP %s independently of polling', async status => {
    const fetcher = vi.fn(async () => Response.json({ error: 'request rejected or timed out' }, { status }));
    await expect(generateFunAiImage(channel, 'gpt-image-2', request('gpt-image-2'), fetcher, vi.fn()))
      .rejects.toMatchObject({ uncertain: status !== 400, confirmedFailure: status === 400 });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('does not recreate an accepted GPT image after a confirmed task failure', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ id: 'accepted' }))
      .mockResolvedValueOnce(Response.json({ status: 'failed', error: { message: 'policy rejection' } }));
    await expect(generateFunAiImage(channel, 'gpt-image-2', request('gpt-image-2'), fetcher, vi.fn()))
      .rejects.toMatchObject({ confirmedFailure: true, uncertain: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('rejects invalid inline images and private URLs without downloading', async () => {
    expect(await funAiInlineImage(png)).toMatchObject({ mimeType: 'image/png' });
    await expect(funAiInlineImage('data:image/png;base64,aGVsbG8=')).rejects.toThrow('有效');
    await expect(funAiInlineImage('https://127.0.0.1/a.png')).rejects.toThrow('内网');
    await expect(funAiInlineImage('http://media.example/a.png')).rejects.toThrow('HTTPS');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../server/config/env.js', () => ({ env: { GEMINI_API_BASE_URL: 'https://tts.invalid', GEMINI_API_KEY: 'test-key' } }));
vi.mock('../server/services/channelService.js', () => ({ ChannelService: { findChannelByType: () => null } }));
import { AIService } from '../server/services/aiService';
import { createTtsCatalogLoader, parseTtsVoices } from '../server/services/ttsCatalogService';
const DEFAULT_TTS_MODEL = 'gemini-3.8-flash-tts'; // Test fixture, not a production default.

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('AIStudio2API speech', () => {
  it('reads the deployed /v1/voices response and preserves metadata without duplicates', () => {
    expect(parseTtsVoices({voices:[{id:'Sulafat',name:'Sulafat',gender:'female',description:'温暖治愈的声音',scenario:'陪伴'}, {id:'Sulafat'}, null, {id:''}]})).toEqual([{id:'Sulafat',name:'Sulafat',gender:'female',description:'温暖治愈的声音',scenario:'陪伴'}]);
    expect(() => parseTtsVoices(null)).toThrow();
    expect(parseTtsVoices({voices:[]})).toEqual([]);
  });

  it('shares catalog requests, caches and retains known voices on an outage', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ voices: [{ id: 'NewVoice', name: 'NewVoice' }] }) });
    vi.stubGlobal('fetch', fetchMock);
    const load = createTtsCatalogLoader();
    const [a, b] = await Promise.all([load('https://tts.invalid/', 'key'), load('https://tts.invalid/', 'key')]);
    expect(a).toEqual(b); expect(a).toEqual([{id:'NewVoice',name:'NewVoice'}]); expect(fetchMock.mock.calls[0][0]).toBe('https://tts.invalid/v1/voices'); expect(fetchMock).toHaveBeenCalledTimes(1);
    await load('https://tts.invalid/', 'key'); expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(300_001);
    fetchMock.mockResolvedValue({ ok: false });
    expect(await load('https://tts.invalid/', 'key')).toEqual(a);
    expect(await load('https://other.invalid', 'key')).toEqual([]);
  });

  it('sends exact text and structured voice selection to the existing Gemini endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { data: 'UklGRg==', mimeType: 'audio/wav' } }] } }] }) });
    vi.stubGlobal('fetch', fetchMock);
    expect(await AIService.generateTts('你好，世界。', 'NewVoice', { id: 1, modelId: DEFAULT_TTS_MODEL, apiKey: null })).toEqual({ audioBase64: 'UklGRg==', mimeType: 'audio/wav' });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toContain(`/models/${DEFAULT_TTS_MODEL}:generateContent`);
    expect(JSON.parse(options.body)).toEqual({
      contents: [{ role: 'user', parts: [{ text: '你好，世界。' }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'NewVoice' } } } },
    });
  });

  it('retains older model support and wraps raw PCM as playable WAV', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { data: 'AAAAAA==', mimeType: 'audio/L16;codec=pcm;rate=24000' } }] } }] }) });
    vi.stubGlobal('fetch', fetchMock);
    const audio = await AIService.generateTts('hello', 'Kore', { id: 1, modelId: 'gemini-2.5-flash-preview-tts', apiKey: 'model-key' });
    expect(fetchMock.mock.calls[0][0]).toContain('/models/gemini-2.5-flash-preview-tts:generateContent');
    const wav = Buffer.from(audio.audioBase64, 'base64');
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF'); expect(wav.readUInt32LE(24)).toBe(24000);
    expect(audio.mimeType).toBe('audio/wav');
  });
});

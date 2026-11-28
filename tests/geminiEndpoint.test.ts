import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  env: { GEMINI_API_BASE_URL: '', GEMINI_API_KEY: '' } as Record<string, string>,
  channels: [] as any[],
}));
vi.mock('../server/config/env.js', () => ({ env: state.env }));
vi.mock('../server/services/channelService.js', () => ({
  ChannelService: { findChannelByType: () => state.channels[0] || null, findChannelsByType: () => state.channels },
}));

import { resolveGeminiEndpoint, isRetiredGeminiEndpoint, GeminiEndpointError } from '../server/services/geminiEndpoint';
import { AIService } from '../server/services/aiService';
import { createTtsCatalogLoader, GEMINI_PREBUILT_VOICES } from '../server/services/ttsCatalogService';

const okGenerate = () => Response.json({ candidates: [{ content: { parts: [{ text: '{}' }] } }] });

beforeEach(() => { state.env.GEMINI_API_BASE_URL = ''; state.env.GEMINI_API_KEY = ''; state.channels = []; });
afterEach(() => { vi.unstubAllGlobals(); });

describe('Gemini endpoint is driven by admin channels, never the retired AIStudio2API proxy', () => {
  it('has no built-in default upstream and fails with an actionable message when nothing is configured', () => {
    expect(() => resolveGeminiEndpoint([], {})).toThrow(GeminiEndpointError);
    expect(() => resolveGeminiEndpoint([], {})).toThrow(/渠道管理/);
  });

  it('rejects the retired proxy whether configured by channel name, host, or environment variable', () => {
    expect(isRetiredGeminiEndpoint('AIStudio2API', 'https://ok.example')).toBe(true);
    expect(isRetiredGeminiEndpoint('x', 'http://172.245.16.80:7860')).toBe(true);
    expect(isRetiredGeminiEndpoint('Gemini 官方', 'https://generativelanguage.googleapis.com')).toBe(false);
    expect(() => resolveGeminiEndpoint([{ id: 9, name: 'old', baseUrl: 'http://172.245.16.80:7860', apiKey: 'k' }], {}))
      .toThrow(/已下线的 AIStudio2API/);
    expect(() => resolveGeminiEndpoint([], { GEMINI_API_BASE_URL: 'http://172.245.16.80:7860', GEMINI_API_KEY: 'k' }))
      .toThrow(/已下线的 AIStudio2API/);
  });

  it('prefers the first usable channel, skips retired ones, and pairs key with its own base URL', () => {
    const endpoint = resolveGeminiEndpoint([
      { id: 1, name: 'aistudio2api 旧', baseUrl: 'https://legacy.example', apiKey: 'legacy-key' },
      { id: 2, name: 'Gemini 官方', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/', apiKey: 'channel-key' },
    ], { GEMINI_API_BASE_URL: 'https://env.example', GEMINI_API_KEY: 'env-key' });
    expect(endpoint).toEqual({ baseUrl: 'https://generativelanguage.googleapis.com', apiKey: 'channel-key', channelId: 2, source: 'channel' });
    // Channel without key must not borrow the env key meant for a different upstream.
    expect(() => resolveGeminiEndpoint([{ id: 3, name: 'G', baseUrl: 'https://g.example', apiKey: '' }], { GEMINI_API_KEY: 'env-key' }))
      .toThrow(/未配置 API Key/);
    expect(resolveGeminiEndpoint([], { GEMINI_API_BASE_URL: 'https://env.example/', GEMINI_API_KEY: 'env-key' }))
      .toMatchObject({ baseUrl: 'https://env.example', apiKey: 'env-key', source: 'env' });
  });

  it('AIService sends generateContent to the channel base URL with the key only in headers', async () => {
    state.channels = [{ id: 7, name: 'Gemini 官方', type: 'gemini', baseUrl: 'https://gemini-channel.example', apiKey: 'secret-channel-key' }];
    const fetchMock = vi.fn().mockImplementation(async () => okGenerate());
    vi.stubGlobal('fetch', fetchMock);
    await AIService.callGenerateContent('gemini-2.5-flash', { contents: [] });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gemini-channel.example/v1beta/models/gemini-2.5-flash:generateContent');
    expect(String(url)).not.toContain('secret-channel-key');
    expect(options.headers['x-goog-api-key']).toBe('secret-channel-key');
  });

  it('AIService refuses to call anything when only the retired proxy is configured', async () => {
    state.env.GEMINI_API_BASE_URL = 'http://172.245.16.80:7860';
    state.env.GEMINI_API_KEY = 'k';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(AIService.callGenerateContent('gemini-2.5-flash', {})).rejects.toMatchObject({ status: 503 });
    await expect(AIService.generateImage('cat', '1:1')).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('image generation uses the native model path without the proxy-only models%2F prefix', async () => {
    state.channels = [{ id: 7, name: 'Gemini', type: 'gemini', baseUrl: 'https://gemini-channel.example', apiKey: 'k' }];
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ candidates: [{ content: { parts: [{ inlineData: { data: 'AA==', mimeType: 'image/png' } }] } }] }));
    vi.stubGlobal('fetch', fetchMock);
    await AIService.generateImage('cat', '1:1', undefined, { id: 1, modelId: 'gemini-3-pro-image-preview', apiKey: null });
    expect(fetchMock.mock.calls[0][0]).toBe('https://gemini-channel.example/v1beta/models/gemini-3-pro-image-preview:generateContent');
  });

  it('voice catalog falls back to official prebuilt voices only when the endpoint does not exist (404)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('Not Found', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const voices = await createTtsCatalogLoader()('https://gemini-channel.example', 'k');
    expect(voices).toHaveLength(30);
    expect(voices[0]).toEqual({ id: 'Zephyr', name: 'Zephyr', style: 'Bright' });
    expect(GEMINI_PREBUILT_VOICES.map(v => v.id)).toContain('Kore');

    fetchMock.mockResolvedValue(Response.json({ error: { status: 'PERMISSION_DENIED', message: 'bad key' } }, { status: 403 }));
    expect(await createTtsCatalogLoader()('https://gemini-channel.example', 'k')).toEqual([]);
  });
});

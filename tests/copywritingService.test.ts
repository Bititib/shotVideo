import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
vi.mock('../server/config/env.js', () => ({ env: { GEMINI_API_BASE_URL: 'https://upstream.invalid', GEMINI_API_KEY: 'test-key' } }));
vi.mock('../server/services/channelService.js', () => ({ ChannelService: { findChannelByType: () => null } }));
import { AIService } from '../server/services/aiService';

const dirs: string[] = [];
function image() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copywriting-test-')); dirs.push(dir);
  const filePath = path.join(dir, 'image.png'); fs.writeFileSync(filePath, 'image fixture');
  return { path: filePath, mimetype: 'image/png', originalname: 'image.png' } as Express.Multer.File;
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('copywriting image analysis', () => {
  it('sends images inline without Files API and reads the non-thinking JSON answer', async () => {
    const files = [image(), image()];
    const result = { tiktok: { hook: 'hello' }, amazon: {}, detailPageImages: [] };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ thought: true, text: 'thinking' }, { text: '```json\n' + JSON.stringify(result) + '\n```' }] } }] }) });
    vi.stubGlobal('fetch', fetchMock);
    expect(await AIService.analyzeCopywriting(files, { id: 1, modelId: 'selected-model', apiKey: null })).toEqual(result);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('/models/selected-model:generateContent');
    const parts = JSON.parse(fetchMock.mock.calls[0][1].body).contents[0].parts;
    expect(parts.slice(1)).toEqual(files.map(() => ({ inlineData: { mimeType: 'image/png', data: Buffer.from('image fixture').toString('base64') } })));
    expect(files.every(file => !fs.existsSync(file.path))).toBe(true);
  });

  it('cleans temporary images after an upstream failure', async () => {
    const file = image();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network failure')));
    await expect(AIService.analyzeCopywriting([file])).rejects.toThrow('network failure');
    expect(fs.existsSync(file.path)).toBe(false);
  });

  it('retains video file handling and cleans prior uploads if a later upload fails', async () => {
    const files = [image(), image(), image()];
    files[1].mimetype = files[2].mimetype = 'video/mp4';
    vi.spyOn(AIService as any, 'uploadAndWait').mockResolvedValueOnce({ uri: 'file-uri', name: 'files/test', mimeType: 'video/mp4' }).mockRejectedValueOnce(new Error('upload failed'));
    const cleanup = vi.spyOn(AIService as any, 'deleteUploadedFile').mockResolvedValue(undefined);
    await expect(AIService.analyzeCopywriting(files)).rejects.toThrow('upload failed');
    expect(cleanup).toHaveBeenCalledWith('files/test', undefined);
    expect(files.every(file => !fs.existsSync(file.path))).toBe(true);
  });

  it('rejects oversized inline payloads before sending and removes the temporary file', async () => {
    const file = image();
    fs.truncateSync(file.path, 14_000_000);
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    await expect(AIService.analyzeCopywriting([file])).rejects.toMatchObject({ status: 400, message: expect.stringContaining('总大小过大') });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fs.existsSync(file.path)).toBe(false);
  });

  it.each([
    [{ candidates: [] }, '未返回文案'],
    [{ candidates: [{ content: { parts: [{ text: '{partial' }] }, finishReason: 'MAX_TOKENS' }] }, '不完整'],
    [{ candidates: [{ content: { parts: [{ text: 'not JSON' }] } }] }, '格式不正确'],
  ])('reports unusable upstream output instead of a successful empty result', async (response, message) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => response }));
    const file = image();
    await expect(AIService.analyzeCopywriting([file])).rejects.toThrow(message);
    expect(fs.existsSync(file.path)).toBe(false);
  });
});

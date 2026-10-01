import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClonedVoiceService } from '../server/services/clonedVoiceService';
const dirs: string[] = [];
function fixture(user = 1) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-test-')); dirs.push(dir);
  const audio = path.join(dir, 'sample.wav');
  const bytes = Buffer.alloc(44); bytes.write('RIFF'); bytes.write('WAVE', 8); fs.writeFileSync(audio, bytes);
  const store = path.join(dir, 'voices.json');
  return { audio, store, service: new ClonedVoiceService(user, 'https://upstream.invalid', 'test', store) };
}
afterEach(() => { vi.unstubAllGlobals(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
describe('cloned voices', () => {
  it('creates the documented request, persists the complete ID and isolates owners', async () => {
    const { service, audio, store } = fixture();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ name: 'voices/voice_123', state: 'ACTIVE' })));
    vi.stubGlobal('fetch', fetchMock);
    await service.cloneVoice(audio, 'My voice');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.voice.replicationConfig.referenceAudio.inlineData.mimeType).toBe('audio/wav');
    expect(fetchMock.mock.calls[0][0]).toBe('https://upstream.invalid/v1beta/voices');
    expect(new ClonedVoiceService(1, 'https://upstream.invalid', 'test', store).listClonedVoices()[0].voiceId).toBe('voices/voice_123');
    const other = new ClonedVoiceService(2, 'https://upstream.invalid', 'test', store);
    expect(other.listClonedVoices()).toEqual([]);
    await expect(other.deleteClonedVoice('voices/voice_123')).rejects.toMatchObject({ status: 404 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(service.getAllVoices([{ id: 'Zephyr', name: 'Zephyr' }]).map(v => v.type)).toEqual(['cloned', 'prebuilt']);
  });
  it('keeps local records if upstream deletion fails and constructs the correct delete URL', async () => {
    const { service, audio } = fixture();
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ name: 'voices/voice_123', state: 'ACTIVE' })))
      .mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(new Response('', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    await service.cloneVoice(audio, 'Name');
    await expect(service.deleteClonedVoice('voices/voice_123')).rejects.toThrow();
    expect(service.listClonedVoices()).toHaveLength(1);
    await service.deleteClonedVoice('voices/voice_123');
    expect(fetchMock.mock.calls[2][0]).toBe('https://upstream.invalid/v1beta/voices/voice_123');
    expect(service.listClonedVoices()).toEqual([]);
  });
  it('reports unsupported upstream without inventing a saved voice', async () => {
    const { service, audio } = fixture();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));
    await expect(service.cloneVoice(audio, 'Name')).rejects.toThrow('未提供声音克隆接口');
    expect(service.listClonedVoices()).toEqual([]);
  });
  it('rejects large and unsupported files before upload', async () => {
    const { service, audio } = fixture(); const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    fs.writeFileSync(audio, 'not audio');
    await expect(service.cloneVoice(audio, 'Name')).rejects.toMatchObject({ status: 400 });
    fs.truncateSync(audio, 10 * 1024 * 1024 + 1);
    await expect(service.cloneVoice(audio, 'Name')).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

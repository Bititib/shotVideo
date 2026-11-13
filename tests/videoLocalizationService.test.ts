import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../server/services/channelService.js', () => ({ ChannelService: { getChannelRaw: vi.fn() } }));
vi.mock('../server/services/videoCompatibilityService.js', () => ({ prepareVideoForDelivery: vi.fn(async (p: string) => p) }));
import {
  downloadAndLocalizeVideo,
  originalVideoPathFor,
  preferredVideoDownloadPath,
} from '../server/services/videoLocalizationService.js';
import { ChannelService } from '../server/services/channelService.js';
import { siYueTianVideoCredential } from '../server/services/siYueTianMinimaxAdapter.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('video localization compatible downloads', () => {
  it('only sends the original Siyuetian key to the exact task content endpoint', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'video-original-test-'));
    temporaryDirectories.push(directory);
    vi.spyOn(process, 'cwd').mockReturnValue(directory);
    const channel = { baseUrl: 'https://llm.chre3.com/v1/', apiKey: 'test-only-key', type: 'openai' };
    vi.mocked(ChannelService.getChannelRaw).mockReturnValue(channel as any);
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => { throw new Error('test transport stopped'); });
    vi.stubGlobal('fetch', fetchMock);
    const download = (url: string) => downloadAndLocalizeVideo(url, 'task_original', 'configured-video', 5, null,
      undefined, undefined, undefined, siYueTianVideoCredential(channel));

    await expect(download('https://cdn.example/video.mp4')).rejects.toThrow('test transport stopped');
    expect(new Headers(fetchMock.mock.calls[0][1].headers).has('Authorization')).toBe(false);
    await expect(download('https://llm.chre3.com/v1/videos/task_original/content')).rejects.toThrow('test transport stopped');
    expect(new Headers(fetchMock.mock.calls[1][1].headers).get('Authorization')).toBe('Bearer test-only-key');
    expect(fetchMock.mock.calls[1][1].redirect).toBe('error');
  });

  it('creates a stable sibling path for the upstream original', () => {
    expect(originalVideoPathFor('/uploads/video_task.mp4')).toBe('/uploads/video_task.original.mp4');
    expect(originalVideoPathFor('/uploads/video_task.webm')).toBe('/uploads/video_task.original.webm');
  });

  it('never prefers the saved upstream original over the compatible file', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'video-original-test-'));
    temporaryDirectories.push(directory);
    const playablePath = path.join(directory, 'video_task.mp4');
    const originalPath = originalVideoPathFor(playablePath);
    fs.writeFileSync(playablePath, 'h264-playback-copy');

    expect(await preferredVideoDownloadPath(playablePath)).toBe(playablePath);

    fs.writeFileSync(originalPath, 'upstream-original');
    expect(await preferredVideoDownloadPath(playablePath)).toBe(playablePath);
  });
});

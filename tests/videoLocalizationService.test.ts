import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../server/services/channelService.js', () => ({ ChannelService: {} }));
vi.mock('../server/services/videoCompatibilityService.js', () => ({ prepareVideoForDelivery: vi.fn(async (p: string) => p) }));
import {
  originalVideoPathFor,
  preferredVideoDownloadPath,
} from '../server/services/videoLocalizationService.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('video localization compatible downloads', () => {
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

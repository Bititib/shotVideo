import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
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

describe('video localization original-file downloads', () => {
  it('creates a stable sibling path for the upstream original', () => {
    expect(originalVideoPathFor('/uploads/video_task.mp4')).toBe('/uploads/video_task.original.mp4');
    expect(originalVideoPathFor('/uploads/video_task.webm')).toBe('/uploads/video_task.original.webm');
  });

  it('prefers the saved upstream original and falls back to the playable file', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'video-original-test-'));
    temporaryDirectories.push(directory);
    const playablePath = path.join(directory, 'video_task.mp4');
    const originalPath = originalVideoPathFor(playablePath);
    fs.writeFileSync(playablePath, 'h264-playback-copy');

    expect(preferredVideoDownloadPath(playablePath)).toBe(playablePath);

    fs.writeFileSync(originalPath, 'upstream-original');
    expect(preferredVideoDownloadPath(playablePath)).toBe(originalPath);
  });
});

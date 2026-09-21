import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  InvalidMiaowuMediaError,
  prepareMiaowuPublicMediaUrls,
} from '../server/services/miaowuMediaService.js';

const temporaryDirectories: string[] = [];

function temporaryUploadsRoot(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'miaowu-media-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('Miaowu public media preparation', () => {
  it('materializes image and audio data URLs as public upload URLs', () => {
    const uploadsRoot = temporaryUploadsRoot();
    const image = prepareMiaowuPublicMediaUrls(
      [`data:image/png;base64,${Buffer.from('png-data').toString('base64')}`],
      'image',
      { publicBaseUrl: 'https://video.example.com', uploadsRoot },
    );
    const audio = prepareMiaowuPublicMediaUrls(
      [`data:audio/mpeg;base64,${Buffer.from('mp3-data').toString('base64')}`],
      'audio',
      { publicBaseUrl: 'https://video.example.com/', uploadsRoot },
    );

    expect(image[0]).toMatch(/^https:\/\/video\.example\.com\/uploads\/miaowu-media\/image_.+\.png$/);
    expect(audio[0]).toMatch(/^https:\/\/video\.example\.com\/uploads\/miaowu-media\/audio_.+\.mp3$/);
    expect(fs.readdirSync(path.join(uploadsRoot, 'miaowu-media'))).toHaveLength(2);
  });

  it('converts an existing local upload into a canonical public URL', () => {
    const uploadsRoot = temporaryUploadsRoot();
    fs.mkdirSync(path.join(uploadsRoot, 'refs'));
    fs.writeFileSync(path.join(uploadsRoot, 'refs', 'sample.wav'), 'audio');

    expect(prepareMiaowuPublicMediaUrls(
      ['/uploads/refs/sample.wav'],
      'audio',
      { publicBaseUrl: 'https://video.example.com', uploadsRoot },
    )).toEqual(['https://video.example.com/uploads/refs/sample.wav']);
  });

  it('keeps valid external HTTPS URLs and trims whitespace', () => {
    expect(prepareMiaowuPublicMediaUrls(
      ['  https://cdn.example.com/media/a.mp4?token=x  '],
      'video',
      { publicBaseUrl: 'https://video.example.com', uploadsRoot: temporaryUploadsRoot() },
    )).toEqual(['https://cdn.example.com/media/a.mp4?token=x']);
  });

  it('rejects missing local files, invalid protocols, and localhost public bases', () => {
    const uploadsRoot = temporaryUploadsRoot();
    expect(() => prepareMiaowuPublicMediaUrls(
      ['/uploads/missing.jpg'], 'image', { publicBaseUrl: 'https://video.example.com', uploadsRoot },
    )).toThrow(InvalidMiaowuMediaError);
    expect(() => prepareMiaowuPublicMediaUrls(
      ['blob:https://video.example.com/id'], 'image', { publicBaseUrl: 'https://video.example.com', uploadsRoot },
    )).toThrow(/仅支持 Base64/);
    expect(() => prepareMiaowuPublicMediaUrls(
      [], 'image', { publicBaseUrl: 'http://localhost:3000', uploadsRoot },
    )).toThrow(/不能使用 localhost/);
  });
});

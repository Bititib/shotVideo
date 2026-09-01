import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  compactAdminContentForList,
  compactAudioContentForList,
  compactContentForList,
  materializeContentMetadataAssets,
  sanitizeContentRoutingForClient,
} from '../server/services/contentService.js';

describe('content routing privacy', () => {
  it('removes administrator-only failover fields from ordinary string metadata', () => {
    const sanitized = sanitizeContentRoutingForClient({
      id: 1,
      metadata: JSON.stringify({
        model: 'seedance_v2.5',
        actualModel: 'sd2.5',
        actualChannel: 'wx-haidiyue',
        fallbackFrom: 'hmstudio',
        fallbackReason: 'hmstudio_capacity',
        fallbackAt: '2026-08-30T00:00:00.000Z',
        channelId: 12,
        channelApiKeyId: 8,
        upstreamModel: 'sd2.5',
        progressText: '主线路已切换至备用线路',
        seconds: 8,
      }),
    });
    const metadata = JSON.parse(sanitized.metadata);

    expect(metadata).toMatchObject({
      model: 'seedance_v2.5',
      seconds: 8,
      progressText: '视频生成中',
    });
    expect(metadata).not.toHaveProperty('actualModel');
    expect(metadata).not.toHaveProperty('actualChannel');
    expect(metadata).not.toHaveProperty('fallbackFrom');
    expect(metadata).not.toHaveProperty('fallbackReason');
    expect(metadata).not.toHaveProperty('fallbackAt');
    expect(metadata).not.toHaveProperty('channelId');
    expect(metadata).not.toHaveProperty('channelApiKeyId');
    expect(metadata).not.toHaveProperty('upstreamModel');
  });

  it('preserves ordinary generation metadata', () => {
    const sanitized = sanitizeContentRoutingForClient({
      metadata: { model: 'seedance_v2.5', seconds: 10, progressText: '视频生成中 40%' },
    });
    expect(sanitized.metadata).toEqual({
      model: 'seedance_v2.5', seconds: 10, progressText: '视频生成中 40%',
    });
  });

  it('removes inline media from list metadata but preserves remote URLs and configuration', () => {
    const inlineVideo = `data:video/mp4;base64,${'a'.repeat(1024)}`;
    const inlineImage = `data:image/png;base64,${'b'.repeat(129 * 1024)}`;
    const remoteImage = 'https://cdn.example.com/reference.jpg';
    const compacted = compactContentForList({
      id: 1516,
      metadata: JSON.stringify({
        prompt: 'test prompt',
        model: 'seedance_v2.5',
        reference_videos: [inlineVideo],
        reference_images: [inlineImage, remoteImage],
        error: 'Video generation timed out after 30 minutes',
      }),
    });
    const metadata = JSON.parse(compacted.metadata);

    expect(metadata).toMatchObject({
      prompt: 'test prompt',
      model: 'seedance_v2.5',
      reference_videos: [],
      reference_images: [remoteImage],
      error: 'Video generation timed out after 30 minutes',
      listAssetsCompacted: true,
      omittedInlineAssetCount: 2,
      referenceAssetCounts: { images: 2, videos: 1, audios: 0 },
    });
    expect(compacted.metadata).not.toContain('data:video/mp4');
    expect(compacted.metadata).not.toContain('data:image/png');
  });

  it('does not strip full media from the detail response sanitizer', () => {
    const inlineVideo = 'data:video/mp4;base64,AAAA';
    const sanitized = sanitizeContentRoutingForClient({
      metadata: { reference_videos: [inlineVideo] },
    });

    expect(sanitized.metadata).toEqual({ reference_videos: [inlineVideo] });
  });

  it('keeps a small inline image thumbnail in video list metadata', () => {
    const thumbnail = `data:image/jpeg;base64,${'a'.repeat(32 * 1024)}`;
    const compacted = compactContentForList({ metadata: { reference_images: [thumbnail] } });

    expect(compacted.metadata).toEqual({ reference_images: [thumbnail] });
  });

  it('defers Base64 audio result data until the detail request', () => {
    const resultText = JSON.stringify({ audioBase64: 'a'.repeat(1024), mimeType: 'audio/mp3' });
    const compacted = compactAudioContentForList({ metadata: '{}', resultText });

    expect(compacted.resultText).toBeNull();
    expect(JSON.parse(compacted.metadata)).toMatchObject({ listResultCompacted: true });
  });

  it('keeps admin routing fields while compacting admin list media', () => {
    const compacted = compactAdminContentForList({
      metadata: JSON.stringify({
        actualChannel: 'hmstudio',
        channelId: 7,
        reference_videos: ['data:video/mp4;base64,AAAA'],
      }),
      resultText: null,
    });
    const metadata = JSON.parse(compacted.metadata);

    expect(metadata).toMatchObject({
      actualChannel: 'hmstudio',
      channelId: 7,
      listAssetsCompacted: true,
      referenceAssetCounts: { images: 0, videos: 1, audios: 0 },
    });
    expect(metadata.reference_videos).toEqual([]);
  });

  it('materializes inline history assets as deduplicated file URLs', () => {
    const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-assets-'));
    try {
      const inlineVideo = `data:video/mp4;base64,${Buffer.from('test-video').toString('base64')}`;
      const result = materializeContentMetadataAssets({
        publicBaseUrl: 'https://video.example.com/',
        reference_videos: [inlineVideo],
        video_urls: [inlineVideo],
        listAssetsCompacted: true,
        omittedInlineAssetCount: 2,
      }, { uploadDir });

      expect(result.changed).toBe(true);
      expect(result.filesWritten).toBe(1);
      expect(result.bytesWritten).toBe(Buffer.byteLength('test-video'));
      expect(result.metadata.reference_videos).toEqual([
        expect.stringMatching(/^https:\/\/video\.example\.com\/uploads\/history-assets\/[a-f0-9]{64}\.mp4$/),
      ]);
      expect(result.metadata.video_urls).toEqual(result.metadata.reference_videos);
      expect(result.metadata).not.toHaveProperty('listAssetsCompacted');
      expect(result.metadata).not.toHaveProperty('omittedInlineAssetCount');
      expect(fs.readdirSync(uploadDir)).toHaveLength(1);
      expect(fs.readFileSync(path.join(uploadDir, fs.readdirSync(uploadDir)[0]), 'utf8')).toBe('test-video');
    } finally {
      fs.rmSync(uploadDir, { recursive: true, force: true });
    }
  });
});

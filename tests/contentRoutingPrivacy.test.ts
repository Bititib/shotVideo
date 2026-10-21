import { describe, expect, it } from 'vitest';
import fs from 'fs';
import crypto from 'crypto';
import os from 'os';
import path from 'path';
import {
  compactAdminContentForList,
  compactAudioContentForList,
  compactContentForList,
  materializeContentMetadataAssets,
  sanitizeContentRoutingForClient,
  withAdminChannelName,
} from '../server/services/contentService.js';

describe('content routing privacy', () => {
  it.each(['query', 'settlement', 'local'] as const)('preserves %s review meaning without exposing provider diagnostics', reviewKind => {
    const result = sanitizeContentRoutingForClient({ status: 'review', metadata: {
      reviewKind, requiresReview: true, error: 'private supplier sk-test-secret', progressText: 'private supplier https://private.invalid' } });
    expect(result.metadata.reviewKind).toBe(reviewKind);
    expect(result.metadata.error).not.toContain('private');
    expect(result.metadata.progressText).not.toContain('提交结果待核实');
    expect(result.metadata.progressText).toContain(reviewKind === 'query' ? '查询异常' : reviewKind === 'settlement' ? '结算待核实' : '本地处理异常');
  });
  it('retains review guidance when a task has an uncertain credit-related error', () => {
    const result = sanitizeContentRoutingForClient({ status:'processing', metadata:{ requiresReview:true, fallbackFrom:'private-route',
      error:'insufficient credits', progressText:'insufficient credits', billingStatus:'review' } });
    expect(result.metadata).toMatchObject({ requiresReview:true, billingStatus:'review',
      error:'提交结果待核实，请在生成记录核实原任务，请勿重复提交。',
      progressText:'提交结果待核实，请在生成记录核实原任务，请勿重复提交。' });
  });
  it.each([false, true])('explains upstream credit failures in history without exposing admin diagnostics (JSON=%s)', json => {
    const raw = '上游提交失败 (402)：{"error":"insufficient credits","provider":"private-provider"}';
    const meta = { error:raw, failureReason:raw, progressText:raw, billingStatus:'refunded', refundAmount:0.6 };
    const item = { status:'failed', metadata:json ? JSON.stringify(meta) : meta };
    const result = sanitizeContentRoutingForClient(item);
    const publicMeta = typeof result.metadata === 'string' ? JSON.parse(result.metadata) : result.metadata;
    const safe = 'insufficient credits';
    expect(publicMeta).toMatchObject({ error:safe, failureReason:safe, progressText:safe, billingStatus:'refunded', refundAmount:0.6 });
    expect(JSON.stringify(result)).not.toContain('private-provider');
    expect(meta.failureReason).toBe(raw);
  });
  it('resolves historical openai labels from channel ID without changing route identity or leaking to users', () => {
    const item = { metadata: JSON.stringify({ channelId: 5, actualChannel: 'openai' }) };
    const result = withAdminChannelName(item, new Map([[5, '四月天']]));
    expect(JSON.parse(result.metadata)).toEqual({ channelId: 5, actualChannel: 'openai', channelName: '四月天' });
    expect(JSON.parse(sanitizeContentRoutingForClient(result).metadata)).not.toHaveProperty('channelName');
    expect(withAdminChannelName(item, new Map()).metadata).toBe(item.metadata);
  });
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
        channelName: 'private-channel-name',
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
    expect(metadata).not.toHaveProperty('channelName');
    expect(metadata).not.toHaveProperty('channelApiKeyId');
    expect(metadata).not.toHaveProperty('upstreamModel');
  });

  it.each([true,false])('hides provider details from historical failure fields with string metadata=%s without changing admin diagnostics', stringMetadata => {
    const raw='纵横科技提交失败 (400): invalid_parameters: 视频时长不符合当前模型要求';
    const meta={error:raw,failureReason:raw,imageErrors:{0:raw},progressText:raw,channelName:'纵横科技',fallbackFrom:'private'};
    const item={id:12927,status:'failed',errorMessage:raw,metadata:stringMetadata?JSON.stringify(meta):meta};
    const sanitized=sanitizeContentRoutingForClient(item);
    const result=typeof sanitized.metadata==='string'?JSON.parse(sanitized.metadata):sanitized.metadata;
    const safe='invalid_parameters: 视频时长不符合当前模型要求';
    expect(sanitized.errorMessage).toBe(safe);expect(result).toMatchObject({error:safe,failureReason:safe,imageErrors:{0:safe},progressText:safe});
    expect(JSON.stringify(sanitized)).not.toContain('纵横科技');expect(meta.error).toBe(raw);expect(item.errorMessage).toBe(raw);
  });

  it('keeps administrator submission diagnostics out of user content responses', () => {
    const item={status:'review',metadata:{requiresReview:true,zonghengSubmissionDiagnostics:{reason:'timeout',httpStatus:504,elapsedMs:120000}}};
    const sanitized=sanitizeContentRoutingForClient(item);
    expect(sanitized.metadata).not.toHaveProperty('zonghengSubmissionDiagnostics');
    expect(item.metadata.zonghengSubmissionDiagnostics).toMatchObject({reason:'timeout',httpStatus:504});
    expect(sanitized.metadata.requiresReview).toBe(true);
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

  it('repairs an existing truncated history asset before returning its URL', () => {
    const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-assets-repair-'));
    try {
      const bytes = Buffer.from('complete-image-bytes');
      const inlineImage = `data:image/jpeg;base64,${bytes.toString('base64')}`;
      const hash = crypto.createHash('sha256').update(bytes).digest('hex');
      const filePath = path.join(uploadDir, `${hash}.jpg`);
      fs.writeFileSync(filePath, bytes.subarray(0, 4));

      const result = materializeContentMetadataAssets({
        reference_images: [inlineImage],
      }, { uploadDir });

      expect(result.changed).toBe(true);
      expect(result.filesWritten).toBe(1);
      expect(fs.readFileSync(filePath)).toEqual(bytes);
      expect(fs.readdirSync(uploadDir)).toEqual([`${hash}.jpg`]);
    } finally {
      fs.rmSync(uploadDir, { recursive: true, force: true });
    }
  });
});

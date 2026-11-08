import { describe, it, expect } from 'vitest';
import { buildReplicatedVideoPrompt, getVideoReferenceAssets, getVideoReferenceFrames, getVideoReferenceCounts, removeVideoPromptReference, restoreVideoPromptRefs } from '../client/src/utils/videoPromptRefs';

import { normalizeSudaShuiPrompt } from '../server/services/sudaShuiAdapter';

describe('Prompt Reference @ Syntax Test Suite', () => {
  it('keeps image 1 separate from image 10 and preserves native tags on repeat normalization', () => {
    const prompt = restoreVideoPromptRefs('@图10 @图1 @视频2 @音频2');
    expect(prompt).toBe('@Image10 @Image1 @Video2 @Audio2');
    expect(restoreVideoPromptRefs(prompt)).toBe(prompt);
    expect(removeVideoPromptReference(prompt,'图',1)).toBe('@Image9 @Video2 @Audio2');
  });
  it('removes a deleted image mention and renumbers later image mentions', () => {
    expect(removeVideoPromptReference('@图1 @图2 @图3 保持动作', '图', 2))
      .toBe('@Image1 @Image2 保持动作');
  });

  it('removes and renumbers video and audio mentions', () => {
    expect(removeVideoPromptReference('@视频1 对照 @视频2', '视频', 1))
      .toBe('对照 @Video1');
    expect(removeVideoPromptReference('参考＠音频2和@音频3', '音频', 2))
      .toBe('参考和@Audio2');
  });

  it('should correctly restore prompt tags from backend format to UI format', () => {
    const rawBackendPrompt = '主角 [ref_0.jpg] 看着 [ref_video] 中的画面，配音遵循 [ref_audio] 的语气';
    const restored = restoreVideoPromptRefs(rawBackendPrompt);
    expect(restored).toBe('主角 @Image1 看着 @Video1 中的画面，配音遵循 @Audio1 的语气');
  });

  it('should restore numbered video/audio tags and append missing material mentions', () => {
    const restored = buildReplicatedVideoPrompt(
      '主角使用 [ref_0.jpg]，参考 [ref_video_2] 的动作',
      { images: 3, videos: 2, audios: 2 },
    );
    expect(restored).toBe(
      '@Image2 @Image3 @Video1 @Audio1 @Audio2\n\n主角使用 @Image1，参考 @Video2 的动作',
    );
  });

  it('should not duplicate references that are already present', () => {
    expect(buildReplicatedVideoPrompt('@图1 @视频1 @音频1', { images: 1, videos: 1, audios: 1 }))
      .toBe('@Image1 @Video1 @Audio1');
  });

  it('should normalize API and legacy reference asset field names for replication', () => {
    expect(getVideoReferenceFrames({first_frame_url:'first.jpg',end_frame_url:'last.jpg'})).toEqual({first:'first.jpg',last:'last.jpg'});
    expect(getVideoReferenceFrames({first_frame:'start.jpg',last_frame:'end.jpg'})).toEqual({first:'start.jpg',last:'end.jpg'});
    expect(getVideoReferenceFrames({})).toEqual({first:null,last:null});
    expect(getVideoReferenceAssets({
      reference_images: [],
      image_urls: ['image-a'],
      reference_videos: [],
      video_urls: ['video-a', 'video-b'],
      audios: ['audio-a'],
    })).toEqual({
      images: ['image-a'],
      videos: ['video-a', 'video-b'],
      audios: ['audio-a'],
    });
  });

  it('preserves reference counts when compact history lists omit inline video and audio', () => {
    expect(getVideoReferenceCounts({
      reference_images: ['image-a'],
      reference_videos: [],
      audio_urls: [],
      referenceAssetCounts: { images: 1, videos: 2, audios: 3 },
    })).toEqual({ images: 1, videos: 2, audios: 3 });
  });

  it('should correctly retain unified @ tags on frontend submit', () => {
    const uiPrompt = '角色 @图1 按照 @视频 的节奏跳舞，说出 @音频 的词';
    const translated = restoreVideoPromptRefs(uiPrompt);
    expect(translated).toBe('角色 @Image1 按照 @Video1 的节奏跳舞，说出 @Audio1 的词');
  });

  it('should correctly translate internal placeholders to SudaShui/Seedance engine tags on backend submit', () => {
    const internalPrompt = '角色 [ref_0.jpg] 按照 [ref_video] 的节奏跳舞，说出 [ref_audio] 的词';
    const enginePrompt = normalizeSudaShuiPrompt(internalPrompt);
    expect(enginePrompt).toBe('角色 @image1 按照 @video1 的节奏跳舞，说出 @audio1 的词');
  });
});

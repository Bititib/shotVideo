import { describe, it, expect } from 'vitest';
import { buildReplicatedVideoPrompt, restoreVideoPromptRefs } from '../client/src/utils/videoPromptRefs';

const frontendTranslate = (prompt: string, imagesCount: number = 1) => {
  let finalPrompt = prompt.trim();
  for (let idx = 0; idx < imagesCount; idx++) {
    const userRefLabelPattern = new RegExp(`[@＠]图${idx + 1}\\b|[@＠]图${idx + 1}`, 'g');
    finalPrompt = finalPrompt.replace(userRefLabelPattern, `[ref_${idx}.jpg]`);
  }
  finalPrompt = finalPrompt.replace(/[@＠]视频\b|[@＠]视频/g, '[ref_video]');
  finalPrompt = finalPrompt.replace(/[@＠]音频\b|[@＠]音频/g, '[ref_audio]');
  return finalPrompt;
};

const backendTranslate = (prompt: string) => {
  let finalPrompt = prompt.trim();
  finalPrompt = finalPrompt.replace(/\[ref_(\d+)(?:\.[a-zA-Z0-9]+)?\]/g, (match, idxStr) => {
    const idx = parseInt(idxStr, 10);
    return `@image${idx + 1}`;
  });
  finalPrompt = finalPrompt.replace(/\[ref_video\]/g, '@video1');
  finalPrompt = finalPrompt.replace(/\[ref_audio\]/g, '@audio1');
  return finalPrompt;
};

describe('Prompt Reference @ Syntax Test Suite', () => {
  it('should correctly restore prompt tags from backend format to UI format', () => {
    const rawBackendPrompt = '主角 [ref_0.jpg] 看着 [ref_video] 中的画面，配音遵循 [ref_audio] 的语气';
    const restored = restoreVideoPromptRefs(rawBackendPrompt);
    expect(restored).toBe('主角 @图1 看着 @视频1 中的画面，配音遵循 @音频1 的语气');
  });

  it('should restore numbered video/audio tags and append missing material mentions', () => {
    const restored = buildReplicatedVideoPrompt(
      '主角使用 [ref_0.jpg]，参考 [ref_video_2] 的动作',
      { images: 3, videos: 2, audios: 2 },
    );
    expect(restored).toBe(
      '@图2 @图3 @视频1 @音频1 @音频2\n\n主角使用 @图1，参考 @视频2 的动作',
    );
  });

  it('should not duplicate references that are already present', () => {
    expect(buildReplicatedVideoPrompt('@图1 @视频1 @音频1', { images: 1, videos: 1, audios: 1 }))
      .toBe('@图1 @视频1 @音频1');
  });

  it('should correctly translate UI @ tags to internal placeholders on frontend submit', () => {
    const uiPrompt = '角色 @图1 按照 @视频 的节奏跳舞，说出 @音频 的词';
    const translated = frontendTranslate(uiPrompt, 1);
    expect(translated).toBe('角色 [ref_0.jpg] 按照 [ref_video] 的节奏跳舞，说出 [ref_audio] 的词');
  });

  it('should correctly translate internal placeholders to SudaShui/Seedance engine tags on backend submit', () => {
    const internalPrompt = '角色 [ref_0.jpg] 按照 [ref_video] 的节奏跳舞，说出 [ref_audio] 的词';
    const enginePrompt = backendTranslate(internalPrompt);
    expect(enginePrompt).toBe('角色 @image1 按照 @video1 的节奏跳舞，说出 @audio1 的词');
  });
});

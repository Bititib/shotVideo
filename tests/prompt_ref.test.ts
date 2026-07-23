import { describe, it, expect } from 'vitest';

const restorePrompt = (targetPrompt: string) => {
  if (!targetPrompt) return '';
  return targetPrompt
    .replace(/\[ref_(\d+)(?:\.[a-zA-Z0-9]+)?\]/g, (match, idxStr) => {
      const idx = parseInt(idxStr, 10);
      return `@图${idx + 1}`;
    })
    .replace(/\[ref_video\]/g, '@视频')
    .replace(/\[ref_audio\]/g, '@音频');
};

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
    const restored = restorePrompt(rawBackendPrompt);
    expect(restored).toBe('主角 @图1 看着 @视频 中的画面，配音遵循 @音频 的语气');
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

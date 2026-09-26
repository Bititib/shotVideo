import { describe, expect, it } from 'vitest';
import { MAX_VIDEO_PROMPT_LENGTH, validateVideoPrompt } from '../server/services/videoPromptValidation.js';

describe('validateVideoPrompt', () => {
  it('rejects missing and whitespace-only prompts', () => {
    expect(validateVideoPrompt(undefined)).toBe('请输入视频描述');
    expect(validateVideoPrompt('   ')).toBe('请输入视频描述');
  });

  it('accepts a prompt exactly at the limit', () => {
    expect(validateVideoPrompt('字'.repeat(MAX_VIDEO_PROMPT_LENGTH))).toBeNull();
  });

  it('rejects a prompt over the limit before submission and billing', () => {
    expect(validateVideoPrompt('字'.repeat(MAX_VIDEO_PROMPT_LENGTH + 1)))
      .toBe(`提示词字数不能超过 ${MAX_VIDEO_PROMPT_LENGTH} 字`);
  });
});

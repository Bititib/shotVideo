import { describe, expect, it } from 'vitest';
import { validateVideoPrompt } from '../server/services/videoPromptValidation.js';

describe('validateVideoPrompt', () => {
  it('rejects missing and whitespace-only prompts', () => {
    expect(validateVideoPrompt(undefined)).toBe('请输入视频描述');
    expect(validateVideoPrompt('   ')).toBe('请输入视频描述');
  });

  it.each([5001, 12000, 20000, 60000])('accepts %i characters without imposing a global model limit', length => {
    expect(validateVideoPrompt('字'.repeat(length))).toBeNull();
  });
});

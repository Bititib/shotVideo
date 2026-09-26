export const MAX_VIDEO_PROMPT_LENGTH = 5000;

export function validateVideoPrompt(prompt: unknown): string | null {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return '请输入视频描述';
  }
  if (prompt.trim().length > MAX_VIDEO_PROMPT_LENGTH) {
    return `提示词字数不能超过 ${MAX_VIDEO_PROMPT_LENGTH} 字`;
  }
  return null;
}

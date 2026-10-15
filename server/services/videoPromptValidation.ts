export function validateVideoPrompt(prompt: unknown): string | null {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return '请输入视频描述';
  }
  return null;
}

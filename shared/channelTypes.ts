/** Only installed channel protocols may supply execution credentials. */
export const CHANNEL_TYPES = [
  'openai', 'custom', 'gemini', 'grok2api', 'hmstudio', 'wx-haidiyue',
  'snumom', 'longxia', 'async-video', 'haya', 'miaowu', 'huss', 'blobdraw',
  'megaby', 'mingfei', 'zongheng', 'zongheng-v6k', 'funai', 'mj',
  'siyuetian', 'sudashui', 'pidoi',
] as const;
export const isSupportedChannelType = (type: unknown): boolean =>
  typeof type === 'string' && CHANNEL_TYPES.some(value => value === type);

export const SUNO_CHANNEL_TYPE = 'suno-api';
export const SUNO_BASE_URL = 'https://www.suno-api.io';
export const SUNO_MUSIC_MODELS = ['suno-v6', 'suno-v6-wild', 'suno-v6-mini'] as const;
export const MUSIC_OPERATIONS = ['generate', 'cover', 'sing', 'voice_cover', 'upload', 'enhanced_upload', 'voice', 'enhanced_voice', 'voice_from_clip'] as const;
export type MusicOperation = typeof MUSIC_OPERATIONS[number];
export const MUSIC_OPERATION_LABELS: Record<MusicOperation, string> = {
  generate: '生成音乐', cover: 'AI 翻唱', sing: '用我的音色唱新歌', voice_cover: '用我的音色翻唱',
  upload: '普通音频上传', enhanced_upload: '版权歌曲强化上传', voice: '创建本人音色',
  enhanced_voice: '强化克隆本人音色', voice_from_clip: '从已有音频创建音色',
};
export const songOperation = (op: MusicOperation) => ['generate', 'cover', 'sing', 'voice_cover'].includes(op);
export const voiceOperation = (op: MusicOperation) => ['voice', 'enhanced_voice', 'voice_from_clip'].includes(op);
export const freeMusicOperation = (op: MusicOperation) => ['upload', 'voice', 'voice_from_clip'].includes(op);
export const musicPriceField = (op: MusicOperation) => op === 'sing' || op === 'voice_cover' ? 'voice_generation' :
  op === 'enhanced_upload' || op === 'enhanced_voice' ? op : undefined;

export type MusicResult = { id: string; status: string; title?: string; error?: string | null; result_url: string | null };
export type MusicTask = {
  id: string; model: string; prompt: string; operation: MusicOperation | null; title?: string;
  status: string; review_kind?: string | null; progress: number; result_url: string | null; results: MusicResult[];
  cost: number; refund_amount?: number; billing_status?: string; error: string | null; created_at: string;
  asset_id?: string; voice_id?: string; can_cancel?: boolean;
};

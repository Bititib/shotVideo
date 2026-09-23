import { isLongxiaModel, longxiaResolution, LONGXIA_RATIOS } from '../../shared/longxiaVideo.js';
export { isLongxiaModel, longxiaResolution, longxiaRate, LONGXIA_MODELS, LONGXIA_SECONDS } from '../../shared/longxiaVideo.js';

export const LONGXIA_BASE_URL = 'https://api8.longxiaai.store';
export function isLongxiaChannel(channel: { type?: string; baseUrl?: string } | null | undefined): boolean {
  if (channel?.type === 'longxia') return true;
  try { return new URL(channel?.baseUrl || '').hostname === 'api8.longxiaai.store'; } catch { return false; }
}
export function longxiaApiBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '');
}
export function longxiaVideoCreateUrl(baseUrl: string): string {
  return `${longxiaApiBaseUrl(baseUrl)}/v1/videos`;
}
export function longxiaVideoTaskUrl(baseUrl: string, taskId: string): string {
  return `${longxiaVideoCreateUrl(baseUrl)}/${encodeURIComponent(taskId)}`;
}

export interface LongxiaVideoInput {
  model: string;
  prompt: string;
  seconds: number;
  ratio: string;
  resolution: string;
  imageUrls?: string[];
  videoUrls?: string[];
  audioUrls?: string[];
  firstFrame?: string;
  lastFrame?: string;
}

function asset(category: 'image' | 'audio', source: string): Record<string, string> {
  if (typeof source !== 'string' || !source.trim()) throw new Error('参考素材必须为 HTTPS URL 或 Base64 data URL');
  if (source.startsWith('data:')) {
    const match = source.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/);
    const allowed = category === 'image' ? ['image/png', 'image/jpeg', 'image/webp']
      : ['audio/mpeg', 'audio/mp3'];
    if (!match || !allowed.includes(match[1].toLowerCase())) throw new Error('LongXia 图片支持 PNG/JPEG/WebP，音频支持 MP3');
    const bytes = Buffer.from(match[2], 'base64').length;
    if ((category === 'image' && bytes > 25 * 1024 ** 2) || (category === 'audio' && bytes > 15 * 1024 ** 2)) {
      throw new Error('LongXia 单张图片不得超过 25 MiB，单段音频不得超过 15 MiB');
    }
    return { category, data_base64: match[2] };
  }
  let url: URL;
  try { url = new URL(source); } catch { throw new Error('LongXia 参考素材必须使用公开 HTTPS URL'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('LongXia 参考素材必须使用公开 HTTPS URL');
  return { category, url: source };
}

/** Translate the application's reference labels and append any missing references. */
function referencePrompt(prompt: string, counts: Record<string, number>): string {
  let result = prompt.replace(/[@＠](?:图片|图)(\d+)/g, '@image$1')
    .replace(/[@＠]视频(\d+)?/g, (_, n) => `@video${n || '1'}`)
    .replace(/[@＠]音频(\d+)?/g, (_, n) => `@audio${n || '1'}`)
    .replace(/\[ref_(\d+)\.(?:jpg|jpeg|png|webp)\]/gi, (_, n) => `@image${Number(n) + 1}`)
    .replace(/\[ref_video(?:_(\d+))?\]/g, (_, n) => `@video${n || '1'}`)
    .replace(/\[ref_audio(?:_(\d+))?\]/g, (_, n) => `@audio${n || '1'}`);
  const seen = new Set<string>();
  for (const match of result.matchAll(/@(image|video|audio)(\d+)\b/g)) {
    const index = Number(match[2]);
    if (index < 1 || index > counts[match[1]] || String(index) !== match[2]) throw new Error(`不存在的素材引用：${match[0]}`);
    seen.add(match[0]);
  }
  const missing: string[] = [];
  for (const [category, count] of Object.entries(counts)) {
    for (let index = 1; index <= count; index++) {
      const ref = `@${category}${index}`;
      if (!seen.has(ref)) missing.push(ref);
    }
  }
  if (missing.length) result += `\n参考素材：${missing.join(' ')}`;
  return result;
}

export function buildLongxiaVideoPayload(input: LongxiaVideoInput) {
  if (!isLongxiaModel(input.model)) throw new Error('不支持的 LongXia 模型');
  if (!Number.isInteger(input.seconds) || input.seconds < 4 || input.seconds > 25) throw new Error('LongXia 仅支持 4～25 秒的整数时长');
  if (input.resolution !== longxiaResolution(input.model)) throw new Error(`该 LongXia 模型仅支持 ${longxiaResolution(input.model)}`);
  if (!LONGXIA_RATIOS.includes(input.ratio)) throw new Error('LongXia 不支持该宽高比');
  if (typeof input.prompt !== 'string' || !input.prompt.trim()) throw new Error('请输入视频描述');
  if (input.firstFrame || input.lastFrame) throw new Error('LongXia 请使用参考图片，不支持独立首尾帧参数');
  const images = input.imageUrls || [], videos = input.videoUrls || [], audios = input.audioUrls || [];
  if (videos.length > 0) throw new Error('LongXia 不支持视频参考，请移除参考视频');
  if (images.length > 30 || audios.length > 10) throw new Error('LongXia 最多支持 30 张图片和 10 段音频参考');
  const assets = [...images.map(s => asset('image', s)), ...audios.map(s => asset('audio', s))];
  const base64Size = assets.reduce((total, item) => total + (item.data_base64?.length || 0), 0);
  if (base64Size > 40 * 1024 ** 2) throw new Error('LongXia Base64 素材合计不得超过 40 MiB，请改用 HTTPS URL');
  const prompt = referencePrompt(input.prompt.trim(), { image: images.length, video: videos.length, audio: audios.length });
  if (Array.from(prompt).length > 9500) throw new Error('LongXia 提示词（含素材引用）最多 9500 字符');
  return { model: input.model, prompt, duration: input.seconds, size: input.ratio, ...(assets.length ? { assets } : {}) };
}

export function normalizeLongxiaVideoTask(payload: Record<string, any>) {
  const rawStatus = String(payload.status || '').toLowerCase();
  const error = typeof payload.error === 'string' ? payload.error : payload.error?.message || payload.error?.code || '';
  const resultUrl = Array.isArray(payload.data) ? String(payload.data.find((item: any) => item?.url)?.url || '') : '';
  return {
    status: ['cancelled', 'canceled'].includes(rawStatus) ? 'failed' : rawStatus,
    progress: Number(payload.progress) || (rawStatus === 'completed' ? 100 : 0),
    resultUrl,
    error: error || (['cancelled', 'canceled'].includes(rawStatus) ? 'LongXia 任务已取消' : ''),
  };
}

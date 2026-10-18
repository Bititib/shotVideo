import { MJ_CHANNEL_TYPE, MJ_UPSTREAM_MODEL, MJ_SIZES } from '../../shared/mj.js';

export type MjChannel = { type?: string | null; baseUrl: string; apiKey: string; timeout?: number };
const DEFAULT_MJ_BASE_URL = 'https://kmai.us.ci';
export const isMjChannel = (channel?: { type?: string | null } | null) => [MJ_CHANNEL_TYPE, 'kmai'].includes(channel?.type || '');
export const normalizeMjBaseUrl = (baseUrl: string = '') => {
  const value = baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
  return value === DEFAULT_MJ_BASE_URL ? '' : value;
};
export const mjBaseUrl = (baseUrl: string) => normalizeMjBaseUrl(baseUrl) || DEFAULT_MJ_BASE_URL;

export async function fetchMjModels(channel: MjChannel): Promise<string[]> {
  const response = await fetch(mjBaseUrl(channel.baseUrl) + '/v1/models', {
    headers: { Authorization: 'Bearer ' + channel.apiKey },
    signal: AbortSignal.timeout(channel.timeout || 30_000), redirect: 'error',
  });
  if (!response.ok) throw new Error('读取 MJ 模型失败 (HTTP ' + response.status + ')');
  const payload = await response.json() as any;
  const entries = Array.isArray(payload) ? payload : payload?.data;
  if (!Array.isArray(entries)) throw new Error('MJ 模型列表格式无效');
  const ids = entries.map((entry: any) => typeof entry === 'string' ? entry : entry?.id);
  if (ids.some(id => typeof id !== 'string' || !id.trim())) throw new Error('MJ 模型列表格式无效');
  return ids.includes(MJ_UPSTREAM_MODEL) ? [MJ_UPSTREAM_MODEL] : [];
}

export function buildMjImagePayload(input: {
  model: string; prompt: string; resolution: string; ratio: string; images: string[];
  videos: string[]; audios: string[]; firstFrame: string; lastFrame: string;
  outputs: number; size?: string; quality?: string;
}): Record<string, string> | FormData {
  if (input.model !== MJ_UPSTREAM_MODEL) throw new Error('MJ 渠道仅接入 mj_imagine 图片模型');
  if (input.resolution.toLowerCase() !== '1k') throw new Error('MJ 仅支持 1K');
  const size = Object.hasOwn(MJ_SIZES, input.ratio) ? MJ_SIZES[input.ratio] : '';
  if (!size) throw new Error('MJ 不支持此画面比例');
  if (input.size && input.size !== size) throw new Error('size 与 MJ 的 1K 画面比例不一致，请使用 aspect_ratio 和 resolution');
  if (input.quality) throw new Error('MJ 使用 size 控制尺寸，不支持 quality');
  if (input.images.length > 6) throw new Error('MJ 最多支持 6 张参考图');
  if (![1, 4].includes(input.outputs) || input.videos.length || input.audios.length || input.firstFrame || input.lastFrame) {
    throw new Error('MJ 每次任务固定返回 4 张图片，仅支持图片参考');
  }
  const payload = { model: input.model, prompt: input.prompt, size };
  if (!input.images.length) return payload;
  const form = new FormData();
  for (const [key, value] of Object.entries(payload)) form.append(key, value);
  for (const [index, source] of input.images.entries()) {
    const match = source.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/);
    if (!match) throw new Error('参考图必须先完成本站图片校验');
    const ext = match[1] === 'image/jpeg' ? 'jpg' : match[1].slice(6);
    form.append(input.images.length === 1 ? 'image' : 'image[]',
      new Blob([Buffer.from(match[2], 'base64')], { type: match[1] }), 'reference_' + index + '.' + ext);
  }
  return form;
}

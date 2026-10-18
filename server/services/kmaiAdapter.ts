import { KMAI_CHANNEL_TYPE, KMAI_MJ_UPSTREAM_MODEL, KMAI_MJ_SIZES } from '../../shared/kmai.js';

export type KmaiChannel = { type?: string | null; baseUrl: string; apiKey: string; timeout?: number };
export const isKmaiChannel = (channel?: { type?: string | null } | null) => channel?.type === KMAI_CHANNEL_TYPE;
export const kmaiBaseUrl = (baseUrl: string) => baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '');

export async function fetchKmaiMjModels(channel: KmaiChannel): Promise<string[]> {
  const response = await fetch(kmaiBaseUrl(channel.baseUrl) + '/v1/models', {
    headers: { Authorization: 'Bearer ' + channel.apiKey },
    signal: AbortSignal.timeout(channel.timeout || 30_000), redirect: 'error',
  });
  if (!response.ok) throw new Error('读取 KMAI 模型失败 (HTTP ' + response.status + ')');
  const payload = await response.json() as any;
  const entries = Array.isArray(payload) ? payload : payload?.data;
  if (!Array.isArray(entries)) throw new Error('KMAI 模型列表格式无效');
  const ids = entries.map((entry: any) => typeof entry === 'string' ? entry : entry?.id);
  if (ids.some(id => typeof id !== 'string' || !id.trim())) throw new Error('KMAI 模型列表格式无效');
  return ids.includes(KMAI_MJ_UPSTREAM_MODEL) ? [KMAI_MJ_UPSTREAM_MODEL] : [];
}

export function buildKmaiMjImagePayload(input: {
  model: string; prompt: string; resolution: string; ratio: string; images: string[];
  videos: string[]; audios: string[]; firstFrame: string; lastFrame: string;
  outputs: number; size?: string; quality?: string;
}): Record<string, string> | FormData {
  if (input.model !== KMAI_MJ_UPSTREAM_MODEL) throw new Error('KMAI 渠道仅接入 mj_imagine 图片模型');
  if (input.resolution.toLowerCase() !== '1k') throw new Error('KMAI MJ 仅支持 1K');
  const size = Object.hasOwn(KMAI_MJ_SIZES, input.ratio) ? KMAI_MJ_SIZES[input.ratio] : '';
  if (!size) throw new Error('KMAI MJ 不支持此画面比例');
  if (input.size && input.size !== size) throw new Error('size 与 KMAI MJ 的 1K 画面比例不一致，请使用 aspect_ratio 和 resolution');
  if (input.quality) throw new Error('KMAI MJ 使用 size 控制尺寸，不支持 quality');
  if (input.images.length > 6) throw new Error('KMAI MJ 最多支持 6 张参考图');
  if (![1, 4].includes(input.outputs) || input.videos.length || input.audios.length || input.firstFrame || input.lastFrame) {
    throw new Error('KMAI MJ 每次任务固定返回 4 张图片，仅支持图片参考');
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

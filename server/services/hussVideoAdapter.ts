import { randomUUID } from 'node:crypto';
import { publishReferenceUrl } from './publicReferenceService.js';
import type { ModelInputLimits } from '../../shared/modelRouting.js';

export const HUSS_CHANNEL_TYPE = 'huss';
export const HUSS_BASE_URL = 'https://www.huss.top';
export const HUSS_BB_MODEL = 'bb-seedance2.5-301010';
export type HussChannel = { type?: string; baseUrl: string; apiKey: string; timeout?: number };
export type HussVideoInput = { model: string; prompt: string; seconds: number; ratio: string; resolution: string; images: string[]; videos: string[]; audios: string[]; firstFrame?: string; lastFrame?: string; idempotencyKey?: string; publicBaseUrl: string };
export type HussVideoModel = { id: string; name: string; type: 'video'; config: Record<string, unknown> };

export function isHussChannel(channel: { type?: string; baseUrl?: string } | null | undefined) {
  if (channel?.type === HUSS_CHANNEL_TYPE) return true;
  try { return ['huss.top', 'www.huss.top'].includes(new URL(channel?.baseUrl || '').hostname); } catch { return false; }
}
export function hussApiBase(baseUrl: string) {
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('HUSS 接口地址无效');
  const p = url.pathname.replace(/\/+$/, ''); url.pathname = /\/v1$/i.test(p) ? p.slice(0, -3) || '/' : p || '/';
  return url.href.replace(/\/$/, '');
}
export class HussApiError extends Error { constructor(message: string, readonly status: number, readonly uncertain = false) { super(message); } }
async function hussRequest(channel: HussChannel, endpoint: string, body?: unknown, idempotencyKey?: string) {
  const generation = body !== undefined;
  let response: Response;
  try {
    response = await fetch(hussApiBase(channel.baseUrl) + '/v1' + endpoint, { method: generation ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + channel.apiKey, ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}), ...(generation ? { 'Content-Type': 'application/json' } : {}) },
      ...(generation ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(channel.timeout || (generation ? 900_000 : 60_000)), redirect: 'error' });
  } catch { throw new HussApiError('HUSS 连接失败' + (generation ? '，提交结果待核实，请勿重复生成' : ''), 0, generation); }
  let payload: any; try { payload = await response.json(); } catch { throw new HussApiError('HUSS 响应无法解析', response.status, generation); }
  const failure = payload?.error || payload?.code && payload.code !== 0;
  if (!response.ok || failure) {
    const detail = String(payload?.error?.message || payload?.error || payload?.message || '接口暂不可用');
    throw new HussApiError('HUSS 请求失败：' + (channel.apiKey ? detail.split(channel.apiKey).join('[REDACTED]') : detail).slice(0, 300), response.status || 502,
      generation && (Boolean(payload?.id || payload?.data?.id) || response.status === 408 || response.status >= 500));
  }
  return payload;
}
export function hussBbModelLimits(): ModelInputLimits { return { maxImages: 30, maxVideos: 10, maxAudios: 10, maxOutputs: 1, minImages: 0, resolutions: ['720p'], ratios: ['16:9', '9:16', '1:1'], qualities: [], firstFrame: false, lastFrame: false, duration: { mode: 'range', min: 10, max: 30, step: 1, values: [] } }; }
export async function fetchHussVideoModels(channel: HussChannel): Promise<HussVideoModel[]> {
  const raw = await hussRequest(channel, '/models'); const candidates = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : Array.isArray(raw?.models) ? raw.models : [];
  if (!candidates.some((item: any) => (typeof item === 'string' ? item : item?.id) === HUSS_BB_MODEL)) throw new Error('HUSS 当前 API Key 未开放 bb-seedance2.5-301010 模型');
  return [{ id: HUSS_BB_MODEL, name: HUSS_BB_MODEL, type: 'video', config: { limits: hussBbModelLimits() } }];
}
export function hussVideoParameters(input: HussVideoInput) {
  const limits = hussBbModelLimits();
  if (input.model !== HUSS_BB_MODEL) throw new Error('HUSS 当前仅支持 bb-seedance2.5-301010');
  if (input.firstFrame || input.lastFrame) throw new Error('HUSS bb-seedance2.5-301010 不支持独立首尾帧，请作为普通参考图片提交');
  if (!input.prompt.trim() || Array.from(input.prompt.trim()).length > 20_000) throw new Error('HUSS 提示词长度须为 1–20000 字符');
  if (!Number.isInteger(input.seconds) || input.seconds < 10 || input.seconds > 30) throw new Error('HUSS bb-seedance2.5-301010 视频时长须为 10–30 秒整数');
  if (input.resolution !== '720p' || !limits.ratios.includes(input.ratio)) throw new Error('HUSS bb-seedance2.5-301010 仅支持 720p 和 16:9、9:16、1:1');
  if (input.images.length > 30 || input.videos.length > 10 || input.audios.length > 10) throw new Error('HUSS 参考素材数量超过模型上限');
  const key = input.idempotencyKey || randomUUID(); if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) throw new Error('HUSS 请求标识仅支持 1–128 位字母、数字、点、下划线、冒号和短横线');
  return { key, payload: { model: HUSS_BB_MODEL, prompt: input.prompt.trim(), duration: input.seconds, ratio: input.ratio, resolution: input.resolution } };
}
export async function submitHussVideo(channel: HussChannel, input: HussVideoInput, beforeSubmit: (payload: Record<string, unknown>) => void) {
  const { key, payload } = hussVideoParameters(input); const publish = (items: string[]) => items.map(item => publishReferenceUrl(item, input.publicBaseUrl));
  const request = { ...payload, ...(input.images.length ? { reference_images: publish(input.images) } : {}), ...(input.videos.length ? { videos: publish(input.videos) } : {}), ...(input.audios.length ? { audios: publish(input.audios) } : {}) };
  beforeSubmit({ ...request, idempotency_key: key }); const result = await hussRequest(channel, '/videos', request, key); const id = result?.id ?? result?.data?.id;
  if ((typeof id !== 'string' && typeof id !== 'number') || !String(id).trim()) throw new HussApiError('HUSS 未返回任务编号，提交结果待核实', 202, true); return String(id);
}
export function normalizeHussTask(raw: any, baseUrl: string) {
  const data = raw?.data && typeof raw.data === 'object' ? raw.data : raw; const original = String(data?.status || '').toLowerCase();
  const status = ({ queued: 'queued', pending: 'queued', processing: 'running', in_progress: 'running', running: 'running', completed: 'completed', succeeded: 'completed', success: 'completed', failed: 'failed', rejected: 'failed', cancelled: 'cancelled', canceled: 'cancelled' } as Record<string, string>)[original];
  if (!status) throw new Error('HUSS 任务响应未包含有效状态'); const rawUrl = data?.url || data?.output?.url || data?.output?.video_url || data?.video_url || '';
  const url = rawUrl ? new URL(rawUrl, hussApiBase(baseUrl) + '/') : null; if (url && (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)) throw new Error('HUSS 视频结果地址无效');
  return { status, progress: Math.max(0, Math.min(100, Number(data?.progress) || (status === 'completed' ? 100 : 0))), resultUrl: status === 'completed' ? url?.href || '' : '', error: typeof data?.error === 'string' ? data.error : data?.error?.message || data?.message || '', errorCode: data?.error?.code || data?.error_code || '' };
}
export async function pollHussVideo(channel: HussChannel, taskId: string) { return normalizeHussTask(await hussRequest(channel, '/videos/' + encodeURIComponent(taskId)), channel.baseUrl); }

/**
 * Gemini 原生协议（generateContent / Files API / TTS）的上游地址解析。
 *
 * 地址只来自后台「渠道管理」中已启用的 gemini 类型渠道，或部署方显式配置的
 * GEMINI_API_BASE_URL。代码中不再内置任何默认上游；已下线的 AIStudio2API 代理
 * 不论通过渠道还是环境变量配置，均拒绝使用。
 */

export type GeminiChannelLike = { id?: number; name?: string | null; baseUrl?: string | null; apiKey?: string | null };
export type GeminiEndpoint = { baseUrl: string; apiKey: string; keyId?: number | null; channelId: number | null; source: 'channel' | 'env' };

const RETIRED_HOSTS = new Set(['172.245.16.80']);
const RETIRED_NAME = /aistudio\s*2\s*api|aistudioto\s*api/i;

export class GeminiEndpointError extends Error {
  status = 503;
  code = 'GEMINI_CHANNEL_NOT_CONFIGURED';
  constructor(message: string) { super(message); }
}

export function normalizeGeminiBaseUrl(raw: string | null | undefined): string {
  return String(raw || '').trim().replace(/\/+$/, '').replace(/\/v1beta$/i, '').replace(/\/+$/, '');
}

export function isRetiredGeminiEndpoint(name: string | null | undefined, baseUrl: string | null | undefined): boolean {
  if (RETIRED_NAME.test(`${name || ''} ${baseUrl || ''}`)) return true;
  try { return RETIRED_HOSTS.has(new URL(normalizeGeminiBaseUrl(baseUrl)).hostname); } catch { return false; }
}

function validUrl(value: string) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; }
  catch { return false; }
}

/**
 * 先用启用中的 gemini 渠道（按渠道优先级排序后的第一个可用渠道），再用显式环境变量。
 * 密钥与地址成对取用，避免把某个上游的密钥发到另一个上游。
 */
export function resolveGeminiEndpoint(
  channels: GeminiChannelLike[],
  env: { GEMINI_API_BASE_URL?: string; GEMINI_API_KEY?: string },
  modelApiKey?: string | null,
): GeminiEndpoint {
  const channel = channels.find(c => {
    const base = normalizeGeminiBaseUrl(c.baseUrl);
    return base && validUrl(base) && !isRetiredGeminiEndpoint(c.name, base);
  });
  if (channel) {
    const apiKey = modelApiKey || channel.apiKey || '';
    if (!apiKey) throw new GeminiEndpointError(`Gemini 渠道「${channel.name || channel.id}」未配置 API Key，请在后台「渠道管理」补充`);
    return { baseUrl: normalizeGeminiBaseUrl(channel.baseUrl), apiKey, channelId: channel.id ?? null, source: 'channel' };
  }
  const envBase = normalizeGeminiBaseUrl(env.GEMINI_API_BASE_URL);
  if (envBase && validUrl(envBase) && !isRetiredGeminiEndpoint('', envBase)) {
    const apiKey = modelApiKey || env.GEMINI_API_KEY || '';
    if (!apiKey) throw new GeminiEndpointError('已配置 GEMINI_API_BASE_URL 但缺少 GEMINI_API_KEY');
    return { baseUrl: envBase, apiKey, channelId: null, source: 'env' };
  }
  const retiredOnly = channels.some(c => isRetiredGeminiEndpoint(c.name, c.baseUrl)) || (envBase && isRetiredGeminiEndpoint('', envBase));
  throw new GeminiEndpointError(retiredOnly
    ? '当前 Gemini 配置指向已下线的 AIStudio2API 代理，已停止调用；请在后台「渠道管理」配置新的 Gemini 渠道'
    : '未配置可用的 Gemini 渠道：请在后台「渠道管理」添加并启用 Gemini 类型渠道（含 Base URL 与 API Key）');
}

/**
 * 解析有序候选端点列表（支持同渠道多 Key 池轮转与 429 故障转移）。
 */
export function resolveGeminiEndpoints(
  channels: GeminiChannelLike[],
  env: { GEMINI_API_BASE_URL?: string; GEMINI_API_KEY?: string },
  modelApiKey?: string | null,
  resolveChannelKeys?: (channelId: number, fallbackApiKey?: string | null) => Array<{ id: number | null; apiKey: string }>,
): GeminiEndpoint[] {
  const usableChannels = channels.filter(c => {
    const base = normalizeGeminiBaseUrl(c.baseUrl);
    return base && validUrl(base) && !isRetiredGeminiEndpoint(c.name, base);
  });

  if (usableChannels.length > 0) {
    const out: GeminiEndpoint[] = [];
    for (const ch of usableChannels) {
      const baseUrl = normalizeGeminiBaseUrl(ch.baseUrl);
      if (modelApiKey) {
        out.push({ baseUrl, apiKey: modelApiKey, keyId: null, channelId: ch.id ?? null, source: 'channel' });
        continue;
      }
      const poolKeys = ch.id && resolveChannelKeys ? resolveChannelKeys(ch.id, ch.apiKey) : [];
      if (poolKeys.length > 0) {
        for (const k of poolKeys) {
          out.push({ baseUrl, apiKey: k.apiKey, keyId: k.id, channelId: ch.id ?? null, source: 'channel' });
        }
      } else if (ch.apiKey?.trim()) {
        out.push({ baseUrl, apiKey: ch.apiKey.trim(), keyId: null, channelId: ch.id ?? null, source: 'channel' });
      }
    }
    if (out.length > 0) return out;
    throw new GeminiEndpointError(`Gemini 渠道「${usableChannels[0].name || usableChannels[0].id}」未配置 API Key，请在「Gemini Key 池」或「渠道管理」补充`);
  }

  return [resolveGeminiEndpoint(channels, env, modelApiKey)];
}

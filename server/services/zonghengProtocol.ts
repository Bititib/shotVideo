export const V6K_BASE_URL = 'https://www.v6k.top';
export const V6K_CHANNEL_TYPE = 'zongheng-v6k';
export type ZonghengProtocol = 'v6k';
export const RETIRED_ZONGHENG_MESSAGE = '旧视频接口已停用，此历史任务需人工核实；不会自动重新生成或退款';
export function retiredZonghengBase(base: string): boolean {
  try { return new URL(base).hostname === 'cnd-coo-new.pages.dev'; } catch { return false; }
}
export function isRetiredZonghengTask(metadata: Record<string, any>): boolean {
  return metadata.zonghengLegacyTask === true || metadata.zonghengProtocol !== 'v6k';
}
export function v6kQueryRetryDelay(failures: number, retryAfter?: string | null): number {
  const backoff = Math.min(120_000, 20_000 * 2 ** Math.min(4, Math.max(0, failures - 1)));
  const seconds = retryAfter ? Number(retryAfter) : NaN;
  const requested = Number.isFinite(seconds) ? seconds * 1000 : retryAfter ? Date.parse(retryAfter) - Date.now() : 0;
  return Math.max(backoff, Number.isFinite(requested) ? Math.max(0, requested) : 0);
}
export function zonghengProtocol(channel: { type?: string | null }, metadata?: Record<string, any>): ZonghengProtocol {
  return 'v6k';
}
/** No credentials in task metadata; the original channel still owns its key. */
export function zonghengProtocolSnapshot(channel: { type?: string | null; baseUrl: string }) {
  return { zonghengProtocol: zonghengProtocol(channel), zonghengBaseUrl: channel.baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '') };
}
export function zonghengTaskChannel<T extends { type?: string | null; baseUrl: string }>(channel: T, metadata: Record<string, any>): T {
  if (isRetiredZonghengTask(metadata)) throw new Error(RETIRED_ZONGHENG_MESSAGE);
  return { ...channel, type: V6K_CHANNEL_TYPE, baseUrl: metadata.zonghengBaseUrl || channel.baseUrl };
}

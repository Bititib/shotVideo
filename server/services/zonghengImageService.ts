import { buildZonghengImagePayload, zonghengBaseUrl, zonghengError, ZonghengSubmissionError } from './zonghengAdapter.js';
export async function generateZonghengImages(base: string, key: string, input: Parameters<typeof buildZonghengImagePayload>[0], beforeSubmit: () => void = () => {}, timeout = 180_000) {
  const body = JSON.stringify(buildZonghengImagePayload(input));
  beforeSubmit();
  try {
    const response = await fetch(zonghengBaseUrl(base) + '/v1/images/generations', { method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body,
      signal: AbortSignal.timeout(timeout), redirect: 'error' });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new ZonghengSubmissionError(`纵横科技图片请求失败 (${response.status})：${zonghengError(payload)}`, Boolean(payload.task_id) || response.status === 408 || response.status >= 500);
    }
    const payload = await response.json() as any;
    const items = Array.isArray(payload.data) ? payload.data.filter((i: any) => typeof i?.url === 'string' || typeof i?.b64_json === 'string') : [];
    if (!items.length || items.length > input.n) throw new ZonghengSubmissionError('纵横科技已响应，但图片结果无法确认，请勿重复提交', true);
    return items.map((i: any) => ({ url: i.url ? new URL(i.url, zonghengBaseUrl(base)).href : 'data:image/png;base64,' + i.b64_json }));
  } catch (error: any) {
    if (error instanceof ZonghengSubmissionError) throw error;
    throw new ZonghengSubmissionError('纵横科技图片提交结果待核实，请勿重复提交', true);
  }
}

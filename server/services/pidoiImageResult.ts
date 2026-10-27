export type PidoiResultAuth = { baseUrl: string; apiKey: string; taskId: string };

/** Only this provider's documented content endpoint for this exact task may receive its key. */
export function pidoiContentUrl(source: string, baseUrl: string, taskId: string): string | null {
  try {
    const base = new URL(baseUrl), url = new URL(source, base);
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(taskId) || base.protocol !== 'https:'
      || !(base.hostname === 'pidoi.com' || base.hostname.endsWith('.pidoi.com'))
      || url.origin !== base.origin || url.username || url.password
      || url.pathname !== `/v1/image/generations/${taskId}/content`) return null;
    const entries = [...url.searchParams];
    if (entries.length > 1 || entries.some(([key,value]) => key !== 'index' || !/^\d{1,2}$/.test(value))) return null;
    return url.href;
  } catch { return null; }
}

export async function downloadPidoiContent(source: string, auth: PidoiResultAuth): Promise<Buffer> {
  const url = pidoiContentUrl(source, auth.baseUrl, auth.taskId);
  if (!url || !auth.apiKey) throw new Error('Pidoi 图片鉴权下载地址与原任务不匹配');
  const response = await fetch(url, { method: 'GET', headers: { Authorization: 'Bearer ' + auth.apiKey },
    redirect: 'error', signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Pidoi 原图片下载 HTTP ${response.status}`);
  const maxBytes = 20 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel(); throw new Error('Pidoi 图片超过 20MB');
  }
  if (!response.body) throw new Error('Pidoi 图片响应为空');
  const reader = response.body.getReader(); const parts: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const {done,value} = await reader.read(); if (done) break;
      bytes += value.length;
      if (bytes > maxBytes) { await reader.cancel(); throw new Error('Pidoi 图片超过 20MB'); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(parts);
}

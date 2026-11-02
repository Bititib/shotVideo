/** HUSS content GET: inactivity deadline, not a five-minute body deadline. */
export async function fetchHussDownload(url: string, key: string): Promise<Response> {
  const abort = new AbortController();
  let received = 0;
  let idle: ReturnType<typeof setTimeout>;
  let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const fail = (reason: string) => {
    const error = new Error(`HUSS 成品下载${reason}；已接收 ${received} 字节`);
    abort.abort(error);
    bodyController?.error(error);
    clearTimeout(idle); clearTimeout(total);
  };
  const touch = () => { clearTimeout(idle); idle = setTimeout(() => fail('连续 90 秒无数据'), 90_000); };
  const total = setTimeout(() => fail('超过 30 分钟上限'), 30 * 60_000);
  const clear = () => { clearTimeout(idle); clearTimeout(total); };
  touch();
  try {
    for (let hop = 0; hop <= 5; hop++) {
      const response = await fetch(url, { method: 'GET', redirect: 'manual', signal: abort.signal, cache: 'no-store',
        headers: hop === 0 ? { Authorization: 'Bearer ' + key } : {} });
      touch();
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location || hop === 5) throw new Error('HUSS 原任务下载入口重定向缺少地址或次数超限');
        const next = new URL(location, url);
        if (next.protocol !== 'https:' || next.username || next.password) throw new Error('HUSS 原任务下载入口返回无效重定向地址');
        url = next.href; continue;
      }
      if (!response.body) { clear(); return response; }
      const reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>({
        start(controller) { bodyController = controller; },
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (abort.signal.aborted) return;
            if (chunk.done) { clear(); controller.close(); return; }
            received += chunk.value.byteLength; touch(); controller.enqueue(chunk.value);
          } catch (error) { clear(); if (!abort.signal.aborted) controller.error(error); }
        },
        async cancel() { clear(); abort.abort(); await reader.cancel().catch(() => {}); },
      });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    throw new Error('HUSS 原任务下载未返回响应');
  } catch (error) { clear(); throw abort.signal.reason || error; }
}

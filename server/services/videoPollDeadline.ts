/** A hard deadline also works when a transport ignores AbortSignal. Never wrap a billing mutation. */
export class VideoPollTimeout extends Error {
  constructor(stage: string) { super(stage + ' timed out; retry the original task'); this.name = 'VideoPollTimeout'; }
}
export async function withVideoPollDeadline<T>(operation: () => Promise<T>, ms: number, stage: string, abort?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_, reject) => { timer = setTimeout(() => {
        reject(new VideoPollTimeout(stage));
        try { abort?.(); } catch { /* Cancellation is best effort; the deadline is authoritative. */ }
      }, ms); }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
/** Buffer the small task response under ONE deadline, including headers and body. */
export async function fetchVideoTaskResponse(url: string, init: RequestInit, timeoutMs = 15_000): Promise<Response> {
  const controller = new AbortController();
  return withVideoPollDeadline(async () => {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = await response.text();
    return new Response([204, 205, 304].includes(response.status) ? null : body, {
      status: response.status, statusText: response.statusText, headers: response.headers,
    });
  }, timeoutMs, 'Video task query', () => controller.abort());
}

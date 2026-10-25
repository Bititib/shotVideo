export const MODEL_LIST_TIMEOUT_MS = 15_000;

/** Bound both the headers and body read; a stalled request must release the shared cache slot. */
export async function requestModelList<T>(endpoint: string, token: string | null, valid: (item: any) => boolean): Promise<T[]> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('模型列表加载超时（15 秒），请重试'));
      controller.abort();
    }, MODEL_LIST_TIMEOUT_MS);
  });
  const request = async () => {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: controller.signal,
      });
    } catch {
      throw new Error('模型列表网络连接失败，请检查网络后重试');
    }
    if (!response.ok) {
      const reason = response.status === 401 ? '登录已过期，请重新登录'
        : response.status === 403 ? '无权访问模型列表'
        : response.status === 429 ? '请求过于频繁，请稍后重试'
        : '模型列表请求失败，请重试';
      throw new Error(`${reason}（HTTP ${response.status}）`);
    }
    let data: unknown;
    try { data = await response.json(); }
    catch { throw new Error(`模型列表响应不是有效 JSON（HTTP ${response.status}）`); }
    if (!Array.isArray(data) || !data.every(valid)) {
      throw new Error(`模型列表返回格式异常（HTTP ${response.status}）`);
    }
    return data as T[];
  };
  try { return await Promise.race([request(), timeout]); }
  finally { clearTimeout(timer!); }
}

export const isGenerationModel = (item: any): boolean => Boolean(item
  && typeof item.id === 'string' && typeof item.name === 'string'
  && typeof item.available === 'boolean');

import { getAuthSession, invalidateAuthSession } from './authSession';

const API_BASE = '/api';

interface RequestOptions extends RequestInit {
  skipAuth?: boolean;
  timeoutMs?: number;
}

class ApiClient {
  async request<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
    const { skipAuth, headers: customHeaders, timeoutMs, ...rest } = options;
    const session = getAuthSession();

    const headers: Record<string, string> = {
      ...(customHeaders as Record<string, string> || {}),
    };

    // 只有非 FormData 请求才设置 Content-Type
    if (!(rest.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }

    if (!skipAuth) {
      const token = session.token;
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
    }

    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (rest.signal?.aborted) cancel();
    else rest.signal?.addEventListener('abort', cancel, { once: true });
    const timer = globalThis.setTimeout(cancel, timeoutMs ?? (rest.method === 'GET' ? 30000 : 180000));
    try {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      ...rest,
      signal: controller.signal,
      headers,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      if (response.status === 401 && !skipAuth && session.token) {
        invalidateAuthSession(session);
      }
      const fallback = response.status === 401
        ? (skipAuth ? '登录验证失败' : session.token ? '登录已过期，请重新登录' : '请先登录')
        : `请求失败 (${response.status})`;
      const error: any = new Error(errorData?.error || fallback);
      error.status = response.status;
      error.data = errorData;
      throw error;
    }

    return await response.json();
    } catch (error) {
      if (controller.signal.aborted && !rest.signal?.aborted) {
        throw new Error(rest.method === 'GET' ? '加载超时，请重试' : '请求超时，请先刷新核实操作结果，避免重复提交');
      }
      throw error;
    } finally {
      globalThis.clearTimeout(timer);
      rest.signal?.removeEventListener('abort', cancel);
    }
  }

  get<T>(endpoint: string, options?: RequestOptions) {
    return this.request<T>(endpoint, { ...options, method: 'GET' });
  }

  post<T>(endpoint: string, body?: any, options?: RequestOptions) {
    if (body instanceof FormData) {
      return this.request<T>(endpoint, { ...options, method: 'POST', body });
    }
    return this.request<T>(endpoint, { ...options, method: 'POST', body: JSON.stringify(body) });
  }

  put<T>(endpoint: string, body?: any, options?: RequestOptions) {
    return this.request<T>(endpoint, { ...options, method: 'PUT', body: JSON.stringify(body) });
  }

  delete<T>(endpoint: string, options?: RequestOptions) {
    return this.request<T>(endpoint, { ...options, method: 'DELETE' });
  }
}

export const api = new ApiClient();

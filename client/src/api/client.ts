const API_BASE = '/api';

interface RequestOptions extends RequestInit {
  skipAuth?: boolean;
}

class ApiClient {
  private getToken(): string | null {
    return localStorage.getItem('token');
  }

  async request<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
    const { skipAuth, headers: customHeaders, ...rest } = options;

    const headers: Record<string, string> = {
      ...(customHeaders as Record<string, string> || {}),
    };

    // 只有非 FormData 请求才设置 Content-Type
    if (!(rest.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }

    if (!skipAuth) {
      const token = this.getToken();
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
    }

    const response = await fetch(`${API_BASE}${endpoint}`, {
      ...rest,
      headers,
    });

    if (response.status === 401) {
      const hadToken = !!this.getToken();
      if (hadToken) {
        // token 过期 → 清除并提示重新登录
        localStorage.removeItem('token');
      }
      // 不自动跳转，让调用方决定（如 useAuthGuard 弹登录框）
      throw new Error(hadToken ? '登录已过期，请重新登录' : '请先登录');
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const error: any = new Error(errorData.error || `请求失败 (${response.status})`);
      error.status = response.status;
      error.data = errorData;
      throw error;
    }

    return response.json();
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

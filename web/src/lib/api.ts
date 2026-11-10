import { useAuthStore } from '@/stores/auth';

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

/** 统一 API 客户端：注入 Bearer token、401 自动登出、错误结构解析 */
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const token = useAuthStore.getState().token;
  const res = await fetch(`/api${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  });

  if (res.status === 401) {
    useAuthStore.getState().logout();
    throw new ApiError('UNAUTHENTICATED', 401, '登录已过期，请重新登录');
  }

  if (!res.ok) {
    let code = 'HTTP_ERROR';
    let message = `请求失败（${res.status}）`;
    let details: unknown;
    try {
      const json = (await res.json()) as { error?: { code?: string; message?: string; details?: unknown } };
      if (json.error) {
        code = json.error.code ?? code;
        message = json.error.message ?? message;
        details = json.error.details;
      }
    } catch {
      // 非 JSON 错误体，保留默认信息
    }
    throw new ApiError(code, res.status, message, details);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

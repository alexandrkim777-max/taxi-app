// API client. The panel talks to the same API as the apps, under /api on the same domain.
// The session token lives in sessionStorage: gone when the tab closes, never in a cookie
// readable by other sites. In the demo build every call is answered by an in-browser mock.

import { mockApi } from './mock';

declare const __DEMO__: boolean;
export const DEMO = __DEMO__;

const TOKEN_KEY = 'taxi_admin_token';

export function getToken(): string | null {
  if (DEMO) return 'demo';
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable: the session lasts for this page only */
  }
}

export class ApiError extends Error {
  status: number;
  code: string;
  body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(String(body.error ?? status));
    this.status = status;
    this.code = String(body.error ?? 'error');
    this.body = body;
  }
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = opts.method ?? (opts.body === undefined ? 'GET' : 'POST');
  if (DEMO) {
    const res = await mockApi(method, path, opts.body);
    if (res.status >= 400) throw new ApiError(res.status, res.body as Record<string, unknown>);
    return res.body as T;
  }
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  if (res.status === 401) setToken(null);
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

// API client. The panel talks to the same API as the apps, under /api on the same domain.
// The session is an httpOnly cookie set by the server after SMS + authenticator sign-in: page
// scripts never see it. Every request carries the CSRF header the server requires for writes.
// In the demo build every call is answered by an in-browser mock.

import { mockApi } from './mock';

declare const __DEMO__: boolean;
export const DEMO = __DEMO__;

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

/** The shell registers this to drop back to the login screen when the session ends. */
let onSignedOut: (() => void) | null = null;
export function setSignedOutHandler(cb: (() => void) | null): void { onSignedOut = cb; }

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  const method = opts.method ?? (opts.body === undefined ? 'GET' : 'POST');
  if (DEMO) {
    const res = await mockApi(method, path, opts.body);
    if (res.status >= 400) throw new ApiError(res.status, res.body as Record<string, unknown>);
    return res.body as T;
  }
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      'x-requested-with': 'taxi-admin',
      ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...opts.headers,
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  if (res.status === 401 && path !== '/me') onSignedOut?.();
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

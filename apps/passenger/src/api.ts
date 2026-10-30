// API client for the passenger app. In the demo build (EXPO_PUBLIC_DEMO=1) every call is answered
// by an in-app mock, so the whole flow can be clicked through without a server.

import { getItem, setItem } from './storage';
import { mockApi } from './mock';

export const DEMO = process.env.EXPO_PUBLIC_DEMO === '1';
const BASE = (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const TOKEN_KEY = 'session_token';
/** Sent with every request so search results and tags come back in the user's language. */
let language = 'uz';
export function setApiLanguage(l: string): void { language = l; }
let token: string | null = null;

export async function loadToken(): Promise<string | null> {
  token = DEMO ? token : await getItem(TOKEN_KEY);
  return token;
}

export async function saveToken(t: string | null): Promise<void> {
  token = t;
  if (!DEMO) await setItem(TOKEN_KEY, t);
}

let unauthorized: (() => void) | null = null;
/** Called when the server says the session is no longer valid (signed out elsewhere, blocked). */
export function onUnauthorized(fn: () => void): void { unauthorized = fn; }

export function currentToken(): string | null {
  return token;
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

/** A random v4 UUID for idempotency keys (not a secret, so Math.random is enough where crypto is missing). */
export function newKey(): string {
  const g = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  const b = new Uint8Array(16);
  if (g?.getRandomValues) g.getRandomValues(b); else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6]! & 0x0f) | 0x40; b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * `idempotencyKey`: a write that is safe to repeat (the server returns the first result for the same
 * key), so it is retried once after a network error like a read.
 */
export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; idempotencyKey?: string; retry?: boolean } = {}): Promise<T> {
  const method = opts.method ?? (opts.body === undefined ? 'GET' : 'POST');
  if (DEMO) {
    const res = await mockApi(method, path, opts.body);
    if (res.status >= 400) throw new ApiError(res.status, res.body as Record<string, unknown>);
    return res.body as T;
  }
  // Bad mobile networks: every request has a time limit; reads (and writes with an idempotency key)
  // are retried once; other writes never, so nothing is done twice.
  let res: Response | null = null;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
          ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          'accept-language': language,
          ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}),
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(method === 'GET' ? 10_000 : 15_000),
      });
      break;
    } catch (e) {
      if ((method !== 'GET' && !opts.idempotencyKey && !opts.retry) || attempt >= 1) throw new ApiError(0, { error: 'network' });
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (res.status === 204) return null as T;
  if (res.status === 401 && token) { await saveToken(null); unauthorized?.(); }
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

export function errorText(err: unknown, errors?: Record<string, string>): string {
  if (err instanceof ApiError) return errors?.[err.code] ?? err.code;
  return err instanceof Error ? err.message : String(err);
}

// The user's language (chosen on the first screen) decides which label the API returns.

import type { FastifyRequest } from 'fastify';

export type Lang = 'uz' | 'ru' | 'en';
export const LANGS: readonly Lang[] = ['uz', 'ru', 'en'];

/** Logged-in user's language; otherwise ?lang=, then Accept-Language, then Uzbek. */
export function langOf(request: FastifyRequest): Lang {
  const userLang = request.user?.language;
  if (userLang && LANGS.includes(userLang as Lang)) return userLang as Lang;
  const q = (request.query as Record<string, unknown> | undefined)?.lang;
  if (typeof q === 'string' && LANGS.includes(q as Lang)) return q as Lang;
  const header = String(request.headers['accept-language'] ?? '').slice(0, 2).toLowerCase();
  if (LANGS.includes(header as Lang)) return header as Lang;
  return 'uz';
}

/** One label out of a { uz, ru, en } object, falling back to Uzbek. */
export function pick(label: Partial<Record<Lang, string>> | null | undefined, lang: Lang): string {
  return label?.[lang] ?? label?.uz ?? '';
}

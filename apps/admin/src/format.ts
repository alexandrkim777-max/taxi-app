// Formatting: money (tiyin -> sum), plates, phones, dates in Tashkent time.

import type { Lang } from './i18n';

export function sum(tiyin: number | null | undefined, lang: Lang): string {
  if (tiyin === null || tiyin === undefined) return '—';
  const s = Math.round(tiyin / 100).toLocaleString('ru-RU').replace(/ /g, ' ');
  return `${s} ${lang === 'uz' ? 'soʻm' : 'сум'}`;
}

/** 01A123BC -> 01 A 123 BC */
export function plate(p: string | null | undefined): string {
  if (!p) return '—';
  const m = p.match(/^(\d{2})([A-Z])(\d{3})([A-Z]{2})$/);
  if (m) return `${m[1]} ${m[2]} ${m[3]} ${m[4]}`;
  const m2 = p.match(/^(\d{2})(\d{3})([A-Z]{3})$/);
  return m2 ? `${m2[1]} ${m2[2]} ${m2[3]}` : p;
}

/** +998901234567 -> +998 90 123 45 67 */
export function phone(p: string | null | undefined): string {
  if (!p) return '—';
  const m = p.match(/^\+998(\d{2})(\d{3})(\d{2})(\d{2})$/);
  return m ? `+998 ${m[1]} ${m[2]} ${m[3]} ${m[4]}` : p;
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ru-RU', {
    timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

export function date(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('ru-RU', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function pick(label: unknown, lang: Lang): string {
  if (typeof label === 'string') return label;
  const l = label as Record<string, string> | null;
  return l?.[lang] ?? l?.ru ?? l?.uz ?? '';
}

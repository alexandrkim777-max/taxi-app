import type { Lang } from './i18n';

export function money(tiyin: number | null | undefined, lang: Lang): string {
  if (tiyin === null || tiyin === undefined) return '—';
  const s = Math.round(tiyin / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${s} ${lang === 'uz' ? 'soʻm' : lang === 'ru' ? 'сум' : 'sum'}`;
}

export function plate(p: string | null | undefined): string {
  if (!p) return '—';
  const m = p.match(/^(\d{2})([A-Z])(\d{3})([A-Z]{2})$/);
  return m ? `${m[1]} ${m[2]} ${m[3]} ${m[4]}` : p;
}

export function km(m: number): string {
  return (m / 1000).toFixed(m < 10_000 ? 1 : 0).replace('.', ',');
}

export function mmss(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function date(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

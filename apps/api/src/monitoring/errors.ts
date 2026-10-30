// Error monitoring without a third-party service: errors are grouped by kind in our own database (in
// Uzbekistan, like everything else), shown in the staff panel, and a new kind can ping a Telegram chat.
// Nothing personal is kept: phone numbers, tokens, card numbers and emails are cut out first.

import { createHash } from 'node:crypto';
import type pg from 'pg';

export type ErrorSource = 'api' | 'job' | 'passenger' | 'driver' | 'admin';

export interface ErrorReport {
  source: ErrorSource;
  message: string;
  stack?: string | null;
  context?: Record<string, string | number | boolean | null>;
  appVersion?: string | null;
}

const MAX_MESSAGE = 500;
const MAX_STACK = 4000;

/** Cuts personal data and secrets out of free text before it is stored or sent anywhere. */
export function scrub(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [token]')
    .replace(/__Host-taxi_staff=[^;\s]+/g, '__Host-taxi_staff=[token]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\b\d(?:[ -]?\d){12,18}\b/g, '[card]')
    .replace(/\+?998[\s-]?\d{2}[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}/g, '[phone]')
    .replace(/\b\d{9}\b/g, '[phone]');
}

/** Same kind of error = same fingerprint: ids, numbers and line columns do not split a group. */
export function fingerprintOf(r: ErrorReport): string {
  const norm = (s: string) => s
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/\d+/g, '<n>');
  const firstFrame = (r.stack ?? '').split('\n').map((l) => l.trim()).find((l) => l.startsWith('at ') || l.includes('@')) ?? '';
  const where = r.context?.route ?? r.context?.job ?? r.context?.screen ?? '';
  return createHash('sha1').update(`${r.source}|${norm(r.message)}|${norm(firstFrame)}|${where}`).digest('hex');
}

export interface Alerter {
  notify(text: string): Promise<void>;
}

/** Telegram bot message to a chat (ALERT_TELEGRAM_BOT_TOKEN, ALERT_TELEGRAM_CHAT_ID). At most 20 an hour. */
export class TelegramAlerter implements Alerter {
  private readonly token: string;
  private readonly chatId: string;
  private sent: number[] = [];
  constructor(token: string, chatId: string) {
    this.token = token;
    this.chatId = chatId;
  }

  async notify(text: string): Promise<void> {
    const now = Date.now();
    this.sent = this.sent.filter((t) => now - t < 3_600_000);
    if (this.sent.length >= 20) return;
    this.sent.push(now);
    await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: this.chatId, text: text.slice(0, 3500), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(5000),
    });
  }
}

export class ErrorMonitor {
  private readonly db: pg.Pool;
  private readonly alerter: Alerter | null;
  private readonly label: string;

  constructor(db: pg.Pool, alerter: Alerter | null = null, label = 'taxi') {
    this.db = db;
    this.alerter = alerter;
    this.label = label;
  }

  /**
   * Stores one occurrence. A kind seen for the first time, or again after it was marked resolved,
   * triggers an alert. Never throws: monitoring must not break what it watches.
   */
  async record(r: ErrorReport): Promise<'new' | 'reopened' | 'repeat' | 'failed'> {
    try {
      const message = scrub(r.message || 'Error').slice(0, MAX_MESSAGE);
      const stack = r.stack ? scrub(r.stack).slice(0, MAX_STACK) : null;
      const context = Object.fromEntries(Object.entries(r.context ?? {}).slice(0, 12)
        .map(([k, v]) => [k.slice(0, 40), typeof v === 'string' ? scrub(v).slice(0, 200) : v]));
      const report = { ...r, message, stack };
      const { rows } = await this.db.query<{ inserted: boolean; reopened: boolean }>(
        `INSERT INTO error_events (fingerprint, source, message, stack, context, app_version)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (fingerprint) DO UPDATE
           SET count = error_events.count + 1, last_seen = now(), message = EXCLUDED.message,
               stack = coalesce(EXCLUDED.stack, error_events.stack), context = EXCLUDED.context,
               app_version = coalesce(EXCLUDED.app_version, error_events.app_version), resolved_at = NULL
         RETURNING (xmax = 0) AS inserted,
                   (SELECT resolved_at IS NOT NULL FROM error_events e WHERE e.fingerprint = $1) AS reopened`,
        [fingerprintOf(report), r.source, message, stack, JSON.stringify(context), r.appVersion?.slice(0, 40) ?? null],
      );
      const kind = rows[0]?.inserted ? 'new' : rows[0]?.reopened ? 'reopened' : 'repeat';
      if (kind !== 'repeat' && this.alerter) {
        const where = context.route ?? context.job ?? context.screen ?? '';
        this.alerter.notify(`[${this.label}] ${kind === 'new' ? 'New error' : 'Error is back'} (${r.source}${where ? `, ${where}` : ''}${r.appVersion ? `, v${r.appVersion}` : ''}):\n${message}`)
          .catch(() => {});
      }
      return kind;
    } catch {
      return 'failed';
    }
  }
}

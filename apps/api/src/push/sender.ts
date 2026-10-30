// Push delivery behind an adapter. Production: Expo's push service (it forwards to Apple and Google,
// so we hold no APNs / FCM keys on our servers). Development: the log, without the message text.

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  /** Android notification channel: 'orders' rings loudly for drivers, 'rides' for passengers. */
  channelId: 'orders' | 'rides';
  /** Seconds the push service keeps trying; a new-order alert is useless after its window. */
  ttl: number;
}

export type PushResult = { ok: true } | { ok: false; error: string; deviceGone: boolean };

export interface PushSender {
  readonly name: string;
  send(messages: PushMessage[]): Promise<PushResult[]>;
}

export class LogPushSender implements PushSender {
  readonly name = 'log';
  private readonly log: (msg: string) => void;
  constructor(log: (msg: string) => void = () => {}) {
    this.log = log;
  }
  async send(messages: PushMessage[]): Promise<PushResult[]> {
    for (const m of messages) this.log(`push (not sent, dev): ${String(m.data.kind)} to ${m.to.slice(0, 22)}…`);
    return messages.map(() => ({ ok: true }));
  }
}

const EXPO_URL = 'https://exp.host/--/api/v2/push/send';

export class ExpoPushSender implements PushSender {
  readonly name = 'expo';
  private readonly accessToken: string | undefined;
  constructor(accessToken?: string) {
    this.accessToken = accessToken || undefined;
  }

  async send(messages: PushMessage[]): Promise<PushResult[]> {
    const out: PushResult[] = [];
    // Expo accepts up to 100 messages per request.
    for (let i = 0; i < messages.length; i += 100) {
      const batch = messages.slice(i, i + 100);
      const res = await fetch(EXPO_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json', accept: 'application/json',
          ...(this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}),
        },
        body: JSON.stringify(batch.map((m) => ({
          to: m.to, title: m.title, body: m.body, data: m.data, sound: 'default',
          priority: 'high', channelId: m.channelId, ttl: m.ttl,
        }))),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`Expo push responded ${res.status}`);
      const body = (await res.json()) as { data?: { status: string; message?: string; details?: { error?: string } }[] };
      const tickets = body.data ?? [];
      for (let j = 0; j < batch.length; j++) {
        const t = tickets[j];
        if (t?.status === 'ok') out.push({ ok: true });
        else out.push({ ok: false, error: t?.details?.error ?? t?.message ?? 'unknown', deviceGone: t?.details?.error === 'DeviceNotRegistered' });
      }
    }
    return out;
  }
}

export function createPushSender(kind: string, accessToken: string | undefined, log: (msg: string) => void): PushSender {
  switch (kind) {
    case 'expo': return new ExpoPushSender(accessToken);
    case 'log': return new LogPushSender(log);
    default: throw new Error(`Unknown PUSH_PROVIDER: ${kind}`);
  }
}

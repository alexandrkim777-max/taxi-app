// SMS delivery behind an adapter, so the provider (e.g. a local Uzbek gateway)
// can be swapped by configuration without touching the auth code.

export interface SmsSender {
  send(phone: string, text: string): Promise<void>;
}

/** Development only: writes the message to the log instead of sending it. */
export class ConsoleSmsSender implements SmsSender {
  private readonly log: (msg: string) => void;
  constructor(log: (msg: string) => void = console.log) {
    this.log = log;
  }
  async send(phone: string, text: string): Promise<void> {
    this.log(`[sms to ${phone}] ${text}`);
  }
}

export function createSmsSender(provider: string): SmsSender {
  switch (provider) {
    case 'console':
      return new ConsoleSmsSender();
    default:
      throw new Error(`Unknown SMS provider: ${provider}. Add an adapter in src/sms.`);
  }
}

// Card tokens are stored encrypted (AES-256-GCM). A database leak alone does not let anyone
// charge our users' cards; the key lives only in the server's environment (PAYMENT_TOKEN_KEY).

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export class TokenCipher {
  private readonly key: Buffer;

  /** key: 32 bytes, base64-encoded. */
  constructor(keyBase64: string) {
    const key = Buffer.from(keyBase64, 'base64');
    if (key.length !== 32) throw new Error('PAYMENT_TOKEN_KEY must be 32 bytes, base64-encoded');
    this.key = key;
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join('.');
  }

  decrypt(stored: string): string {
    const [version, iv, tag, data] = stored.split('.');
    if (version !== 'v1' || !iv || !tag || !data) throw new Error('unknown token format');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  }
}

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Development-only key derived from a fixed string; production must set PAYMENT_TOKEN_KEY. */
export const DEV_TOKEN_KEY = createHash('sha256').update('dev-only-payment-token-key').digest('base64');

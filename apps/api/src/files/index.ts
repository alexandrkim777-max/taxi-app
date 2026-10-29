// Private file storage for driver documents (passport, licence, selfie...).
//
// - Uploads are checked by their first bytes (JPEG, PNG, WebP, HEIC only) and size, never by the
//   name or the Content-Type the client claims.
// - Files are never public. Clients get short-lived signed links (HMAC, 10 minutes) when they are
//   allowed to see a file: the driver for their own documents, staff in the dossier.
// - Storage sits behind an adapter: a local directory now, S3-compatible storage in Uzbekistan later.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

export interface FileStorage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
}

export class LocalFileStorage implements FileStorage {
  private readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  private path(key: string): string {
    const p = resolve(join(this.root, key));
    // Never leave the storage root, whatever the key says.
    if (!p.startsWith(this.root + sep)) throw new Error('bad key');
    return p;
  }
  async put(key: string, data: Buffer): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data, { flag: 'wx', mode: 0o600 });
  }
  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.path(key));
    } catch {
      return null;
    }
  }
}

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const KEY_RE = /^[a-z0-9_-]+(\/[a-z0-9_-]+)*\.(jpg|png|webp|heic)$/;

/** Detects the image type from its first bytes; null if it is not an image we accept. */
export function sniffImage(b: Buffer): { ext: 'jpg' | 'png' | 'webp' | 'heic'; contentType: string } | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: 'jpg', contentType: 'image/jpeg' };
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png', contentType: 'image/png' };
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return { ext: 'webp', contentType: 'image/webp' };
  const brand = b.subarray(4, 12).toString('latin1');
  if (/^ftyp(heic|heix|mif1|msf1)$/.test(brand)) return { ext: 'heic', contentType: 'image/heic' };
  return null;
}

const CONTENT_TYPES: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic' };

export class FileService {
  readonly storage: FileStorage;
  private readonly secret: string;
  private readonly baseUrl: string;
  readonly ttlSec: number;

  constructor(opts: { storage: FileStorage; secret: string; publicApiUrl: string; ttlSec?: number }) {
    this.storage = opts.storage;
    this.secret = opts.secret;
    this.baseUrl = opts.publicApiUrl.replace(/\/$/, '');
    this.ttlSec = opts.ttlSec ?? 600;
  }

  /** Stores an upload under a fresh random key; returns the reference to keep in the database. */
  async saveImage(prefix: string, data: Buffer): Promise<string> {
    const kind = sniffImage(data);
    if (!kind) throw Object.assign(new Error('unsupported_file'), { statusCode: 415 });
    const key = `${prefix}/${randomBytes(16).toString('hex')}.${kind.ext}`;
    if (!KEY_RE.test(key)) throw new Error('bad key');
    await this.storage.put(key, data);
    return `store:${key}`;
  }

  private sig(key: string, exp: number): string {
    return createHmac('sha256', this.secret).update(`file:${key}:${exp}`).digest('base64url');
  }

  /** A link that works for ttlSec, for one file. Non-storage references are returned unchanged. */
  signedUrl(ref: string | null): string | null {
    if (!ref || !ref.startsWith('store:')) return ref;
    const key = ref.slice('store:'.length);
    const exp = Math.floor(Date.now() / 1000) + this.ttlSec;
    return `${this.baseUrl}/files/${key}?exp=${exp}&sig=${this.sig(key, exp)}`;
  }

  /** Checks a signed link; returns the file or null. */
  async open(key: string, exp: number, sig: string): Promise<{ data: Buffer; contentType: string } | null> {
    if (!KEY_RE.test(key) || !Number.isInteger(exp) || exp < Math.floor(Date.now() / 1000)) return null;
    const expected = Buffer.from(this.sig(key, exp));
    const given = Buffer.from(sig);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const data = await this.storage.get(key);
    return data ? { data, contentType: CONTENT_TYPES[key.split('.').pop()!]! } : null;
  }
}

let current: FileService | null = null;
export function setFileService(f: FileService): void {
  current = f;
}
export function fileService(): FileService {
  if (!current) throw new Error('file service not configured');
  return current;
}

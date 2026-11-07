import {createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual} from 'node:crypto';

export const newSecret = () => randomBytes(32).toString('base64url');
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const pkceChallenge = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');
export const sessionHash = (value: string, secret: string) => createHmac('sha256', secret).update(value).digest('hex');
export function equalSecret(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Versioned AES-256-GCM envelope, bound to record owner and credential purpose. */
export class TokenCipher {
  private readonly key: Buffer;
  constructor(key: string) {
    this.key = Buffer.from(key, 'base64');
    if (this.key.length !== 32 || this.key.toString('base64') !== key) throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes encoded as canonical base64');
  }
  seal(plaintext: string, context: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(context));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
  }
  open(envelope: string, context: string): string {
    const parts = envelope.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Invalid credential envelope');
    const iv = Buffer.from(parts[1]!, 'base64url'), tag = Buffer.from(parts[2]!, 'base64url');
    if (iv.length !== 12 || tag.length !== 16) throw new Error('Invalid credential envelope');
    const cipher = createDecipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(context));
    cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(Buffer.from(parts[3]!, 'base64url')), cipher.final()]).toString('utf8');
  }
}

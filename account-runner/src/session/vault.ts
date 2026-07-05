// Cookie vault. Encrypts a per-account Playwright storage state (including the
// li_at and JSESSIONID cookies) at rest with AES-256-GCM. The key comes from
// process.env.COOKIE_VAULT_KEY. Secrets are never logged.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { StorageStateShape } from '../ports.js';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12; // GCM standard nonce length
const KEY_BYTES = 32; // AES-256
const ENVELOPE_VERSION = 1;

/** Serialized on-disk envelope. No plaintext secret ever appears here. */
interface VaultEnvelope {
  v: number;
  iv: string; // base64
  tag: string; // base64 auth tag
  ct: string; // base64 ciphertext
}

/** Thrown for any vault failure. Message never contains secret material. */
export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultError';
  }
}

/**
 * Resolve the symmetric key from an explicit arg or COOKIE_VAULT_KEY. Accepts a
 * base64 or hex string decoding to exactly 32 bytes.
 */
export function resolveVaultKey(raw: string | undefined = process.env.COOKIE_VAULT_KEY): Buffer {
  if (!raw || raw.length === 0) {
    throw new VaultError('COOKIE_VAULT_KEY is not set');
  }
  let key: Buffer | null = null;
  // Try base64 first, then hex.
  const b64 = Buffer.from(raw, 'base64');
  if (b64.length === KEY_BYTES) {
    key = b64;
  } else {
    const hex = Buffer.from(raw, 'hex');
    if (hex.length === KEY_BYTES) key = hex;
  }
  if (!key) {
    throw new VaultError('COOKIE_VAULT_KEY must decode to 32 bytes (base64 or hex)');
  }
  return key;
}

/** Encrypt a UTF-8 plaintext into a sealed envelope. */
export function seal(plaintext: string, key: Buffer): VaultEnvelope {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: ENVELOPE_VERSION,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ct.toString('base64'),
  };
}

/** Decrypt a sealed envelope back to UTF-8 plaintext. Wrong key/tag throws. */
export function open(envelope: VaultEnvelope, key: Buffer): string {
  if (envelope.v !== ENVELOPE_VERSION) {
    throw new VaultError(`unsupported vault envelope version ${envelope.v}`);
  }
  try {
    const iv = Buffer.from(envelope.iv, 'base64');
    const tag = Buffer.from(envelope.tag, 'base64');
    const ct = Buffer.from(envelope.ct, 'base64');
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  } catch {
    // Do not leak crypto internals; wrong key surfaces as an auth failure.
    throw new VaultError('vault decrypt failed: wrong key or tampered data');
  }
}

/** Encrypt+persist a storage state to a file path (creates parent dirs). */
export async function saveStorageState(
  path: string,
  state: StorageStateShape,
  key: Buffer = resolveVaultKey(),
): Promise<void> {
  const envelope = seal(JSON.stringify(state), key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(envelope), { encoding: 'utf8', mode: 0o600 });
}

/** Load+decrypt a storage state from a file path. */
export async function loadStorageState(
  path: string,
  key: Buffer = resolveVaultKey(),
): Promise<StorageStateShape> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new VaultError(`vault file not found or unreadable at ${path}`);
  }
  let envelope: VaultEnvelope;
  try {
    envelope = JSON.parse(raw) as VaultEnvelope;
  } catch {
    throw new VaultError('vault file is not valid JSON');
  }
  const json = open(envelope, key);
  return JSON.parse(json) as StorageStateShape;
}

/** Pull the two session-critical cookies without logging their values. */
export function extractSessionCookies(state: StorageStateShape): {
  liAt?: string;
  jsessionId?: string;
} {
  const out: { liAt?: string; jsessionId?: string } = {};
  for (const c of state.cookies) {
    if (c.name === 'li_at') out.liAt = c.value;
    else if (c.name === 'JSESSIONID') out.jsessionId = c.value;
  }
  return out;
}

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ENV_PATH, settings } from './config.js';

/**
 * Symmetric encryption for stored credentials.
 *
 * Uses AES-256-GCM. The encryption key is loaded from the .env file.
 * If no key is set on first run, one is generated and persisted automatically
 * to .env so the user is never blocked.
 *
 * On-disk format: base64( iv(12) | authTag(16) | ciphertext )
 */

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function ensureKey(): Buffer {
  if (settings.encryptionKey) {
    // Use a unique, random salt per installation — stored alongside the key
    const salt = settings.encryptionSalt || 'ops-monitor-v1';
    return scryptSync(settings.encryptionKey, salt, 32);
  }
  // Generate and persist a new key + salt
  const newKey = randomBytes(32).toString('base64');
  const newSalt = randomBytes(16).toString('base64');
  let content = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf-8') : '';

  // Write ENCRYPTION_KEY
  if (content.includes('ENCRYPTION_KEY=')) {
    content = content
      .split('\n')
      .map((line) => (line.startsWith('ENCRYPTION_KEY=') ? `ENCRYPTION_KEY=${newKey}` : line))
      .join('\n');
  } else {
    content = (content.trimEnd() + `\nENCRYPTION_KEY=${newKey}\n`).trimStart();
  }

  // Write ENCRYPTION_SALT
  if (content.includes('ENCRYPTION_SALT=')) {
    content = content
      .split('\n')
      .map((line) => (line.startsWith('ENCRYPTION_SALT=') ? `ENCRYPTION_SALT=${newSalt}` : line))
      .join('\n');
  } else {
    content = (content.trimEnd() + `\nENCRYPTION_SALT=${newSalt}\n`).trimStart();
  }

  try {
    writeFileSync(ENV_PATH, content);
    // Restrict .env file permissions to owner-only
    try { chmodSync(ENV_PATH, 0o600); } catch { /* Windows doesn't support chmod */ }
  } catch (e) {
    throw new Error(`Failed to write encryption key to .env: ${(e as Error).message}`);
  }

  console.warn('ENCRYPTION_KEY auto-generated. Safeguard your .env file — it contains secrets.');
  settings.encryptionKey = newKey;
  settings.encryptionSalt = newSalt;
  return scryptSync(newKey, newSalt, 32);
}

const KEY = ensureKey();

export function encrypt(plaintext: string): string {
  if (!plaintext) return '';
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

export function decrypt(payload: string): string {
  if (!payload) return '';
  try {
    const buf = Buffer.from(payload, 'base64');
    const iv = buf.subarray(0, IV_LEN);
    const authTag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ciphertext = buf.subarray(IV_LEN + TAG_LEN);
    const decipher = createDecipheriv(ALGO, KEY, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8');
  } catch (e) {
    console.error('Decryption failed:', e);
    throw new Error('Failed to decrypt credential — encryption key may have changed');
  }
}

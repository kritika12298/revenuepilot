import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env, isProduction } from '../config/env.js';

/**
 * AES-256-GCM encryption for integration credentials stored in the database.
 * The key comes from INTEGRATIONS_ENCRYPTION_KEY (32 bytes, base64). Outside
 * production a key derived from JWT_SECRET is used so local setups work.
 */
function key() {
  if (env.INTEGRATIONS_ENCRYPTION_KEY) {
    const k = Buffer.from(env.INTEGRATIONS_ENCRYPTION_KEY, 'base64');
    if (k.length !== 32) throw new Error('INTEGRATIONS_ENCRYPTION_KEY must be 32 bytes (base64)');
    return k;
  }
  if (isProduction) throw new Error('INTEGRATIONS_ENCRYPTION_KEY is required in production');
  return createHash('sha256').update(`integrations:${env.JWT_SECRET}`).digest();
}

export function encryptJson(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join('.');
}

export function decryptJson(payload) {
  if (!payload) return null;
  const [version, iv, tag, data] = payload.split('.');
  if (version !== 'v1') throw new Error('Unsupported secret format');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8'));
}

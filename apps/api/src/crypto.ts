// AES-256-GCM at-rest encryption for third-party secrets (Google refresh tokens).
// The key is TOKEN_ENCRYPTION_KEY — 32 bytes, base64-encoded (openssl rand -base64 32).
// Stored form is base64( iv(12) | authTag(16) | ciphertext ): self-contained, so a
// key rotation only needs the old key around to decrypt + re-encrypt existing rows.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { config } from './config'

const IV_LEN = 12
const TAG_LEN = 16

function key(): Buffer {
  const raw = config.security.tokenEncryptionKey
  if (!raw) throw new Error('TOKEN_ENCRYPTION_KEY is not set')
  const buf = Buffer.from(raw, 'base64')
  if (buf.length !== 32) {
    throw new Error('TOKEN_ENCRYPTION_KEY must decode to 32 bytes (openssl rand -base64 32)')
  }
  return buf
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64')
}

export function decryptSecret(packed: string): string {
  const buf = Buffer.from(packed, 'base64')
  const iv = buf.subarray(0, IV_LEN)
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN)
  const enc = buf.subarray(IV_LEN + TAG_LEN)
  const decipher = createDecipheriv('aes-256-gcm', key(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
}

// True when a valid 32-byte key is present — gates the connect flow so we never
// accept a Google grant we couldn't store encrypted.
export function encryptionAvailable(): boolean {
  try {
    key()
    return true
  } catch {
    return false
  }
}

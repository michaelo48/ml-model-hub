import { createHash, randomBytes } from 'node:crypto'

/**
 * Inference API keys. The plaintext is shown to the user exactly once; the
 * database stores only a SHA-256 hex digest (`api_keys.key_hash`, unique) and
 * the first eight characters (`api_keys.key_prefix`) so keys can be told apart
 * in the UI. A leaked database therefore yields nothing usable against the
 * endpoint, and a lookup is a single indexed equality on the digest.
 *
 * Format: `mf_` + 32 random bytes, base64url (43 chars), 46 chars in total.
 * The tag makes a key recognisable in logs and secret scanners.
 */
export const KEY_PREFIX_LENGTH = 8
const KEY_TAG = 'mf_'
const KEY_RANDOM_BYTES = 32

export interface GeneratedKey {
  /** Full plaintext key. Return it to the user once, never store it. */
  plaintext: string
  /** First eight characters, stored for display. */
  prefix: string
  /** SHA-256 hex digest, stored for lookup. */
  hash: string
}

export function generateApiKey(): GeneratedKey {
  const plaintext = KEY_TAG + randomBytes(KEY_RANDOM_BYTES).toString('base64url')
  return { plaintext, prefix: keyPrefix(plaintext), hash: hashApiKey(plaintext) }
}

export function keyPrefix(plaintext: string): string {
  return plaintext.slice(0, KEY_PREFIX_LENGTH)
}

export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex')
}

/**
 * Pull the bearer token out of an Authorization header. Returns null for a
 * missing header, a non-Bearer scheme, or a token that cannot be one of ours,
 * so the route can reject without touching the database.
 */
export function bearerToken(header: string | null): string | null {
  if (!header) return null
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header)
  const token = m?.[1]
  if (!token || !token.startsWith(KEY_TAG) || token.length > 128) return null
  return token
}

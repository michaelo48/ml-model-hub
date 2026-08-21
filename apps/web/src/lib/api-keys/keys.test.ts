import { describe, expect, it } from 'vitest'
import { KEY_PREFIX_LENGTH, bearerToken, generateApiKey, hashApiKey } from './keys'

describe('api keys', () => {
  it('generates a tagged key whose prefix satisfies the api_keys.key_prefix check', () => {
    const k = generateApiKey()
    expect(k.plaintext.startsWith('mf_')).toBe(true)
    expect(k.prefix).toHaveLength(KEY_PREFIX_LENGTH)
    expect(k.plaintext.startsWith(k.prefix)).toBe(true)
    expect(k.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hashApiKey(k.plaintext)).toBe(k.hash)
  })

  it('never repeats', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateApiKey().plaintext))
    expect(seen.size).toBe(50)
  })

  it('extracts a bearer token and rejects everything else', () => {
    expect(bearerToken('Bearer mf_abc')).toBe('mf_abc')
    expect(bearerToken('bearer   mf_abc ')).toBe('mf_abc')
    expect(bearerToken(null)).toBeNull()
    expect(bearerToken('Basic mf_abc')).toBeNull()
    expect(bearerToken('Bearer sk_abc')).toBeNull()
    expect(bearerToken('Bearer')).toBeNull()
    expect(bearerToken('Bearer mf_' + 'x'.repeat(200))).toBeNull()
  })
})

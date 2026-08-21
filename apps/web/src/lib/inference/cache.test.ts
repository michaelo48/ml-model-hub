import { describe, expect, it } from 'vitest'
import { LruCache } from './cache'

describe('LruCache', () => {
  it('evicts the least recently used entry, counting reads as use', () => {
    const c = new LruCache<string, number>(2)
    c.set('a', 1)
    c.set('b', 2)
    expect(c.get('a')).toBe(1) // a is now most recent
    c.set('c', 3) // evicts b
    expect(c.get('b')).toBeUndefined()
    expect(c.get('a')).toBe(1)
    expect(c.get('c')).toBe(3)
    expect(c.size).toBe(2)
  })

  it('overwrites in place without growing', () => {
    const c = new LruCache<string, number>(1)
    c.set('a', 1)
    c.set('a', 2)
    expect(c.get('a')).toBe(2)
    expect(c.size).toBe(1)
  })

  it('rejects a non-positive capacity', () => {
    expect(() => new LruCache(0)).toThrow()
  })
})

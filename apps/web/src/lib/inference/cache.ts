/**
 * Small insertion-ordered LRU. A Map iterates in insertion order, so deleting
 * and re-setting a key on read moves it to the back; the front is always the
 * least recently used entry. Lives in module scope on the serving instance;
 * with several instances each warms its own, which is fine for artifacts of a
 * few kilobytes.
 */
export class LruCache<K, V> {
  private readonly map = new Map<K, V>()

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error('LruCache: capacity must be a positive integer')
    }
  }

  get(key: K): V | undefined {
    const v = this.map.get(key)
    if (v === undefined) return undefined
    this.map.delete(key)
    this.map.set(key, v)
    return v
  }

  set(key: K, value: V): void {
    this.map.delete(key)
    this.map.set(key, value)
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next()
      if (!oldest.done) this.map.delete(oldest.value)
    }
  }

  delete(key: K): void {
    this.map.delete(key)
  }

  get size(): number {
    return this.map.size
  }
}

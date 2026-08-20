import { describe, expect, it } from 'vitest'
import { formatUtc } from './time'

describe('formatUtc', () => {
  it('formats in UTC regardless of the offset in the input', () => {
    expect(formatUtc('2026-08-19T19:14:41.136+00:00')).toBe('2026-08-19 19:14 UTC')
    expect(formatUtc('2026-08-19T15:14:41-04:00')).toBe('2026-08-19 19:14 UTC')
  })
  it('passes garbage through unchanged', () => {
    expect(formatUtc('nope')).toBe('nope')
  })
})

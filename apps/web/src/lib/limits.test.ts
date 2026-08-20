import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'
import { LIMIT_ERROR_CODE, dbErrorMessage, getDatasetUsage, getLimits, isLimitError } from './limits'

const ALL_LIMITS = [
  { key: 'max_datasets_per_user', value: 3 },
  { key: 'dataset_uploads_per_hour', value: 10 },
  { key: 'dataset_edits_per_hour', value: 30 },
  { key: 'training_jobs_per_hour', value: 10 },
]

/**
 * Minimal stand-in for the two query shapes limits.ts issues:
 *   from('app_limits').select('key, value')                 -> { data, error }
 *   from('datasets').select('id', { count, head })          -> { count, error }
 */
function fakeClient(opts: {
  limits?: { data: unknown[] | null; error: { message: string } | null }
  datasets?: { count: number | null; error: { message: string } | null }
}): SupabaseClient<Database> {
  const limits = opts.limits ?? { data: ALL_LIMITS, error: null }
  const datasets = opts.datasets ?? { count: 0, error: null }
  return {
    from(table: string) {
      return {
        select: () => Promise.resolve(table === 'app_limits' ? limits : datasets),
      }
    },
  } as unknown as SupabaseClient<Database>
}

afterEach(() => vi.restoreAllMocks())

describe('isLimitError', () => {
  it('matches only SQLSTATE 54000', () => {
    expect(isLimitError({ code: LIMIT_ERROR_CODE, message: 'x' })).toBe(true)
    expect(isLimitError({ code: '23503', message: 'x' })).toBe(false)
    expect(isLimitError({ message: 'x' })).toBe(false)
    expect(isLimitError(null)).toBe(false)
    expect(isLimitError(undefined)).toBe(false)
  })
})

describe('dbErrorMessage', () => {
  it('returns the trigger message verbatim for limit errors and does not log', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const msg = 'Dataset limit reached: you can keep at most 3 datasets. Delete one to upload another.'
    expect(dbErrorMessage({ code: '54000', message: msg }, 'createDataset', 'fallback')).toBe(msg)
    expect(spy).not.toHaveBeenCalled()
  })

  it('logs other errors with context and returns the fallback', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const out = dbErrorMessage(
      { code: '42P01', message: 'relation "x" does not exist', details: 'd', hint: 'h' },
      'createDataset',
      'Could not create the dataset.'
    )
    expect(out).toBe('Could not create the dataset.')
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]?.[0]).toContain('createDataset')
    expect(spy.mock.calls[0]?.[1]).toMatchObject({ code: '42P01', message: 'relation "x" does not exist' })
  })
})

describe('getLimits', () => {
  it('returns every limit keyed by name', async () => {
    await expect(getLimits(fakeClient({}))).resolves.toEqual({
      max_datasets_per_user: 3,
      dataset_uploads_per_hour: 10,
      dataset_edits_per_hour: 30,
      training_jobs_per_hour: 10,
    })
  })

  it('throws when the query fails instead of returning defaults', async () => {
    const client = fakeClient({ limits: { data: null, error: { message: 'permission denied' } } })
    await expect(getLimits(client)).rejects.toThrow(/permission denied/)
  })

  it('throws when a limit key is missing from the table', async () => {
    const client = fakeClient({ limits: { data: ALL_LIMITS.slice(0, 2), error: null } })
    await expect(getLimits(client)).rejects.toThrow(/missing dataset_edits_per_hour, training_jobs_per_hour/)
  })

  it('ignores unknown keys', async () => {
    const client = fakeClient({ limits: { data: [...ALL_LIMITS, { key: 'future_limit', value: 1 }], error: null } })
    await expect(getLimits(client)).resolves.not.toHaveProperty('future_limit')
  })
})

describe('getDatasetUsage', () => {
  it('reports used, max and remaining', async () => {
    await expect(getDatasetUsage(fakeClient({ datasets: { count: 2, error: null } }))).resolves.toEqual({
      used: 2,
      max: 3,
      remaining: 1,
    })
  })

  it('clamps remaining at zero when over the cap (e.g. after the limit was lowered)', async () => {
    const usage = await getDatasetUsage(fakeClient({ datasets: { count: 5, error: null } }))
    expect(usage).toEqual({ used: 5, max: 3, remaining: 0 })
  })

  it('treats a null count as zero', async () => {
    const usage = await getDatasetUsage(fakeClient({ datasets: { count: null, error: null } }))
    expect(usage.used).toBe(0)
  })

  it('throws when the count query fails', async () => {
    const client = fakeClient({ datasets: { count: null, error: { message: 'boom' } } })
    await expect(getDatasetUsage(client)).rejects.toThrow(/boom/)
  })
})

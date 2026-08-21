import { describe, expect, it } from 'vitest'
import type { Db } from '../src/db'
import {
  classifyObjects,
  createSweepDeps,
  originalDatasetPath,
  sweepOrphans,
  type StoredObject,
  type SweepDeps,
} from '../src/sweep'

const NOW = Date.parse('2026-08-20T12:00:00Z')
const HOUR = 3_600_000
const old = (path: string): StoredObject => ({ path, createdAt: new Date(NOW - 2 * HOUR).toISOString() })
const young = (path: string): StoredObject => ({ path, createdAt: new Date(NOW - 5 * 60_000).toISOString() })

describe('classifyObjects', () => {
  it('returns only old objects that no live path claims', () => {
    const live = new Set(['u/m/v1.json'])
    const objects = [old('u/m/v1.json'), old('u/m/v2.json'), young('u/m/v3.json')]
    expect(classifyObjects(objects, live, NOW - HOUR)).toEqual({ orphans: ['u/m/v2.json'], young: 1, unknownAge: 0 })
  })

  it('never deletes on an unparseable timestamp, and counts it apart from young', () => {
    expect(classifyObjects([{ path: 'u/x.json', createdAt: '' }], new Set(), NOW - HOUR)).toEqual({
      orphans: [],
      young: 0,
      unknownAge: 1,
    })
  })
})

describe('sweepOrphans', () => {
  function fakeDeps(
    buckets: Record<string, StoredObject[]>,
    artifacts: string[],
    datasets: { id: string; user_id: string; storage_path: string }[]
  ): { deps: SweepDeps; removed: Record<string, string[]> } {
    const removed: Record<string, string[]> = { datasets: [], models: [] }
    const deps: SweepDeps = {
      listObjects: async (bucket) => buckets[bucket] ?? [],
      liveArtifactPaths: async () => new Set(artifacts),
      liveDatasetPaths: async () => {
        const live = new Set<string>()
        for (const d of datasets) {
          live.add(d.storage_path)
          live.add(originalDatasetPath(d.user_id, d.id))
        }
        return live
      },
      remove: async (bucket, paths) => {
        removed[bucket]!.push(...paths)
      },
    }
    return { deps, removed }
  }

  it('removes old orphans in both buckets and leaves young and live objects alone', async () => {
    const { deps, removed } = fakeDeps(
      {
        models: [old('u/m1/v1.json'), old('u/m1/v2.json'), old('u/gone/v1.json'), young('u/m2/v1.json')],
        datasets: [old('u/d1.csv'), old('u/d1.v2.csv'), old('u/d1.v1.csv'), old('u/deleted.csv'), young('u/d2.csv')],
      },
      ['u/m1/v1.json', 'u/m1/v2.json'],
      [{ id: 'd1', user_id: 'u', storage_path: 'u/d1.v2.csv' }]
    )
    const result = await sweepOrphans(deps, NOW, HOUR)
    expect(removed.models).toEqual(['u/gone/v1.json'])
    // d1.csv is the kept original, d1.v2.csv is the row's path; d1.v1.csv is a superseded version.
    expect(removed.datasets).toEqual(['u/d1.v1.csv', 'u/deleted.csv'])
    expect(result).toEqual({
      datasets: { removed: 2, skippedYoung: 1, skippedUnknownAge: 0 },
      models: { removed: 1, skippedYoung: 1, skippedUnknownAge: 0 },
    })
  })

  it('batches large removals', async () => {
    const many = Array.from({ length: 250 }, (_, i) => old(`u/m/v${i}.json`))
    const calls: number[] = []
    const { deps } = fakeDeps({ models: many, datasets: [] }, [], [])
    deps.remove = async (_bucket, paths) => {
      calls.push(paths.length)
    }
    const result = await sweepOrphans(deps, NOW, HOUR)
    expect(calls).toEqual([100, 100, 50])
    expect(result.models.removed).toBe(250)
  })

  it('removes nothing from a bucket whose live set cannot be loaded', async () => {
    const { deps, removed } = fakeDeps({ models: [old('u/m/v1.json')], datasets: [old('u/d.csv')] }, [], [])
    deps.liveArtifactPaths = async () => {
      throw new Error('partial')
    }
    await expect(sweepOrphans(deps, NOW, HOUR)).rejects.toThrow('partial')
    expect(removed).toEqual({ datasets: [], models: [] })
  })

  it('does nothing when everything is accounted for', async () => {
    const { deps, removed } = fakeDeps(
      { models: [old('u/m/v1.json')], datasets: [old('u/d.csv')] },
      ['u/m/v1.json'],
      [{ id: 'd', user_id: 'u', storage_path: 'u/d.csv' }]
    )
    const result = await sweepOrphans(deps, NOW, HOUR)
    expect(removed).toEqual({ datasets: [], models: [] })
    expect(result).toEqual({
      datasets: { removed: 0, skippedYoung: 0, skippedUnknownAge: 0 },
      models: { removed: 0, skippedYoung: 0, skippedUnknownAge: 0 },
    })
  })
})

/**
 * createSweepDeps against a fake supabase-js surface. This is the part that
 * touches real data, so it gets tested with the failure mode that matters: a
 * server that silently caps every response at `maxRows`, the way PostgREST
 * does with db-max-rows.
 */
describe('createSweepDeps', () => {
  type Row = Record<string, string>
  type ListEntry = { name: string; id: string | null; created_at?: string }

  interface FakeOptions {
    tables: Record<string, Row[]>
    /** Server-side response cap, like PostgREST's db-max-rows. */
    maxRows: number
    /** Folder tree: key is a prefix, value its direct entries. */
    storage?: Record<string, ListEntry[]>
  }

  function fakeDb(opts: FakeOptions): { db: Db; queries: string[]; removed: Record<string, string[]> } {
    const queries: string[] = []
    const removed: Record<string, string[]> = {}
    const db = {
      from(table: string) {
        const rows = opts.tables[table] ?? []
        return {
          select(_cols: string, o?: { count?: string; head?: boolean }) {
            void _cols
            if (o?.head) {
              queries.push(`count ${table}`)
              return Promise.resolve({ count: rows.length, error: null, data: null })
            }
            return {
              order() {
                return {
                  range(from: number, to: number) {
                    queries.push(`${table} ${from}-${to}`)
                    const page = rows.slice(from, to + 1).slice(0, opts.maxRows)
                    return Promise.resolve({ data: page, error: null })
                  },
                }
              },
            }
          },
        }
      },
      storage: {
        from(bucket: string) {
          return {
            list(prefix: string, o: { limit: number; offset: number }) {
              const entries = opts.storage?.[prefix] ?? []
              return Promise.resolve({ data: entries.slice(o.offset, o.offset + o.limit), error: null })
            },
            remove(paths: string[]) {
              const list = removed[bucket] ?? (removed[bucket] = [])
              list.push(...paths)
              return Promise.resolve({ data: null, error: null })
            },
          }
        },
      },
    }
    return { db: db as unknown as Db, queries, removed }
  }

  const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  const artifacts = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ storage_path: `u/m${i}/v1.json` }))

  it('pages through more rows than a single response may hold', async () => {
    const { db, queries } = fakeDb({ tables: { model_artifacts: artifacts(2_345) }, maxRows: 1000 })
    const live = await createSweepDeps(db).liveArtifactPaths()
    expect(live.size).toBe(2_345)
    expect(live.has('u/m2344/v1.json')).toBe(true)
    expect(queries).toEqual([
      'count model_artifacts',
      'model_artifacts 0-999',
      'model_artifacts 1000-1999',
      'model_artifacts 2000-2999',
    ])
  })

  it('fails closed when the server caps responses below the page size', async () => {
    // db-max-rows = 500: every page comes back short, the reader stops after
    // the first, and the count proves it was truncated. Nothing may be swept.
    const { db } = fakeDb({ tables: { model_artifacts: artifacts(1_200) }, maxRows: 500 })
    await expect(createSweepDeps(db).liveArtifactPaths()).rejects.toThrow(/expected 1200 rows, got 500/)
  })

  it('fails closed end to end: a truncated live set never reaches remove()', async () => {
    const ts = old('').createdAt
    const { db, removed } = fakeDb({
      tables: { model_artifacts: artifacts(1_200), datasets: [] },
      maxRows: 500,
      storage: {
        '': [{ name: 'u', id: null }],
        u: [{ name: 'm1', id: null }],
        'u/m1': [{ name: 'v1.json', id: 'x', created_at: ts }],
      },
    })
    await expect(sweepOrphans(createSweepDeps(db), NOW, HOUR)).rejects.toThrow(/partial live set/)
    expect(removed).toEqual({})
  })

  it('builds dataset live paths from both the row path and the original upload', async () => {
    const { db } = fakeDb({
      tables: { datasets: [{ id: uuid(1), user_id: uuid(9), storage_path: `${uuid(9)}/${uuid(1)}.v2.csv` }] },
      maxRows: 1000,
    })
    const live = await createSweepDeps(db).liveDatasetPaths()
    expect([...live].sort()).toEqual([`${uuid(9)}/${uuid(1)}.csv`, `${uuid(9)}/${uuid(1)}.v2.csv`])
  })

  it('rejects rows that do not match the expected shape instead of guessing', async () => {
    const { db } = fakeDb({ tables: { model_artifacts: [{ storage_path: '' }] }, maxRows: 1000 })
    await expect(createSweepDeps(db).liveArtifactPaths()).rejects.toThrow()
  })

  it('walks folders to depth 3 and no further', async () => {
    const ts = old('').createdAt
    const { db } = fakeDb({
      tables: {},
      maxRows: 1000,
      storage: {
        '': [{ name: 'u', id: null }],
        u: [
          { name: 'd.csv', id: 'a', created_at: ts },
          { name: 'm', id: null },
        ],
        'u/m': [
          { name: 'v1.json', id: 'b', created_at: ts },
          { name: 'deeper', id: null },
        ],
        'u/m/deeper': [{ name: 'never-listed.json', id: 'c', created_at: ts }],
      },
    })
    const objects = await createSweepDeps(db).listObjects('models')
    expect(objects.map((o) => o.path)).toEqual(['u/d.csv', 'u/m/v1.json'])
  })
})

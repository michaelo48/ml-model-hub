'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createApiKey, revokeApiKey } from '@/lib/api-keys/actions'
import { formatUtc } from '@/lib/time'
import { Empty } from '@/components/layout/AppShell'
import { FormMessage } from '@/components/ui/form'
import { Th } from '@/components/ui/table'

export interface ApiKeyRow {
  id: string
  name: string | null
  key_prefix: string
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
}

/**
 * Per-model API keys. Generate shows the full key exactly once, in the same
 * panel, next to a ready-to-run curl for this model; after that only the
 * prefix is ever visible. Revoke is immediate and permanent (the row is kept
 * so past usage stays attributable).
 */
export function ApiKeys({ modelId, keys, endpoint, exampleBody }: {
  modelId: string
  keys: ApiKeyRow[]
  /** Absolute URL of the predict endpoint, for the curl example. */
  endpoint: string
  /** A one-row request body built from the feature schema, JSON encoded. */
  exampleBody: string
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [fresh, setFresh] = useState<{ plaintext: string; prefix: string } | null>(null)
  const [copied, setCopied] = useState(false)

  function generate() {
    setError(null)
    start(async () => {
      const res = await createApiKey(modelId, name || undefined)
      if (!res.ok) {
        setError(res.fieldErrors?.name ?? res.error)
        return
      }
      setFresh({ plaintext: res.data.plaintext, prefix: res.data.prefix })
      setCopied(false)
      setName('')
      router.refresh()
    })
  }

  function revoke(k: ApiKeyRow) {
    const label = k.name ? `"${k.name}" (${k.key_prefix}...)` : `${k.key_prefix}...`
    if (!window.confirm(`Revoke key ${label}? Requests using it will fail immediately.`)) return
    setError(null)
    start(async () => {
      const res = await revokeApiKey(k.id)
      if (!res.ok) {
        setError(res.error)
        return
      }
      if (fresh && k.key_prefix === fresh.prefix) setFresh(null)
      router.refresh()
    })
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  const curl = fresh
    ? [
        `curl -X POST ${endpoint} \\`,
        `  -H "Authorization: Bearer ${fresh.plaintext}" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -d '${exampleBody}'`,
      ].join('\n')
    : null

  return (
    <div className="flex flex-col gap-3">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          generate()
        }}
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor="api-key-name" className="text-xs text-fg-muted">
            Key name (optional)
          </label>
          <input
            id="api-key-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            placeholder="e.g. staging"
            className="h-8 w-56 rounded-sm border border-line bg-surface px-2.5 text-sm text-fg outline-none placeholder:text-fg-muted focus:border-accent focus:ring-2 focus:ring-accent/25"
          />
        </div>
        <button
          type="submit"
          disabled={pending}
          className="h-8 rounded-sm bg-accent px-3 text-sm font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-60"
        >
          Generate key
        </button>
      </form>

      {error ? <FormMessage tone="error">{error}</FormMessage> : null}

      {fresh && curl ? (
        <div className="rounded-sm border border-accent/40 bg-surface px-4 py-3 text-sm">
          <p className="mb-2">
            Copy this key now. It is shown once and cannot be recovered; generate a new one if you lose it.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded-sm border border-line bg-bg px-2.5 py-1.5 font-mono text-xs">
              {fresh.plaintext}
            </code>
            <button
              type="button"
              onClick={() => copy(fresh.plaintext)}
              className="h-8 shrink-0 rounded-sm border border-line px-2.5 text-xs text-fg hover:bg-bg"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="mt-3 mb-1 text-xs text-fg-muted">Try it</p>
          <pre className="overflow-x-auto rounded-sm border border-line bg-bg px-2.5 py-2 font-mono text-xs leading-relaxed">
            {curl}
          </pre>
        </div>
      ) : null}

      {keys.length === 0 ? (
        <Empty>No API keys yet. Generate one to call the inference endpoint.</Empty>
      ) : (
        <div className="overflow-x-auto rounded-sm border border-line">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-surface text-left text-xs text-fg-muted">
              <tr>
                <Th>Key</Th>
                <Th>Name</Th>
                <Th right>Created</Th>
                <Th right>Last used</Th>
                <Th>Status</Th>
                <Th right>
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id} className="border-b border-line last:border-0 hover:bg-surface">
                  <td className="px-3 py-2 font-mono text-xs">{k.key_prefix}...</td>
                  <td className="px-3 py-2 text-xs">{k.name ?? <span className="text-fg-muted">-</span>}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-fg-muted">{formatUtc(k.created_at)}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-fg-muted">
                    {k.last_used_at ? formatUtc(k.last_used_at) : 'never'}
                  </td>
                  <td className="px-3 py-2">
                    {k.revoked_at ? (
                      <span className="inline-block rounded-sm border border-line px-1.5 py-0.5 font-mono text-xs text-fg-muted">
                        revoked
                      </span>
                    ) : (
                      <span className="inline-block rounded-sm border border-success/40 px-1.5 py-0.5 font-mono text-xs text-success">
                        active
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {k.revoked_at ? null : (
                      <button
                        type="button"
                        onClick={() => revoke(k)}
                        disabled={pending}
                        className="text-xs text-danger hover:underline disabled:opacity-60"
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

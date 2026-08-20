'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { deleteModel, enqueueTraining } from '@/lib/models/actions'
import { DangerButton, FormMessage } from '@/components/ui/form'

export function ModelActions({
  modelId,
  name,
  status,
}: {
  modelId: string
  name: string
  status: string
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const busy = status === 'queued' || status === 'training'

  function train() {
    setError(null)
    start(async () => {
      const res = await enqueueTraining(modelId)
      if (!res.ok) {
        setError(res.error)
        return
      }
      router.push(`/jobs/${res.data.jobId}`)
    })
  }

  function remove() {
    if (!window.confirm(`Delete "${name}"? Its jobs, artifacts and API keys will be removed.`)) return
    setError(null)
    start(async () => {
      const res = await deleteModel(modelId)
      if (!res.ok) {
        setError(res.error)
        return
      }
      router.push('/dashboard')
    })
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-2">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            remove()
          }}
        >
          <DangerButton pending={pending && !busy}>Delete</DangerButton>
        </form>
        <button
          type="button"
          onClick={train}
          disabled={pending || busy}
          className="h-8 rounded-sm bg-accent px-3 text-sm font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-60"
        >
          {busy ? 'Training in progress' : status === 'draft' ? 'Train' : 'Retrain'}
        </button>
      </div>
      {error ? <FormMessage tone="error">{error}</FormMessage> : null}
    </div>
  )
}

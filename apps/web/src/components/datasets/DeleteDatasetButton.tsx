'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { deleteDataset } from '@/lib/datasets/actions'
import { DangerButton, FormMessage } from '@/components/ui/form'

export function DeleteDatasetButton({ datasetId, name }: { datasetId: string; name: string }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  return (
    <form
      className="flex flex-col items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (!window.confirm(`Delete "${name}"? This removes the file and cannot be undone.`)) return
        start(async () => {
          const res = await deleteDataset(datasetId)
          if (!res.ok) {
            setError(res.error)
            return
          }
          router.push('/dashboard')
        })
      }}
    >
      <DangerButton pending={pending}>Delete dataset</DangerButton>
      {error ? <FormMessage tone="error">{error}</FormMessage> : null}
    </form>
  )
}

import type { Metadata } from 'next'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getDatasetUsage } from '@/lib/limits'
import { PageHeader } from '@/components/layout/AppShell'
import { UploadDataset } from '@/components/datasets/UploadDataset'

export const metadata: Metadata = { title: 'Upload dataset' }

export default async function NewDatasetPage() {
  const supabase = await createClient()
  const usage = await getDatasetUsage(supabase)

  return (
    <>
      <PageHeader
        title="Upload dataset"
        description="A CSV with a header row. Numeric columns become features or the target; the server re-validates everything after upload."
        action={
          <span className="font-mono text-xs text-fg-muted" title="Datasets you can keep at once">
            {usage.used} of {usage.max} datasets used
          </span>
        }
      />
      {usage.remaining === 0 ? (
        <p role="status" className="mb-6 rounded-sm border border-line bg-surface px-3 py-2 text-sm text-fg-muted">
          You have reached the limit of {usage.max} dataset{usage.max === 1 ? '' : 's'}.{' '}
          <Link href="/dashboard" className="text-fg underline underline-offset-2 hover:text-accent">
            Delete one from the dashboard
          </Link>{' '}
          to upload another.
        </p>
      ) : null}
      <UploadDataset disabled={usage.remaining === 0} />
    </>
  )
}

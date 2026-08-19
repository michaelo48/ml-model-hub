import type { Metadata } from 'next'
import { PageHeader } from '@/components/layout/AppShell'
import { UploadDataset } from '@/components/datasets/UploadDataset'

export const metadata: Metadata = { title: 'Upload dataset' }

export default function NewDatasetPage() {
  return (
    <>
      <PageHeader
        title="Upload dataset"
        description="A CSV with a header row. Numeric columns become features or the target; the server re-validates everything after upload."
      />
      <UploadDataset />
    </>
  )
}

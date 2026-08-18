export default function NewDatasetPage() {
  return (
    <main className="min-h-screen bg-zinc-950 p-8 text-zinc-50">
      <div className="mx-auto max-w-2xl rounded-xl border border-zinc-800 bg-zinc-900 p-6">
        <h1 className="text-2xl font-semibold">Upload dataset</h1>
        <p className="mt-2 text-zinc-400">
          Upload a CSV file and store it in the datasets bucket.
        </p>
        <div className="mt-6 rounded-lg border border-dashed border-zinc-700 p-10 text-center text-zinc-400">
          Drop a CSV here or click to browse
        </div>
      </div>
    </main>
  )
}

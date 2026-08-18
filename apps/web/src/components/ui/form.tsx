import type { InputHTMLAttributes, ReactNode } from 'react'

type FieldProps = {
  label: string
  name: string
  error?: string
  hint?: string
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'name'>

export function Field({ label, name, error, hint, id, ...input }: FieldProps) {
  const inputId = id ?? name
  const errorId = `${inputId}-error`
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-sm font-medium text-fg">
        {label}
      </label>
      <input
        id={inputId}
        name={name}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={[
          'h-9 w-full rounded-sm border bg-surface px-3 text-sm text-fg outline-none',
          'placeholder:text-fg-muted',
          'focus:border-accent focus:ring-2 focus:ring-accent/25',
          error ? 'border-danger' : 'border-line',
        ].join(' ')}
        {...input}
      />
      {error ? (
        <p id={errorId} className="text-xs text-danger">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-fg-muted">{hint}</p>
      ) : null}
    </div>
  )
}

export function FormMessage({
  tone,
  children,
}: {
  tone: 'error' | 'success'
  children: ReactNode
}) {
  const cls =
    tone === 'error'
      ? 'border-danger/40 bg-danger/5 text-danger'
      : 'border-success/40 bg-success/5 text-success'
  return (
    <p role={tone === 'error' ? 'alert' : 'status'} className={`rounded-sm border px-3 py-2 text-sm ${cls}`}>
      {children}
    </p>
  )
}

export function SubmitButton({
  pending,
  children,
}: {
  pending: boolean
  children: ReactNode
}) {
  return (
    <button
      type="submit"
      disabled={pending}
      className="h-9 w-full rounded-sm bg-accent text-sm font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-60"
    >
      {pending ? 'Working...' : children}
    </button>
  )
}

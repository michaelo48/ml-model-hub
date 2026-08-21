import type { ReactNode } from 'react'

/**
 * Cells for the dense data tables (versions, jobs, keys, usage). The wrapper
 * markup stays in each page because the surrounding layout differs; what is
 * shared is the cell padding and alignment, which has to match exactly across
 * tables or columns stop lining up between one screen and the next.
 *
 * Expected inside a `<thead className="bg-surface text-left text-xs text-fg-muted">`.
 */
export function Th({ children, right }: { children: ReactNode; right?: boolean }) {
  return <th className={`border-b border-line px-3 py-1.5 font-medium${right ? ' text-right' : ''}`}>{children}</th>
}

/** Right-aligned monospace body cell for a figure. `muted` for secondary counts. */
export function Num({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return <td className={`px-3 py-2 text-right font-mono text-xs${muted ? ' text-fg-muted' : ''}`}>{children}</td>
}

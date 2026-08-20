/**
 * Fixed, locale-free timestamp for Server Components: `2026-08-19 19:14 UTC`.
 * toLocaleString() on the server formats in the server's locale and timezone
 * (UTC on Vercel) while looking like local time; an explicit UTC label is
 * honest and renders identically on server and client.
 */
export function formatUtc(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`
}

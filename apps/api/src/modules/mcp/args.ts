// Hand-rolled argument readers for MCP tools, in the routes' style: each throws a
// ToolInputError the model can read and correct.
import { ToolInputError } from './registry'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v)
}

// A real calendar day: shape, then a round trip (JS rolls Feb 31 into March).
export function isIsoDate(v: unknown): v is string {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return false
  const d = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}

export function optString(args: Record<string, unknown>, key: string, max = 500): string | undefined {
  const v = args[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw new ToolInputError(`${key} must be a string`)
  const t = v.trim()
  if (t.length > max) throw new ToolInputError(`${key} is longer than ${max} characters`)
  return t || undefined
}

export function reqString(args: Record<string, unknown>, key: string, max = 500): string {
  const v = optString(args, key, max)
  if (!v) throw new ToolInputError(`${key} is required`)
  return v
}

export function optUuid(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key]
  if (v === undefined || v === null || v === '') return undefined
  if (!isUuid(v)) throw new ToolInputError(`${key} must be an id returned by another tool`)
  return v
}

export function reqUuid(args: Record<string, unknown>, key: string): string {
  const v = optUuid(args, key)
  if (!v) throw new ToolInputError(`${key} is required`)
  return v
}

export function optDate(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key]
  if (v === undefined || v === null || v === '') return undefined
  if (!isIsoDate(v)) throw new ToolInputError(`${key} must be a date as YYYY-MM-DD`)
  return v
}

export function optEnum<T extends string>(args: Record<string, unknown>, key: string, allowed: readonly T[]): T | undefined {
  const v = args[key]
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    throw new ToolInputError(`${key} must be one of ${allowed.join(', ')}`)
  }
  return v as T
}

export function optNumber(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ToolInputError(`${key} must be a number`)
  return v
}

export function optBool(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'boolean') throw new ToolInputError(`${key} must be true or false`)
  return v
}

// Bounded lists: results stay well under a client's size cap, and say when they were cut.
export function capped<T>(rows: T[], limit: number): { items: T[]; total: number; truncated: boolean } {
  return { items: rows.slice(0, limit), total: rows.length, truncated: rows.length > limit }
}

export function truncNote(c: { total: number; truncated: boolean; items: unknown[] }): string {
  return c.truncated ? ` (showing ${c.items.length} of ${c.total}; narrow the request for the rest)` : ''
}

// Free text the household typed, clipped so one long note can't crowd a result.
export function clip(s: string | null | undefined, max = 300): string | null {
  if (s == null) return null
  return s.length > max ? `${s.slice(0, max)}…` : s
}

// JSON Schema fragments shared by tool declarations.
export const DATE_SCHEMA = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }
export const ID_SCHEMA = { type: 'string', format: 'uuid' }

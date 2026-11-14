// mcp_audit: who called which write tool, on what, and how it went (docs/product/mcp-plan.md
// §5). Only id-shaped arguments are kept, so no free text the agent sent is ever stored.
import { query } from '../../platform/db'
import { log } from '../../platform/logger'
import type { Tenant } from '../households/households'
import { isUuid } from './args'

export type AuditOutcome = 'ok' | 'error' | 'denied'

const MAX_ERROR = 300

export function auditTargets(args: Record<string, unknown>, createdId?: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(args)) {
    if (isUuid(v)) out[k] = v
    else if (Array.isArray(v) && v.length > 0 && v.every(isUuid)) out[k] = v as string[]
  }
  if (createdId) out.created = createdId
  return out
}

// A failed audit insert is logged, never surfaced: by then the write has already happened.
export async function recordAudit(entry: {
  tenant: Tenant
  apiKeyId: string | null
  tool: string
  targets: Record<string, string | string[]>
  outcome: AuditOutcome
  error?: string | null
}): Promise<void> {
  try {
    await query(
      `insert into mcp_audit (household_id, person_id, api_key_id, tool, target_ids, outcome, error)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        entry.tenant.householdId,
        entry.tenant.personId,
        entry.apiKeyId,
        entry.tool,
        JSON.stringify(entry.targets),
        entry.outcome,
        entry.error ? entry.error.slice(0, MAX_ERROR) : null,
      ]
    )
  } catch (err) {
    log.error('mcp audit insert failed', { err, tool: entry.tool })
  }
}

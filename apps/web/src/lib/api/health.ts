// System health — the admin-only deep report behind Settings → System Health.
// Mirrors apps/api/src/modules/health/health.ts.
import { apiGet } from './client'

export type HealthStatus = 'ok' | 'degraded' | 'down'
export interface HealthCheck {
  status: HealthStatus
  [key: string]: unknown
}
export interface HealthReport {
  status: HealthStatus
  version: { pkg: string; sha: string; buildTime: string | null }
  generatedAt: string
  checks: Record<string, HealthCheck>
}

export const healthApi = {
  get: () => apiGet<HealthReport>('/api/health'),
}

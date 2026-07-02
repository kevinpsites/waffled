// In-app update notifier — admin-only. Mirrors apps/api/src/modules/updates/updates.ts.
import { apiGet, apiSend } from './client'

export interface UpdateInfo {
  enabled: boolean
  reason?: string
  current: { version: string; sha: string }
  latest?: { tag: string; url: string; publishedAt: string | null } | null
  updateAvailable?: boolean
  checkedAt?: string
  error?: string
}

export const updatesApi = {
  get: () => apiGet<UpdateInfo>('/api/updates'),
  setEnabled: (enabled: boolean) => apiSend<{ enabled: boolean }>('PUT', '/api/updates/settings', { enabled }),
}

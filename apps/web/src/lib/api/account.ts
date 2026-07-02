// Self-service account settings — the "My Profile" + "My Account" panels in
// Settings let a signed-in member change their OWN profile, email, and password
// (everything else is admin-managed in Family & People). Mirrors
// apps/api/src/modules/account/account.ts.
import { apiGet, apiSend } from './client'

export interface AccountInfo {
  personId: string
  name: string
  avatarEmoji: string | null
  colorHex: string | null
  birthday: string | null
  isAdmin: boolean
  memberType: string
  hasAccount: boolean
  hasPin: boolean
  email: string | null
  hasPassword: boolean
  provider: 'password' | 'oidc' | 'none'
}

export const accountApi = {
  get: () => apiGet<AccountInfo>('/api/account'),
  updateProfile: (patch: { name?: string; avatarEmoji?: string; colorHex?: string; birthday?: string | null }) =>
    apiSend<{ ok: true }>('PUT', '/api/account/profile', patch),
  changePassword: (b: { currentPassword: string; newPassword: string }) =>
    apiSend<{ ok: true }>('PUT', '/api/account/password', b),
  changeEmail: (b: { email: string; currentPassword: string }) =>
    apiSend<{ ok: true }>('PUT', '/api/account/email', b),
  // Kiosk PIN (self-service; the API route is self-or-admin). 4–8 digits.
  setPin: (personId: string, pin: string) => apiSend<{ ok: true }>('PUT', `/api/persons/${personId}/pin`, { pin }),
  removePin: (personId: string) => apiSend<{ ok: true }>('DELETE', `/api/persons/${personId}/pin`),
}

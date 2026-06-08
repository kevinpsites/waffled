// Central env-driven config. The app picks its auth strategy from what's present:
// no AUTH0_DOMAIN → local HS256 mode (self-minted dev tokens, zero external deps).
// Set AUTH0_DOMAIN → Auth0 RS256 mode (validates against Auth0's JWKS).

export type AuthMode = 'local' | 'auth0'

const auth0Domain = process.env.AUTH0_DOMAIN ?? null
const mode: AuthMode = auth0Domain ? 'auth0' : 'local'

export interface AppConfig {
  env: string
  port: number
  auth: {
    mode: AuthMode
    /** Where household_id lives on the token (Auth0 custom claims must be namespaced URIs). */
    householdClaim: string
    local: { secret: string; issuer: string; audience: string }
    auth0: { domain: string | null; audience: string | null; issuer: string | null }
  }
}

export const config: AppConfig = {
  env: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '3000', 10),

  auth: {
    mode,
    householdClaim: process.env.HOUSEHOLD_CLAIM ?? 'https://nook.app/household_id',

    // Local mode (HS256) — default until Auth0 is wired up.
    local: {
      secret: process.env.LOCAL_JWT_SECRET ?? 'nook-local-dev-secret-change-me',
      issuer: process.env.LOCAL_JWT_ISSUER ?? 'nook-local',
      audience: process.env.LOCAL_JWT_AUDIENCE ?? 'nook-api',
    },

    // Auth0 mode (RS256) — used as soon as AUTH0_DOMAIN is set.
    auth0: {
      domain: auth0Domain,
      audience: process.env.AUTH0_AUDIENCE ?? null,
      issuer: auth0Domain ? `https://${auth0Domain}/` : null,
    },
  },
}

export default config

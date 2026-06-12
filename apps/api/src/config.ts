// Central env-driven config. The app picks its auth strategy from what's present:
// no AUTH0_DOMAIN → local HS256 mode (self-minted dev tokens, zero external deps).
// Set AUTH0_DOMAIN → Auth0 RS256 mode (validates against Auth0's JWKS).

export type AuthMode = 'local' | 'auth0'

const auth0Domain = process.env.AUTH0_DOMAIN ?? null
const mode: AuthMode = auth0Domain ? 'auth0' : 'local'

/** Google OAuth + Calendar (5.2). One client serves the calendar grant; the
 *  endpoint URLs are overridable so integration tests can target a local stub. */
export interface GoogleConfig {
  clientId: string | null
  clientSecret: string | null
  redirectUri: string | null
  scopes: string
  authUrl: string
  tokenUrl: string
  userinfoUrl: string
  apiBase: string
}

export interface AppConfig {
  env: string
  port: number
  google: GoogleConfig
  /** Secrets-at-rest. tokenEncryptionKey encrypts Google refresh tokens (src/crypto.ts). */
  security: { tokenEncryptionKey: string | null }
  auth: {
    mode: AuthMode
    /** Where household_id lives on the token (Auth0 custom claims must be namespaced URIs). */
    householdClaim: string
    local: { secret: string; issuer: string; audience: string }
    auth0: {
      domain: string | null
      audience: string | null
      issuer: string | null
      jwksUri: string | null
    }
  }
}

export const config: AppConfig = {
  env: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '3000', 10),

  // Google Calendar OAuth (5.2). clientId/secret + a registered redirectUri enable
  // the "Connect your calendar" flow; it's independent of Auth0 (login). The auth/
  // token/userinfo/api URLs default to Google and are overridable for tests.
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? null,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? null,
    // Where Google sends the browser after consent. Must be registered on the OAuth
    // client. Local dev: http://localhost:8080/auth/google/calendar/callback
    redirectUri: process.env.GOOGLE_CALENDAR_REDIRECT_URI ?? null,
    // Full calendar read/write by default (covers calendarList + events + write-back).
    scopes:
      process.env.GOOGLE_CALENDAR_SCOPES ??
      'openid email https://www.googleapis.com/auth/calendar',
    authUrl: process.env.GOOGLE_AUTH_URL ?? 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: process.env.GOOGLE_TOKEN_URL ?? 'https://oauth2.googleapis.com/token',
    userinfoUrl: process.env.GOOGLE_USERINFO_URL ?? 'https://openidconnect.googleapis.com/v1/userinfo',
    apiBase: process.env.GOOGLE_CALENDAR_API_BASE ?? 'https://www.googleapis.com/calendar/v3',
  },

  security: { tokenEncryptionKey: process.env.TOKEN_ENCRYPTION_KEY ?? null },

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
    // issuer/jwksUri default off the domain but are overridable, which lets
    // integration tests point at a wiremock JWKS instead of real Auth0.
    auth0: {
      domain: auth0Domain,
      audience: process.env.AUTH0_AUDIENCE ?? null,
      issuer: process.env.AUTH0_ISSUER ?? (auth0Domain ? `https://${auth0Domain}/` : null),
      jwksUri:
        process.env.AUTH0_JWKS_URI ??
        (auth0Domain ? `https://${auth0Domain}/.well-known/jwks.json` : null),
    },
  },
}

export default config

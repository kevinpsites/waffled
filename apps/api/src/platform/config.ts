// Central env-driven config. The app picks its auth strategy from what's present:
// no AUTH0_DOMAIN → local HS256 mode (self-minted dev tokens, zero external deps).
// Set AUTH0_DOMAIN → Auth0 RS256 mode (validates against Auth0's JWKS).

import { createPrivateKey } from 'node:crypto'

export type AuthMode = 'local' | 'auth0'

const auth0Domain = process.env.AUTH0_DOMAIN ?? null
const mode: AuthMode = auth0Domain ? 'auth0' : 'local'

// A present-but-empty env var ("" — e.g. a placeholder line left in .env) must read
// as "unset" so `?? default` fallbacks actually fire. Nullish coalescing alone keeps
// "", which broke OpenAI: an empty OPENAI_BASE_URL yielded a hostless "/chat/completions"
// ("Failed to parse URL"), and an empty OPENAI_MODEL sent model:"" to the API.
const env = (name: string): string | undefined => {
  const v = process.env[name]
  return v != null && v.trim() !== '' ? v : undefined
}

const LOCAL_DEVELOPMENT_SECRET = 'waffled-local-dev-secret-change-me'

function decodeBase64(value: string): Buffer | null {
  const compact = value.trim()
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 !== 0) return null
  return Buffer.from(compact, 'base64')
}

/** Refuse to start a production API with missing, temporary, or malformed keys. */
export function assertProductionSecrets(source: NodeJS.ProcessEnv = process.env): void {
  const errors: string[] = []
  const sessionSecret = source.LOCAL_JWT_SECRET?.trim()
  if (!sessionSecret || sessionSecret === LOCAL_DEVELOPMENT_SECRET || sessionSecret.length < 32) {
    errors.push('LOCAL_JWT_SECRET must be a unique value of at least 32 characters')
  }

  const encryptionKey = source.TOKEN_ENCRYPTION_KEY
    ? decodeBase64(source.TOKEN_ENCRYPTION_KEY)
    : null
  if (!encryptionKey || encryptionKey.length !== 32) {
    errors.push('TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key')
  }

  const signingKey = source.POWERSYNC_JWT_PRIVATE_KEY?.trim()
  try {
    const pem = signingKey?.startsWith('-----BEGIN')
      ? signingKey
      : signingKey && decodeBase64(signingKey)?.toString('utf8')
    const privateKey = pem ? createPrivateKey(pem) : null
    if (!privateKey || privateKey.asymmetricKeyType !== 'rsa') throw new Error('not an RSA key')
  } catch {
    errors.push('POWERSYNC_JWT_PRIVATE_KEY must be an RSA private key (PEM or base64 PEM)')
  }

  if (errors.length > 0) {
    throw new Error(`Invalid production secrets:\n- ${errors.join('\n- ')}\nRun ./waffled up to generate missing values.`)
  }
}

if (process.env.NODE_ENV === 'production') assertProductionSecrets()

/** A capture-parsing provider is "available" only if its secret/host is in the
 *  environment. Keys live here (server-side) and are NEVER exposed to clients;
 *  the *selection* of which provider to use lives in households.settings.ai. */
export interface AiConfig {
  anthropic: { apiKey: string | null; defaultModel: string }
  openai: { apiKey: string | null; baseUrl: string; defaultModel: string }
  ollama: { host: string | null; defaultModel: string }
}

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
  ai: AiConfig
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

  // Capture-bar (6.6) LLM providers. Set any subset; the active one is chosen
  // per-household in Settings. An OpenAI-compatible OPENAI_BASE_URL lets a local
  // server (LM Studio, llama.cpp, vLLM) stand in for the hosted OpenAI API.
  ai: {
    anthropic: {
      apiKey: env('ANTHROPIC_API_KEY') ?? null,
      defaultModel: env('ANTHROPIC_MODEL') ?? 'claude-haiku-4-5-20251001',
    },
    openai: {
      apiKey: env('OPENAI_API_KEY') ?? null,
      baseUrl: env('OPENAI_BASE_URL') ?? 'https://api.openai.com/v1',
      defaultModel: env('OPENAI_MODEL') ?? 'gpt-4o-mini',
    },
    ollama: {
      host: env('OLLAMA_HOST') ?? null,
      defaultModel: env('OLLAMA_MODEL') ?? 'llama3.1',
    },
  },

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
    householdClaim: process.env.HOUSEHOLD_CLAIM ?? 'https://waffled.app/household_id',

    // Local mode (HS256) — default until Auth0 is wired up.
    local: {
      secret: process.env.LOCAL_JWT_SECRET ?? LOCAL_DEVELOPMENT_SECRET,
      issuer: process.env.LOCAL_JWT_ISSUER ?? 'waffled-local',
      audience: process.env.LOCAL_JWT_AUDIENCE ?? 'waffled-api',
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

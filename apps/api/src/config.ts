// Central env-driven config. The app picks its auth strategy from what's present:
// no AUTH0_DOMAIN → local HS256 mode (self-minted dev tokens, zero external deps).
// Set AUTH0_DOMAIN → Auth0 RS256 mode (validates against Auth0's JWKS).

export type AuthMode = 'local' | 'auth0'

const auth0Domain = process.env.AUTH0_DOMAIN ?? null
const mode: AuthMode = auth0Domain ? 'auth0' : 'local'

/** A capture-parsing provider is "available" only if its secret/host is in the
 *  environment. Keys live here (server-side) and are NEVER exposed to clients;
 *  the *selection* of which provider to use lives in households.settings.ai. */
export interface AiConfig {
  anthropic: { apiKey: string | null; defaultModel: string }
  openai: { apiKey: string | null; baseUrl: string; defaultModel: string }
  ollama: { host: string | null; defaultModel: string }
}

export interface AppConfig {
  env: string
  port: number
  ai: AiConfig
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
      apiKey: process.env.ANTHROPIC_API_KEY ?? null,
      defaultModel: process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001',
    },
    openai: {
      apiKey: process.env.OPENAI_API_KEY ?? null,
      baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
      defaultModel: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
    },
    ollama: {
      host: process.env.OLLAMA_HOST ?? null,
      defaultModel: process.env.OLLAMA_MODEL ?? 'llama3.1',
    },
  },

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

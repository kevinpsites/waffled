// Capture-bar parsing client (roadmap 6.6). Talks to the server's pluggable LLM
// endpoint, and transparently falls back to the on-device heuristic parser when
// the server defers (provider = heuristic), errors, or we're offline.
import { apiSend, apiGet, ApiSendError } from './client'
import { parseCapture, type ParsedIntent, type MutateVerb, type MutateTargetKind } from '../capture/parse'

export type Provider = 'anthropic' | 'openai' | 'ollama' | 'heuristic'

// TIER 2 — a resolved candidate row for a mutate intent (from POST /api/capture/resolve).
// `id` is the row to act on; `meta` carries verb/kind extras the commit needs (e.g.
// { occurrenceStart } for a recurring event, { seriesScopeOnly:true }).
export interface Candidate {
  id: string
  title: string
  subtitle?: string
  confidence: number
  meta?: Record<string, unknown>
}

// The unresolved mutate intent shape the resolve endpoint echoes back.
export interface MutateIntent {
  verb: MutateVerb
  targetKind: MutateTargetKind | null
  target: { description: string }
  args?: Record<string, unknown>
}

// The chosen mutation to apply (POST /api/capture/commit).
export interface MutateCommand {
  verb: MutateVerb
  targetKind: MutateTargetKind | null
  targetId: string
  args: Record<string, unknown>
  meta?: Record<string, unknown>
}

export interface CaptureConfig {
  provider: Provider
  model: string | null
  available: Record<Provider, boolean>
  defaultModels: { anthropic: string; openai: string; ollama: string }
}

interface ServerParse {
  intent: ParsedIntent | null
  via: Provider
  fallback: boolean
}

export const captureApi = {
  // Returns the parsed intent and which provider produced it. `via` is 'on-device'
  // whenever we used the local heuristic (server deferral, error, or offline).
  resolve: async (text: string, names: string[], lists: string[] = []): Promise<{ intent: ParsedIntent | null; via: string }> => {
    const local = () => ({ intent: parseCapture(text, names, new Date(), lists), via: 'on-device' })
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return local()
    try {
      const r = await apiSend<ServerParse>('POST', '/api/capture', { text })
      if (r.fallback || !r.intent) return local()
      return { intent: r.intent, via: r.via }
    } catch {
      return local()
    }
  },
  // TIER 2 — turn a server-parsed mutate intent into candidate rows to pick from.
  // Returns the ranked candidates plus an optional `disabledReason` (a 200 with 0
  // candidates when the target module is turned off, so the preview can say so).
  resolveCandidates: (intent: MutateIntent): Promise<{ candidates: Candidate[]; disabledReason?: string }> =>
    apiSend('POST', '/api/capture/resolve', {
      verb: intent.verb,
      targetKind: intent.targetKind,
      target: intent.target,
      args: intent.args ?? {},
    }),
  // Apply the chosen mutation. On a 4xx the server sends `{ error, message }`; we rethrow
  // an Error carrying that human message so the preview can flash it verbatim.
  commitMutate: async (cmd: MutateCommand): Promise<{ ok: true; message: string }> => {
    try {
      return await apiSend<{ ok: true; message: string }>('POST', '/api/capture/commit', cmd)
    } catch (e) {
      if (e instanceof ApiSendError) throw new Error(e.body.message ?? e.body.error ?? 'Couldn’t do that.')
      throw e
    }
  },
  getConfig: () => apiGet<CaptureConfig>('/api/capture/config'),
  setConfig: (provider: Provider, model: string | null) =>
    apiSend<{ provider: Provider; model: string | null }>('PUT', '/api/capture/config', { provider, model }),
  // Preload the model (fire-and-forget) so the first parse isn't a cold start.
  warm: () => apiSend('POST', '/api/capture/warm', {}).catch(() => undefined),
}

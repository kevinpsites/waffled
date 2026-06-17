// Capture-bar parsing client (roadmap 6.6). Talks to the server's pluggable LLM
// endpoint, and transparently falls back to the on-device heuristic parser when
// the server defers (provider = heuristic), errors, or we're offline.
import { apiSend, apiGet } from './client'
import { parseCapture, type ParsedIntent } from '../capture/parse'

export type Provider = 'anthropic' | 'openai' | 'ollama' | 'heuristic'

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
  getConfig: () => apiGet<CaptureConfig>('/api/capture/config'),
  setConfig: (provider: Provider, model: string | null) =>
    apiSend<{ provider: Provider; model: string | null }>('PUT', '/api/capture/config', { provider, model }),
  // Preload the model (fire-and-forget) so the first parse isn't a cold start.
  warm: () => apiSend('POST', '/api/capture/warm', {}).catch(() => undefined),
}

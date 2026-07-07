// Shared LLM provider layer. One place that knows how to call the household's
// chosen model (Anthropic / OpenAI-compatible / Ollama) and get back a JSON object
// matching a schema. Credentials live only in the env (config.ai); the *active
// provider + model* is per-household (households.settings.ai), flipped in Settings.
// Every AI feature (capture parsing, plan-my-week, suggestion cards, …) builds on
// completeJson so they all honor the same toggle and keys.
import config from './config'
import { query } from './db'
import { log } from './logger'

export type Provider = 'anthropic' | 'openai' | 'ollama' | 'heuristic'
export const PROVIDERS: Provider[] = ['anthropic', 'openai', 'ollama', 'heuristic']

// Generous timeout — a local model may cold-load on the first call.
const TIMEOUT_MS = parseInt(process.env.AI_TIMEOUT_MS ?? process.env.CAPTURE_TIMEOUT_MS ?? '30000', 10)

// Which providers the environment makes usable (safe to expose; never the keys).
export function availability() {
  return {
    anthropic: !!config.ai.anthropic.apiKey,
    openai: !!config.ai.openai.apiKey,
    ollama: !!config.ai.ollama.host,
    heuristic: true,
  }
}

export function defaultModel(p: Provider): string | null {
  if (p === 'anthropic') return config.ai.anthropic.defaultModel
  if (p === 'openai') return config.ai.openai.defaultModel
  if (p === 'ollama') return config.ai.ollama.defaultModel
  return null
}

// ── Per-household selection (households.settings.ai) ─────────────────────────
export async function getAiConfig(householdId: string): Promise<{ provider: Provider; model: string | null }> {
  const { rows } = await query<{ settings: { ai?: { provider?: string; model?: string | null } } | null }>(
    `select settings from households where id = $1`,
    [householdId]
  )
  const ai = rows[0]?.settings?.ai
  const provider = (PROVIDERS as string[]).includes(ai?.provider ?? '') ? (ai!.provider as Provider) : 'heuristic'
  // A stored empty/blank model (e.g. persisted by an earlier build that resolved the
  // default to "") must fall back to the provider default, not stay "".
  const stored = ai?.model?.trim()
  const model = stored ? stored : defaultModel(provider)
  return { provider, model }
}

export async function setAiConfig(householdId: string, provider: Provider, model: string | null): Promise<void> {
  // Merge into the existing settings jsonb so other keys are preserved.
  await query(
    `update households
        set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('ai', jsonb_build_object('provider', $2::text, 'model', $3::text))
      where id = $1`,
    [householdId, provider, model]
  )
}

// ── Generic JSON completion across providers ─────────────────────────────────
async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal })
    if (!res.ok) throw new Error(`${url} -> ${res.status} ${await res.text().catch(() => '')}`)
    return res.json()
  } finally {
    clearTimeout(timer)
  }
}

export interface LlmJsonRequest {
  system: string
  user: string
  schema: object // JSON schema the response must match
  schemaName?: string
  maxTokens?: number
  // Per-call timeout. Heavier tasks (multi-item drafts on a local model) need
  // more than the default; defaults to AI_TIMEOUT_MS / 30s.
  timeoutMs?: number
}

async function anthropicJson(req: LlmJsonRequest, model: string): Promise<unknown> {
  const name = req.schemaName ?? 'respond'
  const data = (await fetchJson('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.ai.anthropic.apiKey ?? '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: req.maxTokens ?? 1024,
      temperature: 0,
      system: req.system,
      tools: [{ name, description: 'Structured response', input_schema: req.schema }],
      tool_choice: { type: 'tool', name },
      messages: [{ role: 'user', content: req.user }],
    }),
  }, req.timeoutMs ?? TIMEOUT_MS)) as { content?: Array<{ type: string; input?: unknown }> }
  const tool = data.content?.find((c) => c.type === 'tool_use')
  if (!tool?.input) throw new Error('anthropic: no tool_use in response')
  return tool.input
}

// OpenAI's strict Structured Outputs require EVERY object to set
// additionalProperties:false and list ALL properties in `required`. Our shared
// schemas already mark optional fields nullable (type:[...,'null']), so forcing
// them required is safe — the model emits null. We transform here, in the adapter,
// so the shared schemas stay provider-agnostic (Ollama/Anthropic never see this).
export function toStrictSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toStrictSchema)
  if (!node || typeof node !== 'object') return node
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = toStrictSchema(v)
  // A schema object is one with `properties`; pin it closed and mark every key required.
  if (out.properties && typeof out.properties === 'object') {
    out.additionalProperties = false
    out.required = Object.keys(out.properties as Record<string, unknown>)
  }
  return out
}

// OpenAI via the Responses API (the successor to Chat Completions) with strict
// Structured Outputs — the model is forced to return schema-valid JSON, so callers
// don't have to defensively re-shape it. Response text lives in output[].content[]
// (type 'output_text'); a strict-mode refusal comes back as a 'refusal' part.
async function openaiJson(req: LlmJsonRequest, model: string): Promise<unknown> {
  const data = (await fetchJson(`${config.ai.openai.baseUrl.replace(/\/$/, '')}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.ai.openai.apiKey ?? ''}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      instructions: req.system,
      input: req.user,
      max_output_tokens: req.maxTokens,
      text: {
        format: { type: 'json_schema', name: req.schemaName ?? 'response', strict: true, schema: toStrictSchema(req.schema) },
      },
    }),
  }, req.timeoutMs ?? TIMEOUT_MS)) as {
    output?: Array<{ type: string; content?: Array<{ type: string; text?: string; refusal?: string }> }>
  }
  const message = data.output?.find((o) => o.type === 'message')
  const refusal = message?.content?.find((c) => c.type === 'refusal')?.refusal
  if (refusal) throw new Error(`openai refused: ${refusal}`)
  const text = message?.content?.find((c) => c.type === 'output_text')?.text
  if (!text) throw new Error('openai: no output_text in response')
  return JSON.parse(text)
}

async function ollamaJson(req: LlmJsonRequest, model: string): Promise<unknown> {
  const host = (config.ai.ollama.host ?? '').replace(/\/$/, '')
  const data = (await fetchJson(`${host}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      format: req.schema,
      keep_alive: '30m',
      options: { temperature: 0 },
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
    }),
  }, req.timeoutMs ?? TIMEOUT_MS)) as { message?: { content?: string } }
  const content = data.message?.content
  if (!content) throw new Error('ollama: empty response')
  return JSON.parse(content)
}

// Ask the household's chosen model for a JSON object matching req.schema. Throws if
// no provider is selected (heuristic) or its credentials are missing — callers
// surface that as "pick a provider in Settings".
export async function completeJson(householdId: string, req: LlmJsonRequest): Promise<{ data: unknown; via: Provider }> {
  const { provider, model } = await getAiConfig(householdId)
  if (provider === 'heuristic') throw new Error('No AI provider selected — choose one in Settings → AI & capture')
  if (!availability()[provider]) throw new Error(`provider ${provider} is not configured on the server`)
  const m = model ?? defaultModel(provider) ?? ''
  // One place that logs every AI call outcome. Failures below are almost always
  // swallowed by callers (capture/meals return 200+fallback), so without this the
  // real reason — the provider's status + body, carried in the thrown message —
  // never reaches the logs. warn passes the default LOG_LEVEL=info threshold;
  // the success line is debug so it's silent unless you opt in.
  const startedAt = Date.now()
  try {
    const data =
      provider === 'anthropic'
        ? await anthropicJson(req, m)
        : provider === 'openai'
          ? await openaiJson(req, m)
          : await ollamaJson(req, m)
    log.debug('ai.complete ok', { provider, model: m, schema: req.schemaName, durationMs: Date.now() - startedAt })
    return { data, via: provider }
  } catch (err) {
    log.warn('ai.complete failed', { provider, model: m, schema: req.schemaName, durationMs: Date.now() - startedAt, err })
    throw err
  }
}

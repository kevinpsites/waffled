// The MCP tool registry. Each tool declares the one API scope it needs, so scope lives on
// the tool instead of a path prefix (docs/product/mcp-plan.md §3). `denialFor` is the single
// visibility rule: tools/list filters by it and tools/call re-checks it, so the two cannot
// drift. A scope that is not a real catalog string fails closed even for a full-rights user.
import { ALL_SCOPES, keyHasScope } from '../api-keys/api-keys'
import { moduleEnabled, type ModuleKey } from '../../platform/modules'
import type { Tenant } from '../households/households'

export interface ToolAnnotations {
  title?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

export interface ToolDef {
  name: string
  description: string
  scope: string
  module?: ModuleKey
  annotations?: ToolAnnotations
  inputSchema: { type: 'object'; properties?: Record<string, unknown>; required?: string[]; [k: string]: unknown }
  run: (tenant: Tenant, args: Record<string, unknown>) => Promise<unknown>
}

// A bad argument the caller can fix. tools/call reports it as an `isError` result, which
// the MCP spec reserves for errors the model should see and correct.
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolInputError'
  }
}

// `null` = a user session, which carries the person's full rights; a key's scopes otherwise.
export type CallerScopes = string[] | null

export interface ToolContext {
  scopes: CallerScopes
  householdSettings: unknown
}

const tools = new Map<string, ToolDef>()

export function defineTool(def: ToolDef): ToolDef {
  if (tools.has(def.name)) throw new Error(`MCP tool "${def.name}" is defined twice`)
  tools.set(def.name, def)
  return def
}

export function toolRegistry(): ToolDef[] {
  return [...tools.values()]
}

export function findTool(name: string): ToolDef | undefined {
  return tools.get(name)
}

export function unregisterToolForTest(name: string): void {
  tools.delete(name)
}

// The reason a caller may not use a tool, or null when it may.
export function denialFor(tool: ToolDef, ctx: ToolContext): string | null {
  if (!ALL_SCOPES.includes(tool.scope)) return `Tool ${tool.name} declares no valid scope`
  if (ctx.scopes !== null && !keyHasScope(ctx.scopes, tool.scope)) {
    return `API key is missing the required scope: ${tool.scope}`
  }
  if (tool.module && !moduleEnabled(ctx.householdSettings, tool.module)) {
    return `The ${tool.module} module is not enabled`
  }
  return null
}

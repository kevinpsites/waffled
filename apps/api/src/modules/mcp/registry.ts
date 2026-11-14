// The MCP tool registry. Each tool declares the one API scope it needs, so scope lives on
// the tool instead of a path prefix (docs/product/mcp-plan.md §3). `canUse` is the single
// visibility rule: tools/list filters by it and tools/call re-checks it, so the two cannot
// drift. A scope that is not a real catalog string fails closed even for a full-rights user.
import { ALL_SCOPES, keyHasScope } from '../api-keys/api-keys'
import { moduleEnabled, rewardsEnabled, type ModuleKey } from '../../platform/modules'
import type { Tenant } from '../households/households'

export interface ToolAnnotations {
  title?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

// What a tool hands back: `data` becomes structuredContent (and its JSON the first text
// block), `summary` a one-line rendering. `createdId` names a row a write created, so the
// audit can point at it.
export interface ToolOutput {
  data: Record<string, unknown>
  summary: string
  createdId?: string
}

export interface ToolDef {
  name: string
  description: string
  scope: string
  // 'rewards' is not a module of its own: it is the chores module's rewards sub-toggle.
  module?: ModuleKey | 'rewards'
  annotations?: ToolAnnotations
  inputSchema: { type: 'object'; properties?: Record<string, unknown>; required?: string[]; [k: string]: unknown }
  run: (tenant: Tenant, args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutput>
}

// A write tool changes household data; tools/call audits every call to one.
export function isWriteTool(tool: ToolDef): boolean {
  return tool.scope.endsWith(':write')
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
  timezone: string
}

// Does the caller's grant cover `scope`? A user session (null) covers everything.
export function callerHas(ctx: ToolContext, scope: string): boolean {
  return ctx.scopes === null || keyHasScope(ctx.scopes, scope)
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
  if (tool.module === 'rewards') {
    if (!rewardsEnabled(ctx.householdSettings)) return 'Rewards are turned off'
  } else if (tool.module && !moduleEnabled(ctx.householdSettings, tool.module)) {
    return `The ${tool.module} module is not enabled`
  }
  return null
}

export function canUse(tool: ToolDef, ctx: ToolContext): boolean {
  return denialFor(tool, ctx) === null
}

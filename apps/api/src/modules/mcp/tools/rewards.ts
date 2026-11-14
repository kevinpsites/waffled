import { balancesSummary } from '../../rewards/rewards'
import { defineTool } from '../registry'
import { READ } from './shared'

defineTool({
  name: 'get_reward_balances',
  description: "Each family member's reward balance in every currency the household uses (stars by default).",
  scope: 'rewards:read',
  module: 'rewards',
  annotations: { title: 'Get reward balances', ...READ },
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  run: async (tenant) => {
    const summary = await balancesSummary(tenant.householdId)
    const people = summary.people.map((p) => ({ personId: p.personId, name: p.name, balances: p.balances }))
    return {
      data: { currencies: summary.currencies.map((c) => c.key), people },
      summary: people.map((p) => `${p.name}: ${p.balances.map((b) => `${b.balance} ${b.currency}`).join(', ')}`).join('; '),
    }
  },
})

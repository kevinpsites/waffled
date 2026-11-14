import { getContext } from '../../households/households'
import { defineTool } from '../registry'

defineTool({
  name: 'whoami',
  description:
    'Who this connection acts as: the household and the family member signed in, with their role. Call it first to learn whose data the other tools return.',
  scope: 'family:read',
  annotations: { title: 'Who am I', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  run: async (tenant) => {
    const { household, person } = await getContext(tenant)
    return {
      data: {
        household: { id: household.id, name: household.name },
        person: { id: person.id, name: person.name, memberType: person.member_type, isAdmin: person.is_admin },
      },
      summary: `Signed in as ${person.name} in ${household.name}.`,
    }
  },
})

import { getContext } from '../../households/households'
import { listPersons } from '../../persons/persons'
import { defineTool } from '../registry'
import { DATA_NOTE, READ } from './shared'

defineTool({
  name: 'whoami',
  description:
    'Who this connection acts as: the household and the family member signed in, with their role. Call it first to learn whose data the other tools return.' + DATA_NOTE,
  scope: 'family:read',
  annotations: { title: 'Who am I', ...READ },
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

defineTool({
  name: 'list_family',
  description:
    'The household members with their ids, role (adult, teen, kid) and any dietary notes or allergens. Other tools take these ids as personId.' + DATA_NOTE,
  scope: 'family:read',
  annotations: { title: 'List family members', ...READ },
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  run: async (tenant) => {
    // Deliberately no account emails or sign-in details: members only.
    const items = (await listPersons(tenant.householdId)).map((p) => ({
      id: p.id,
      name: p.name,
      memberType: p.member_type,
      isAdmin: p.is_admin,
      birthday: p.birthday ?? null,
      dietaryNotes: p.dietary_notes ?? null,
      allergens: p.allergens ?? [],
    }))
    return { data: { items }, summary: items.map((p) => `${p.name} (${p.memberType})`).join(', ') }
  },
})

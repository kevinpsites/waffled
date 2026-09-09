// Weekly Planning · step 8 (Tasks) — this step's API client and its types.
//
// The board is a read; handing a chore out is a write to the CHORES module, because that
// is where a chore lives. `handOut` composes two existing chores endpoints, which is why
// this step stores nothing of its own.
import { apiGet } from '../client'
import { choresApi } from '../chores'

export type PlanningChoreCadence = 'daily' | 'weekly' | 'once'

export interface PlanningTasksChore {
  id: string
  title: string
  emoji: string | null
  rrule: string | null
  cadence: PlanningChoreCadence
  // Days inside the planned week (YYYY-MM-DD), computed by the server from the same rule
  // the chores module materializes by. Empty ⇒ no day in the week (see dueOn/carriedOver).
  days: string[]
  // A one-off's own date, which may sit outside the planned week. null for recurring.
  dueOn: string | null
  dueTime: string | null
  carriedOver: boolean
  rewardAmount: number
  rewardCurrency: string | null
  // Not drawn on the card, but carried so the chore editor prefills honestly — ChoreModal
  // reads a missing flag as false, which would switch approval off on the next typo fix.
  requiresApproval: boolean
  requiresPhoto: boolean
  // Every still-open day of this chore already on a board. PATCHing the definition alone
  // only reaches days from today forward, so `handOut` moves all of these too, in BOTH
  // directions — see `pendingInstanceIds` in apps/api/.../weeklyPlanning/steps/tasks.ts.
  pendingInstanceIds: string[]
}

export interface PlanningTasksPerson {
  id: string
  name: string
  avatarEmoji: string | null
  colorHex: string | null
  memberType: string
  isAdmin: boolean
  recurringChores: number
  // Server-owned, so the column is the week rather than a log of this sitting.
  chores: PlanningTasksChore[]
}

export interface PlanningTasksBoard {
  weekStart: string
  // Server-owned, so adding a task on a Wednesday while planning next week can't quietly
  // date it to that Wednesday.
  newTaskDay: string
  people: PlanningTasksPerson[]
  unassigned: PlanningTasksChore[]
}

export const planningTasksApi = {
  // `weekStart` is the one the session view handed us — passed back, never computed.
  board: (weekStart?: string) =>
    apiGet<PlanningTasksBoard>(`/api/weekly-planning/tasks${weekStart ? `?weekStart=${weekStart}` : ''}`),

  // Move a chore: to `personId`, or back up for grabs when that's null — the same call both
  // ways, because handing a chore over has to be undoable. It writes the definition AND
  // every open day already on a board; moving only some would leave the kiosk Chores
  // screen disagreeing about who has it. Both are the chores module's own endpoints.
  async handOut(chore: PlanningTasksChore, personId: string | null): Promise<void> {
    await choresApi.updateChore(chore.id, { personId })
    for (const instanceId of chore.pendingInstanceIds) {
      await choresApi.assignInstance(instanceId, personId)
    }
  },

  // Say which day a one-off lands on. `dueOn` is a chore PATCH like any other; the chores
  // module moves the day's instance with it. Recurring chores ignore it — their days come
  // from the rrule, which belongs to the chore editor, not to a chip on a board.
}
